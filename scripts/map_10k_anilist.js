import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAL_TO_ANIMEGG, ANILIST_TO_ANIMEGG } from '../mappings/animegg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');
const ANILIST_DUMP_FILE = path.join(__dirname, '../data/anilist_dump.json');
const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');
const ANIPM_FILE = path.join(__dirname, '../data/anipmbeta_library.json');

const BASE = 'https://www.animegg.org';
const ANILIST_URL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanTitle(t) {
  if (!t) return '';
  return t
    .replace(/\s*-\s*movie\b/gi, '')
    .replace(/\s*\((tv|movie|ova|ona|special|dub|sub)\)/gi, '')
    .replace(/\s*\[(tv|movie|ova|ona|special|dub|sub)\]/gi, '')
    .replace(/\s*\b(dubbed|subbed|dub|sub)\b/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSlug(s) {
  if (!s) return '';
  return s
    .replace(/-(movie|tv|ova|ona|special|specials|dub|sub)$/gi, '')
    .replace(/-season-\d+$/gi, '')
    .replace(/-2nd-season$/gi, '')
    .replace(/-3rd-season$/gi, '')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * 1. Expand Catalog to 11k+ using 2-letter combos
 */
async function expandToFullCatalog() {
  console.log(`\n=== [STAGE 1] Full Catalog Expansion (Target: ~11,000 Anime) ===`);
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const seen = new Set(catalog.map(a => a.slug));
  console.log(`Starting with ${catalog.length} anime in catalog.`);

  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const combos = [];
  for (const l1 of letters) {
    for (const l2 of letters) {
      combos.push(l1 + l2);
    }
  }

  let added = 0;
  let cIndex = 0;
  const CONCURRENCY = 6;

  async function worker(id) {
    while (cIndex < combos.length) {
      const q = combos[cIndex++];
      const url = `${BASE}/search/?q=${q}`;
      try {
        const html = await fetchHtml(url);
        const matches = [...html.matchAll(/<a\b[^>]*href=["']\/series\/([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        let inQuery = 0;

        for (const m of matches) {
          const slug = m[1].trim();
          const inner = m[2];
          if (slug.includes('popular') || slug.includes('browse') || slug.includes('releases')) continue;

          if (!seen.has(slug)) {
            seen.add(slug);
            const titleMatch = inner.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) ||
                               inner.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) ||
                               inner.match(/title=["']([^"']+)["']/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : inner.replace(/<[^>]+>/g, '').trim();
            const cleanT = title && !title.includes('Watch Anime') ? title : slug;

            catalog.push({
              slug,
              title: cleanT,
              total_episodes: 0,
              status: 'Unknown',
              image: null,
              rank: catalog.length + 1
            });
            inQuery++;
            added++;
          }
        }
        if (inQuery > 0) {
          console.log(`[W${id}] q="${q}" -> +${inQuery} new (Total: ${catalog.length})`);
        }
        await sleep(300);
      } catch {}
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`[STAGE 1] Done! Added ${added} new anime. Total Catalog: ${catalog.length}`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  return catalog;
}

/**
 * 2. Download AniList 10,000 Dump
 */
async function getAniListDump() {
  console.log(`\n=== [STAGE 2] AniList 10k Master Index ===`);
  if (fs.existsSync(ANILIST_DUMP_FILE)) {
    try {
      const dump = JSON.parse(fs.readFileSync(ANILIST_DUMP_FILE, 'utf8'));
      if (dump.length >= 8000) {
        console.log(`[CACHE] Loaded ${dump.length} anime from existing AniList dump.`);
        return dump;
      }
    } catch {}
  }

  console.log(`[DOWNLOAD] Fetching Top 10,000 Anime from AniList GraphQL...`);
  const allMedia = [];
  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        media(type: ANIME, sort: POPULARITY_DESC) {
          id
          idMal
          title { romaji english native }
          synonyms
        }
      }
    }
  `;

  for (let page = 1; page <= 220; page++) {
    process.stdout.write(`Fetching page ${page}/220... `);
    try {
      const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { page } })
      });
      if (!res.ok) {
        console.log(`HTTP ${res.status}`);
        if (res.status === 429) {
          console.log('Rate limited, sleeping 60s...');
          await sleep(60000);
          page--;
          continue;
        }
        break;
      }
      const data = await res.json();
      const list = data.data?.Page?.media || [];
      allMedia.push(...list);
      console.log(`+${list.length} (Total: ${allMedia.length})`);
      if (!data.data?.Page?.pageInfo?.hasNextPage) break;
      await sleep(650); // Respect 90 req/min
    } catch (e) {
      console.log(`Error: ${e.message}`);
      await sleep(2000);
    }
  }

  fs.writeFileSync(ANILIST_DUMP_FILE, JSON.stringify(allMedia, null, 2), 'utf8');
  console.log(`[DOWNLOAD] Saved ${allMedia.length} anime to ${ANILIST_DUMP_FILE}`);
  return allMedia;
}

/**
 * 3. Master Map to AniList
 */
async function masterMap(catalog, anilistDump) {
  console.log(`\n=== [STAGE 3] Master Mapping 10,000+ Anime to AniList ===`);

  const lookup = new Map();
  const byFirstLetter = new Map();

  function addIndex(t, id, mal) {
    const c = cleanTitle(t);
    if (!c || c.length < 2) return;
    if (!lookup.has(c)) lookup.set(c, { id, mal });

    const fl = c[0];
    if (!byFirstLetter.has(fl)) byFirstLetter.set(fl, []);
    byFirstLetter.get(fl).push({ title: c, id, mal });
  }

  // Add AniList Dump entries
  for (const m of anilistDump) {
    if (m.title?.romaji) addIndex(m.title.romaji, m.id, m.idMal);
    if (m.title?.english) addIndex(m.title.english, m.id, m.idMal);
    if (m.title?.native) addIndex(m.title.native, m.id, m.idMal);
    if (Array.isArray(m.synonyms)) {
      for (const syn of m.synonyms) addIndex(syn, m.id, m.idMal);
    }
  }

  // Add local libraries
  if (fs.existsSync(ANIPM_FILE)) {
    try {
      const anipm = JSON.parse(fs.readFileSync(ANIPM_FILE, 'utf8'));
      for (const entry of Object.values(anipm.titles || {})) {
        if (entry.id) {
          if (entry.title) addIndex(entry.title, entry.id, entry.mal || null);
          if (entry.native) addIndex(entry.native, entry.id, entry.mal || null);
        }
      }
    } catch {}
  }

  if (fs.existsSync(ANIKOTO_FILE)) {
    try {
      const anikoto = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
      for (const anime of Object.values(anikoto.by_anilist || {})) {
        if (anime.anilist_id) {
          if (anime.title) addIndex(anime.title, anime.anilist_id, anime.mal_id || null);
          if (anime.jp_title) addIndex(anime.jp_title, anime.anilist_id, anime.mal_id || null);
        }
      }
    } catch {}
  }

  console.log(`[INDEX] Built Master Search Index with ${lookup.size} unique titles.`);

  let newlyMapped = 0;

  for (const anime of catalog) {
    if (anime.anilist_id) continue;

    const tClean = cleanTitle(anime.title);
    const sClean = cleanSlug(anime.slug);

    // Exact Title / Slug Match
    let match = lookup.get(tClean) || lookup.get(sClean);
    if (match) {
      anime.anilist_id = match.id;
      anime.mal_id = match.mal || anime.mal_id || null;
      newlyMapped++;
      continue;
    }

    // Partitioned Fuzzy Match
    const fl = tClean[0];
    const candidates = byFirstLetter.get(fl) || [];
    let bestScore = 0;
    let bestMatch = null;

    for (const cand of candidates) {
      const sim = stringSimilarity(tClean, cand.title);
      if (sim > bestScore && sim >= 0.80) {
        bestScore = sim;
        bestMatch = cand;
      }
    }

    if (bestMatch) {
      anime.anilist_id = bestMatch.id;
      anime.mal_id = bestMatch.mal || anime.mal_id || null;
      newlyMapped++;
    }
  }

  const totalMapped = catalog.filter(a => a.anilist_id).length;
  console.log(`[STAGE 3] Newly Mapped: ${newlyMapped}`);
  console.log(`[STAGE 3] Total Mapped in Catalog: ${totalMapped} / ${catalog.length}`);

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  return catalog;
}

/**
 * 4. Index Episodes for all mapped anime
 */
async function indexEpisodes(catalog) {
  console.log(`\n=== [STAGE 4] Indexing Episodes for All Mapped Anime ===`);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const mappedList = catalog.filter(a => a.anilist_id);
  const targets = mappedList.filter(a => !db.by_slug[a.slug]?.episode_list?.length);

  console.log(`Total Mapped: ${mappedList.length}`);
  console.log(`Already in DB with episodes: ${mappedList.length - targets.length}`);
  console.log(`Targets to index: ${targets.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 8;

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
        if (item.anilist_id) db.by_anilist[String(item.anilist_id)] = animeEntry;
        if (item.mal_id) db.by_mal[String(item.mal_id)] = animeEntry;

        savedCount++;
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> OK (${cleanEps.length} eps, ${Date.now() - t0}ms)`);

        if (savedCount % 25 === 0) {
          saveDatabase(db);
          console.log(`  💾 [CHECKPOINT] Saved ${Object.keys(db.by_slug).length} anime in DB (${Object.keys(db.by_anilist).length} AniList mapped)`);
        }

        await sleep(250);
      } catch (err) {
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> ERR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  saveDatabase(db);

  console.log(`\n🎉 [COMPLETE] Master 10k Pipeline Finished!`);
  console.log(`  - Total Anime in Database: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Total AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Total MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
}

async function main() {
  console.log(`=======================================================`);
  console.log(`   AnimeGG 10,000 Anime Mapping & Expansion Pipeline   `);
  console.log(`=======================================================`);

  const catalog = await expandToFullCatalog();
  const anilistDump = await getAniListDump();
  const mapped = await masterMap(catalog, anilistDump);
  await indexEpisodes(mapped);

  console.log(`\n🔥 ALL TASKS FINISHED!`);
}

main().catch(console.error);
