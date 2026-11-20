import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAL_TO_ANIMEGG, ANILIST_TO_ANIMEGG } from '../mappings/animegg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = 'https://www.animegg.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');
const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stringSimilarity(s1, s2) {
  const n1 = normalizeTitle(s1);
  const n2 = normalizeTitle(s2);
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

function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {}
  }
  return {
    updated_at: new Date().toISOString(),
    total_anime: 0,
    by_anilist: {},
    by_mal: {},
    by_slug: {}
  };
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
 * Step 1: Expand Catalog via Search & Letter Crawl
 */
async function expandCatalog() {
  console.log('\n=== [STEP 1] Expanding AnimeGG Catalog to 11,000+ ===');
  let catalog = [];
  const seen = new Set();

  if (fs.existsSync(CATALOG_FILE)) {
    try {
      catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      for (const item of catalog) {
        seen.add(item.slug);
      }
      console.log(`[RESUME] Loaded ${catalog.length} anime from existing catalog.`);
    } catch {}
  }

  const keywords = [
    // Alphabet & Numbers
    ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
    // High-frequency syllables
    'ka', 'ki', 'ku', 'ke', 'ko', 'sa', 'shi', 'su', 'se', 'so',
    'ta', 'chi', 'tsu', 'te', 'to', 'na', 'ni', 'nu', 'ne', 'no',
    'ha', 'hi', 'fu', 'he', 'ho', 'ma', 'mi', 'mu', 'me', 'mo',
    'ya', 'yu', 'yo', 'ra', 'ri', 'ru', 're', 'ro', 'wa',
    'ga', 'gi', 'gu', 'ge', 'go', 'za', 'ji', 'zu', 'ze', 'zo',
    'da', 'de', 'do', 'ba', 'bi', 'bu', 'be', 'bo', 'pa', 'pi', 'pu', 'pe', 'po',
    // Common anime title terms
    'the', 'and', 'movie', 'season', 'special', 'ova', 'legend', 'hero', 'super',
    'dragon', 'girl', 'boy', 'star', 'war', 'love', 'school', 'magic', 'world',
    'monster', 'battle', 'story', 'time', 'dark', 'life', 'black', 'white',
    'chronicle', 'geass', 'gundam', 'sailor', 'fate', 'zero', 'stay', 'blade',
    'soul', 'digimon', 'shin', 'monogatari', 'isekai', 'ken', 'gintama', 'piece',
    'hunter', 'conan', 'titan', 'slayer', 'jujutsu', 'leveling', 'clover', 'hero'
  ];

  let added = 0;
  let qIndex = 0;
  const CONCURRENCY = 4;

  async function worker(id) {
    while (qIndex < keywords.length) {
      const q = keywords[qIndex++];
      const url = `${BASE}/search/?q=${encodeURIComponent(q)}`;
      try {
        const html = await fetchHtml(url);
        // Match series links inside search results
        const matches = [...html.matchAll(/<a\b[^>]*href=["']\/series\/([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        let newInQuery = 0;

        for (const m of matches) {
          const slug = m[1].trim();
          const inner = m[2];
          // Filter out navigation or generic links
          if (slug.includes('popular') || slug.includes('browse') || slug.includes('releases')) continue;

          if (!seen.has(slug)) {
            seen.add(slug);
            const titleMatch = inner.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) ||
                               inner.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) ||
                               inner.match(/title=["']([^"']+)["']/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : inner.replace(/<[^>]+>/g, '').trim();
            const cleanTitle = title && !title.includes('Watch Anime') ? title : slug;

            catalog.push({
              slug,
              title: cleanTitle,
              total_episodes: 0,
              status: 'Unknown',
              image: null,
              rank: catalog.length + 1
            });
            newInQuery++;
            added++;
          }
        }
        console.log(`[W${id}] q="${q}" -> +${newInQuery} new (Total Catalog: ${catalog.length})`);
        await sleep(350);
      } catch (err) {
        console.log(`[W${id}] q="${q}" -> ERR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n[STEP 1] Finished Search Sweep! Added ${added} new titles.`);
  console.log(`Total Catalog Size: ${catalog.length} Anime`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  return catalog;
}

/**
 * Step 2: Map to AniList and MAL IDs
 */
async function mapCatalog(catalog) {
  console.log('\n=== [STEP 2] Running High-Speed AniList & MAL ID Mapper ===');
  let anikotoDb = { by_anilist: {}, by_mal: {} };
  if (fs.existsSync(ANIKOTO_FILE)) {
    try {
      anikotoDb = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
    } catch {}
  }

  const anikotoByTitle = new Map();
  const anikotoByFirstLetter = new Map();

  for (const anime of Object.values(anikotoDb.by_anilist || {})) {
    const titles = [anime.title, anime.jp_title].filter(Boolean);
    for (const t of titles) {
      const norm = normalizeTitle(t);
      if (norm) {
        anikotoByTitle.set(norm, anime);
        const firstLetter = norm[0];
        if (!anikotoByFirstLetter.has(firstLetter)) anikotoByFirstLetter.set(firstLetter, []);
        anikotoByFirstLetter.get(firstLetter).push({ norm, anime });
      }
    }
  }

  const malToSlug = MAL_TO_ANIMEGG || {};
  const slugToMal = {};
  for (const [malId, slug] of Object.entries(malToSlug)) {
    slugToMal[slug] = parseInt(malId, 10);
  }

  const anilistToSlug = ANILIST_TO_ANIMEGG || {};
  const slugToAnilist = {};
  for (const [alId, slug] of Object.entries(anilistToSlug)) {
    slugToAnilist[slug] = parseInt(alId, 10);
  }

  let mappedCount = 0;

  for (const anime of catalog) {
    if (anime.anilist_id) {
      mappedCount++;
      continue;
    }

    // 1. Static Maps
    if (slugToMal[anime.slug]) {
      anime.mal_id = slugToMal[anime.slug];
      const match = anikotoDb.by_mal?.[String(anime.mal_id)];
      if (match?.anilist_id) anime.anilist_id = match.anilist_id;
    }
    if (slugToAnilist[anime.slug]) {
      anime.anilist_id = slugToAnilist[anime.slug];
    }

    const norm = normalizeTitle(anime.title);

    // 2. Exact Title Match
    if (!anime.anilist_id && norm) {
      const exact = anikotoByTitle.get(norm);
      if (exact?.anilist_id) {
        anime.anilist_id = exact.anilist_id;
        anime.mal_id = exact.mal_id || anime.mal_id || null;
      }
    }

    // 3. Fast Fuzzy Match
    if (!anime.anilist_id && norm && anime.rank <= 5000) {
      const firstLetter = norm[0];
      const candidates = anikotoByFirstLetter.get(firstLetter) || [];
      let bestScore = 0;
      let bestCandidate = null;

      for (const cand of candidates) {
        const sim = stringSimilarity(norm, cand.norm);
        if (sim > bestScore && sim >= 0.80) {
          bestScore = sim;
          bestCandidate = cand.anime;
        }
      }

      if (bestCandidate?.anilist_id) {
        anime.anilist_id = bestCandidate.anilist_id;
        anime.mal_id = bestCandidate.mal_id || anime.mal_id || null;
      }
    }

    if (anime.anilist_id) mappedCount++;
  }

  console.log(`[STEP 2] Total Mapped to AniList & MAL: ${mappedCount} / ${catalog.length}`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  return catalog;
}

/**
 * Step 3: Index Episodes for all mapped anime into animegg_database.json
 */
async function indexAllEpisodes(catalog) {
  console.log('\n=== [STEP 3] Indexing Episodes for All Mapped Anime ===');
  const db = loadDatabase();
  const mappedList = catalog.filter(a => a.anilist_id);
  console.log(`Total mapped anime to index: ${mappedList.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 6;

  async function worker(workerId) {
    while (currentIndex < mappedList.length) {
      const idx = currentIndex++;
      const item = mappedList[idx];

      const existing = db.by_slug[item.slug];
      if (existing?.episode_list?.length > 0) {
        // Link AniList and MAL keys
        if (item.anilist_id && !db.by_anilist[String(item.anilist_id)]) db.by_anilist[String(item.anilist_id)] = existing;
        if (item.mal_id && !db.by_mal[String(item.mal_id)]) db.by_mal[String(item.mal_id)] = existing;
        continue;
      }

      const t0 = Date.now();
      try {
        const html = await fetchHtml(`${BASE}/series/${item.slug}`);
        const episodes = [];

        for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
          const block = m[1];
          if (!block.includes('anm_det_pop')) continue;
          const hrefMatch = block.match(/href=["']\/([^"'#]+)/i);
          const strongMatch = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
          const titleMatch = block.match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i) ||
                             block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
          const subMatch = block.includes('subbed') || block.includes('Sub');
          const dubMatch = block.includes('dubbed') || block.includes('Dub');

          if (hrefMatch && strongMatch) {
            const epNum = parseInt(strongMatch[1].replace(/\D+/g, ''), 10);
            if (!isNaN(epNum)) {
              episodes.push({
                number: epNum,
                slug: hrefMatch[1],
                title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Episode ${epNum}`,
                hasSub: subMatch || !dubMatch,
                hasDub: dubMatch
              });
            }
          }
        }

        episodes.sort((a, b) => a.number - b.number);
        const seenEps = new Set();
        const cleanEps = episodes.filter(e => seenEps.has(e.number) ? false : (seenEps.add(e.number), true));

        if (cleanEps.length === 0) continue;

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

        db.by_slug[item.slug] = animeEntry;
        if (item.anilist_id) db.by_anilist[String(item.anilist_id)] = animeEntry;
        if (item.mal_id) db.by_mal[String(item.mal_id)] = animeEntry;

        savedCount++;
        console.log(`[W${workerId}][${idx + 1}/${mappedList.length}] ${item.slug} -> OK (${cleanEps.length} eps, ${Date.now() - t0}ms)`);

        if (savedCount % 25 === 0) {
          saveDatabase(db);
          console.log(`  💾 [CHECKPOINT] Saved ${Object.keys(db.by_slug).length} anime in DB (${Object.keys(db.by_anilist).length} AniList mapped)`);
        }

        await sleep(250);
      } catch (err) {
        console.log(`[W${workerId}][${idx + 1}/${mappedList.length}] ${item.slug} -> ERR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  saveDatabase(db);
  console.log(`\n🎉 [COMPLETE] Indexed ${Object.keys(db.by_slug).length} anime in database!`);
}

async function main() {
  console.log(`=================================================`);
  console.log(`  AnimeGG Complete Catalog Expansion & Database  `);
  console.log(`=================================================`);

  const catalog = await expandCatalog();
  const mapped = await mapCatalog(catalog);
  await indexAllEpisodes(mapped);

  console.log(`\n🔥 ALL TASKS FINISHED SUCCESSFULLY!`);
}

main().catch(console.error);
