import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');
const DUMP_FILE = path.join(__dirname, '../data/anilist_dump.json');
const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');
const ANIPM_FILE = path.join(__dirname, '../data/anipmbeta_library.json');

const BASE = 'https://www.animegg.org';
const ANILIST_URL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function cleanTitle(t) {
  if (!t) return '';
  return decodeEntities(t)
    .replace(/\s*-\s*movie\b/gi, '')
    .replace(/\s*\((tv|movie|ova|ona|special|dub|sub)\)/gi, '')
    .replace(/\s*\[(tv|movie|ova|ona|special|dub|sub)\]/gi, '')
    .replace(/\s*\b(dubbed|subbed|dub|sub)\b/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTitleVariants(raw) {
  if (!raw) return [];
  const decoded = decodeEntities(raw);
  const variants = new Set();

  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Direct clean
  const base = clean(decoded);
  if (base.length >= 2) variants.add(base);

  // 2. Without parentheses: "Flame of Recca (Rekka no Honoo)" -> "Flame of Recca"
  const noParen = clean(decoded.replace(/\s*\([^)]*\)/g, ' '));
  if (noParen.length >= 2) variants.add(noParen);

  // 3. Inside parentheses: "Flame of Recca (Rekka no Honoo)" -> "Rekka no Honoo"
  const parenMatches = decoded.match(/\(([^)]+)\)/g);
  if (parenMatches) {
    for (const m of parenMatches) {
      const inner = clean(m.replace(/[()]/g, ' '));
      if (inner.length >= 2) variants.add(inner);
    }
  }

  // 4. Roman numerals & season suffixes
  for (const v of Array.from(variants)) {
    if (v.startsWith('the ')) variants.add(v.slice(4).trim());
    if (v.startsWith('mobile suit ')) variants.add(v.slice(12).trim());
    if (v.startsWith('gundam ')) variants.add(('mobile suit ' + v).trim());
    // season 2 / 2nd season
    variants.add(v.replace(/\bseason\s*(\d+)\b/g, '$1'));
    variants.add(v.replace(/\b(\d+)(st|nd|rd|th)\s*season\b/g, 'season $1'));
  }

  return Array.from(variants).filter(x => x.length >= 2);
}

function stringSimilarity(n1, n2) {
  if (n1 === n2) return 1.0;
  if (!n1 || !n2) return 0;
  if (n1.length < 2 || n2.length < 2) return 0;

  const getBigrams = str => {
    const bigrams = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(n1);
  const b2 = getBigrams(n2);
  let intersection = 0;
  for (const [k, count1] of b1.entries()) {
    if (b2.has(k)) intersection += Math.min(count1, b2.get(k));
  }

  const total = (n1.length - 1) + (n2.length - 1);
  return (2 * intersection) / total;
}

async function fetchHtml(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': BASE,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
    }
  }
}

function saveDatabase(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/**
 * 1. Expand AniList Dump using multiple sorts
 */
async function expandAniListDump() {
  console.log(`\n=== [STAGE 1] Expanding AniList Dump ===`);
  let dump = [];
  const seenIds = new Set();

  if (fs.existsSync(DUMP_FILE)) {
    try {
      dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));
      for (const m of dump) seenIds.add(m.id);
      console.log(`Loaded ${dump.length} existing anime from AniList dump.`);
    } catch {}
  }

  const query = `
    query ($page: Int, $sort: [MediaSort]) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        media(type: ANIME, sort: $sort) {
          id
          idMal
          title { romaji english native }
          synonyms
        }
      }
    }
  `;

  // We query 3 diverse sorts up to page 70 each
  const sorts = ['START_DATE_DESC', 'TITLE_ROMAJI', 'FAVOURITES_DESC'];

  for (const sortName of sorts) {
    console.log(`\nFetching AniList with sort: ${sortName}...`);
    for (let page = 1; page <= 70; page++) {
      process.stdout.write(`  [${sortName}] Page ${page}/70... `);
      try {
        const res = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query, variables: { page, sort: [sortName] } })
        });
        if (!res.ok) {
          console.log(`HTTP ${res.status}`);
          if (res.status === 429) {
            console.log('Rate limit hit, sleep 60s...');
            await sleep(60000);
            page--;
            continue;
          }
          break;
        }
        const data = await res.json();
        const list = data.data?.Page?.media || [];
        let added = 0;
        for (const m of list) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            dump.push(m);
            added++;
          }
        }
        console.log(`+${added} new (Total unique: ${dump.length})`);
        if (!data.data?.Page?.pageInfo?.hasNextPage) break;
        await sleep(700);
      } catch (err) {
        console.log(`ERR: ${err.message}`);
        await sleep(2000);
      }
    }
  }

  fs.writeFileSync(DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');
  console.log(`[STAGE 1 DONE] AniList dump expanded to ${dump.length} unique anime!`);
  return dump;
}

/**
 * 2. Master Map Catalog
 */
async function mapCatalog(anilistDump) {
  console.log(`\n=== [STAGE 2] Master Mapping Remaining AnimeGG Titles ===`);
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));

  const lookup = new Map();
  const byFirstLetter = new Map();

  function addIndex(titleStr, id, mal) {
    if (!titleStr) return;
    const variants = getTitleVariants(titleStr);
    for (const v of variants) {
      if (!lookup.has(v)) lookup.set(v, { id, mal });

      const fl = v[0];
      if (!byFirstLetter.has(fl)) byFirstLetter.set(fl, []);
      byFirstLetter.get(fl).push({ title: v, id, mal });
    }
  }

  // 1. Index AniList dump
  for (const m of anilistDump) {
    if (m.title?.romaji) addIndex(m.title.romaji, m.id, m.idMal);
    if (m.title?.english) addIndex(m.title.english, m.id, m.idMal);
    if (m.title?.native) addIndex(m.title.native, m.id, m.idMal);
    if (Array.isArray(m.synonyms)) {
      for (const syn of m.synonyms) addIndex(syn, m.id, m.idMal);
    }
  }

  // 2. Index AniPM library if exists
  if (fs.existsSync(ANIPM_FILE)) {
    try {
      const anipm = JSON.parse(fs.readFileSync(ANIPM_FILE, 'utf8'));
      console.log(`Indexing AniPM Library (${anipm.length} items)...`);
      for (const a of anipm) {
        if (!a.anilist_id) continue;
        if (a.title) addIndex(a.title, a.anilist_id, a.mal_id);
        if (a.english_title) addIndex(a.english_title, a.anilist_id, a.mal_id);
        if (a.japanese_title) addIndex(a.japanese_title, a.anilist_id, a.mal_id);
        if (Array.isArray(a.synonyms)) {
          for (const s of a.synonyms) addIndex(s, a.anilist_id, a.mal_id);
        }
      }
    } catch {}
  }

  // 3. Index Anikoto database if exists
  if (fs.existsSync(ANIKOTO_FILE)) {
    try {
      const anikoto = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
      const anikotoItems = Object.values(anikoto.by_slug || {});
      console.log(`Indexing Anikoto Database (${anikotoItems.length} items)...`);
      for (const a of anikotoItems) {
        if (!a.anilist_id) continue;
        if (a.title) addIndex(a.title, a.anilist_id, a.mal_id);
        if (a.slug) addIndex(a.slug.replace(/-/g, ' '), a.anilist_id, a.mal_id);
      }
    } catch {}
  }

  console.log(`[INDEX] Fast search index built with ${lookup.size} unique title keys.`);

  let newMatches = 0;

  for (const anime of catalog) {
    if (anime.anilist_id) continue;

    const tVariants = getTitleVariants(anime.title);
    const sVariants = getTitleVariants(anime.slug.replace(/-/g, ' '));
    const allVariants = [...tVariants, ...sVariants];

    // Step A: Exact Variant match
    let match = null;
    for (const v of allVariants) {
      if (lookup.has(v)) {
        match = lookup.get(v);
        break;
      }
    }

    if (match) {
      anime.anilist_id = match.id;
      anime.mal_id = match.mal || anime.mal_id || null;
      newMatches++;
      continue;
    }

    // Step B: Fuzzy match against same first-letter entries
    const primaryClean = tVariants[0] || '';
    if (primaryClean.length >= 3) {
      const fl = primaryClean[0];
      const candidates = byFirstLetter.get(fl) || [];
      let bestScore = 0;
      let bestMatch = null;

      for (const cand of candidates) {
        const sim = stringSimilarity(primaryClean, cand.title);
        if (sim > bestScore && sim >= 0.80) {
          bestScore = sim;
          bestMatch = cand;
        }
      }

      if (bestMatch) {
        anime.anilist_id = bestMatch.id;
        anime.mal_id = bestMatch.mal || anime.mal_id || null;
        newMatches++;
      }
    }
  }

  const totalMapped = catalog.filter(a => a.anilist_id).length;
  console.log(`[STAGE 2] Newly Mapped: ${newMatches}`);
  console.log(`[STAGE 2] Total Mapped in Catalog: ${totalMapped} / ${catalog.length}`);

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  return catalog;
}

/**
 * 3. Index Episodes into AnimeGG Database
 */
async function indexRemaining(catalog) {
  console.log(`\n=== [STAGE 3] Indexing Episodes & Syncing Database ===`);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.by_slug = db.by_slug || {};
  db.by_anilist = db.by_anilist || {};
  db.by_mal = db.by_mal || {};

  // First sync existing catalog mappings into db.by_slug and db.by_anilist
  for (const item of catalog) {
    if (db.by_slug[item.slug]) {
      const entry = db.by_slug[item.slug];
      if (item.anilist_id) entry.anilist_id = item.anilist_id;
      if (item.mal_id) entry.mal_id = item.mal_id;

      if (entry.anilist_id) {
        const aid = String(entry.anilist_id);
        const existing = db.by_anilist[aid];
        if (!existing || (!entry.slug.includes('-dub') && existing.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (existing.episode_list?.length || 0))) {
          db.by_anilist[aid] = entry;
        }
      }
      if (entry.mal_id) {
        const mid = String(entry.mal_id);
        const existingMal = db.by_mal[mid];
        if (!existingMal || (!entry.slug.includes('-dub') && existingMal.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (existingMal.episode_list?.length || 0))) {
          db.by_mal[mid] = entry;
        }
      }
    }
  }

  // Targets are all catalog items that are mapped to AniList, but either not in DB or have no episode_list
  const targets = catalog.filter(a => a.anilist_id && (!db.by_slug[a.slug]?.episode_list?.length));

  console.log(`Total Mapped Anime in Catalog: ${catalog.filter(a => a.anilist_id).length}`);
  console.log(`Targets to fetch episode lists for: ${targets.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 10;

  async function worker(workerId) {
    while (currentIndex < targets.length) {
      const idx = currentIndex++;
      const item = targets[idx];
      const t0 = Date.now();

      try {
        const html = await fetchHtml(`${BASE}/series/${item.slug}`);
        const episodes = [];

        for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
          const block = m[1];
          if (!block.includes('anm_det_pop')) continue;
          const hrefMatch = block.match(/href=["']\/([^"'#]+)/i);
          const subMatch = block.includes('subbed') || block.includes('Sub');
          const dubMatch = block.includes('dubbed') || block.includes('Dub');

          if (hrefMatch) {
            const slugNum = hrefMatch[1].match(/-episode-(\d+)$/i)?.[1] || hrefMatch[1].match(/(\d+)$/)?.[1];
            const epNum = slugNum ? parseInt(slugNum, 10) : null;
            if (epNum) {
              episodes.push({
                number: epNum,
                slug: hrefMatch[1],
                title: `Episode ${epNum}`,
                hasSub: subMatch || !dubMatch,
                hasDub: dubMatch
              });
            }
          }
        }

        episodes.sort((a, b) => a.number - b.number);
        const seen = new Set();
        const cleanEps = episodes.filter(e => seen.has(e.number) ? false : (seen.add(e.number), true));

        const existing = db.by_slug[item.slug];
        const animeEntry = existing || {
          slug: item.slug,
          title: item.title,
          anilist_id: item.anilist_id,
          mal_id: item.mal_id || null,
          total_episodes: cleanEps.length,
          image: item.image,
          episode_list: [],
          episodes: {}
        };

        animeEntry.total_episodes = cleanEps.length;
        animeEntry.episode_list = cleanEps;
        animeEntry.anilist_id = item.anilist_id;
        animeEntry.mal_id = item.mal_id || animeEntry.mal_id || null;

        db.by_slug[item.slug] = animeEntry;

        const aid = String(item.anilist_id);
        const existingAni = db.by_anilist[aid];
        if (!existingAni || (!animeEntry.slug.includes('-dub') && existingAni.slug.includes('-dub')) || (cleanEps.length > (existingAni.episode_list?.length || 0))) {
          db.by_anilist[aid] = animeEntry;
        }

        if (item.mal_id) {
          const mid = String(item.mal_id);
          const existingMal = db.by_mal[mid];
          if (!existingMal || (!animeEntry.slug.includes('-dub') && existingMal.slug.includes('-dub')) || (cleanEps.length > (existingMal.episode_list?.length || 0))) {
            db.by_mal[mid] = animeEntry;
          }
        }

        savedCount++;
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> OK (${cleanEps.length} eps, ${Date.now() - t0}ms)`);

        if (savedCount % 50 === 0) {
          saveDatabase(db);
          console.log(`  💾 [CHECKPOINT] Saved ${Object.keys(db.by_slug).length} anime in DB (${Object.keys(db.by_anilist).length} AniList mapped)`);
        }

        await sleep(150);
      } catch (err) {
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> ERR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  saveDatabase(db);

  console.log(`\n🎉 [ALL DONE] AnimeGG Database Sync Complete!`);
  console.log(`  - Total in DB by_slug: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Total AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Total MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
}

async function main() {
  console.log(`=======================================================`);
  console.log(`   AnimeGG 10,000+ AniList Mapping Final Pipeline      `);
  console.log(`=======================================================`);

  const anilistDump = await expandAniListDump();
  const catalog = await mapCatalog(anilistDump);
  await indexRemaining(catalog);

  console.log(`\n🔥 ALL TASKS FINISHED SUCCESSFULLY!`);
}

main().catch(console.error);
