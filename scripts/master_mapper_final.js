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

function norm(s) {
  if (!s) return '';
  return decodeEntities(s)
    .toLowerCase()
    .replace(/-(dubbed|subbed|dub|sub)$/i, '')
    .replace(/\b(dubbed|subbed|dub|sub)\b/gi, '')
    .replace(/\b(kidou senshi|mobile suit|shin|gekijouban|the movie|movie|the series|series|tv)\b/gi, ' ')
    .replace(/\b(1st|2nd|3rd|4th|5th)\s*season\b/gi, (m, p) => p.replace(/\D/g, ''))
    .replace(/\bseason\s*(\d+)\b/gi, '$1')
    .replace(/\bsecond season\b/gi, '2')
    .replace(/\bthird season\b/gi, '3')
    .replace(/\bfourth season\b/gi, '4')
    .replace(/[ζz]eta/gi, 'zeta')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getVariants(raw) {
  if (!raw) return [];
  const decoded = decodeEntities(raw);
  const variants = new Set();

  const base = norm(decoded);
  if (base.length >= 2) variants.add(base);

  // without parentheses
  const noParen = norm(decoded.replace(/\s*\([^)]*\)/g, ' '));
  if (noParen.length >= 2) variants.add(noParen);

  // inside parentheses
  const parenMatches = decoded.match(/\(([^)]+)\)/g);
  if (parenMatches) {
    for (const m of parenMatches) {
      const inner = norm(m.replace(/[()]/g, ' '));
      if (inner.length >= 2) variants.add(inner);
    }
  }

  // prefixes
  for (const v of Array.from(variants)) {
    if (v.startsWith('the ')) variants.add(v.slice(4).trim());
    if (v.startsWith('gundam ')) variants.add(('mobile suit ' + v).trim());
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

async function main() {
  console.log('=== [MASTER MAPPER & DB SYNC] Starting ===');

  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const anilistDump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));

  const lookup = new Map();
  const noSpaceLookup = new Map();
  const byFirstLetter = new Map();

  function addIndex(titleStr, id, mal) {
    if (!titleStr) return;
    const variants = getVariants(titleStr);
    for (const v of variants) {
      if (!lookup.has(v)) lookup.set(v, { id, mal });

      const ns = v.replace(/\s+/g, '');
      if (ns.length >= 3 && !noSpaceLookup.has(ns)) {
        noSpaceLookup.set(ns, { id, mal });
      }

      const fl = v[0];
      if (!byFirstLetter.has(fl)) byFirstLetter.set(fl, []);
      byFirstLetter.get(fl).push({ title: v, id, mal });
    }
  }

  console.log(`Indexing AniList Dump (${anilistDump.length} items)...`);
  for (const m of anilistDump) {
    if (m.title?.romaji) addIndex(m.title.romaji, m.id, m.idMal);
    if (m.title?.english) addIndex(m.title.english, m.id, m.idMal);
    if (m.title?.native) addIndex(m.title.native, m.id, m.idMal);
    if (Array.isArray(m.synonyms)) {
      for (const syn of m.synonyms) addIndex(syn, m.id, m.idMal);
    }
  }

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

  console.log(`Index ready: ${lookup.size} exact keys, ${noSpaceLookup.size} no-space keys.`);

  let newlyMapped = 0;
  for (const anime of catalog) {
    if (anime.anilist_id) continue;

    const tVars = getVariants(anime.title);
    const sVars = getVariants(anime.slug.replace(/-/g, ' '));
    const all = [...tVars, ...sVars];

    // 1. Exact variant lookup
    let match = null;
    for (const v of all) {
      if (lookup.has(v)) {
        match = lookup.get(v);
        break;
      }
    }

    // 2. No-space lookup
    if (!match) {
      for (const v of all) {
        const ns = v.replace(/\s+/g, '');
        if (noSpaceLookup.has(ns)) {
          match = noSpaceLookup.get(ns);
          break;
        }
      }
    }

    // 3. Fuzzy similarity lookup
    if (!match && tVars[0] && tVars[0].length >= 3) {
      const fl = tVars[0][0];
      const candidates = byFirstLetter.get(fl) || [];
      let bestScore = 0;
      let bestMatch = null;
      for (const cand of candidates) {
        const sim = stringSimilarity(tVars[0], cand.title);
        if (sim > bestScore && sim >= 0.82) {
          bestScore = sim;
          bestMatch = cand;
        }
      }
      if (bestMatch) match = bestMatch;
    }

    if (match) {
      anime.anilist_id = match.id;
      anime.mal_id = match.mal || anime.mal_id || null;
      newlyMapped++;
    }
  }

  console.log(`Newly mapped in this pass: ${newlyMapped}`);
  const totalMapped = catalog.filter(a => a.anilist_id).length;
  console.log(`Total Mapped Anime in Catalog: ${totalMapped} / ${catalog.length} (${(totalMapped / catalog.length * 100).toFixed(1)}%)`);

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');

  // Sync and scrape episode lists for all mapped anime
  console.log(`\n=== Syncing Database & Scraping Missing Episode Lists ===`);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.by_slug = db.by_slug || {};
  db.by_anilist = db.by_anilist || {};
  db.by_mal = db.by_mal || {};

  // Sync existing db entries with any new catalog mappings
  for (const item of catalog) {
    if (db.by_slug[item.slug]) {
      const entry = db.by_slug[item.slug];
      if (item.anilist_id) entry.anilist_id = item.anilist_id;
      if (item.mal_id) entry.mal_id = item.mal_id;

      if (entry.anilist_id) {
        const aid = String(entry.anilist_id);
        const ex = db.by_anilist[aid];
        if (!ex || (!entry.slug.includes('-dub') && ex.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (ex.episode_list?.length || 0))) {
          db.by_anilist[aid] = entry;
        }
      }
      if (entry.mal_id) {
        const mid = String(entry.mal_id);
        const exm = db.by_mal[mid];
        if (!exm || (!entry.slug.includes('-dub') && exm.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (exm.episode_list?.length || 0))) {
          db.by_mal[mid] = entry;
        }
      }
    }
  }

  const targets = catalog.filter(a => a.anilist_id && (!db.by_slug[a.slug]?.episode_list?.length));
  console.log(`Target anime missing episodes in DB: ${targets.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 12;

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
        const ex = db.by_anilist[aid];
        if (!ex || (!animeEntry.slug.includes('-dub') && ex.slug.includes('-dub')) || (cleanEps.length > (ex.episode_list?.length || 0))) {
          db.by_anilist[aid] = animeEntry;
        }

        if (item.mal_id) {
          const mid = String(item.mal_id);
          const exm = db.by_mal[mid];
          if (!exm || (!animeEntry.slug.includes('-dub') && exm.slug.includes('-dub')) || (cleanEps.length > (exm.episode_list?.length || 0))) {
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

  if (targets.length > 0) {
    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);
  }

  saveDatabase(db);

  let totalEps = 0;
  for (const s in db.by_slug) {
    totalEps += (db.by_slug[s].episode_list || []).length;
  }

  console.log(`\n=======================================================`);
  console.log(`🎉 [FINAL MILESTONE ACHIEVED]`);
  console.log(`  - Total Anime in Catalog: ${catalog.length}`);
  console.log(`  - Total Mapped in Catalog: ${totalMapped} (${(totalMapped / catalog.length * 100).toFixed(1)}%)`);
  console.log(`  - Total Series in DB by_slug: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Unique AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Unique MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
  console.log(`  - Total Indexed Episodes: ${totalEps}`);
  console.log(`=======================================================`);
}

main().catch(console.error);
