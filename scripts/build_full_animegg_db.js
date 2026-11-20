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
const STATE_FILE = path.join(__dirname, '../data/animegg_scrape_state.json');
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

/**
 * Normalizes text for matching
 */
function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculates Dice's Coefficient between two strings
 */
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

/**
 * Load or initialize database
 */
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      console.warn('[DB] Could not parse existing DB, creating fresh.');
    }
  }
  return {
    updated_at: new Date().toISOString(),
    total_anime: 0,
    by_anilist: {},
    by_mal: {},
    by_slug: {}
  };
}

/**
 * Save database atomically
 */
function saveDatabase(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/**
 * Phase 1: Harvest Complete AnimeGG Catalog across multi-sort sweeps
 */
async function harvestCatalog() {
  console.log('\n=== [PHASE 1] Harvesting AnimeGG Catalog (Multi-Sort Sweep) ===');
  const catalog = [];
  const seen = new Set();

  // Load existing catalog if available to resume/extend
  if (fs.existsSync(CATALOG_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      for (const item of existing) {
        if (!seen.has(item.slug)) {
          seen.add(item.slug);
          catalog.push(item);
        }
      }
      console.log(`[RESUME] Loaded ${catalog.length} anime from existing catalog.`);
    } catch {}
  }

  const sweeps = [
    // Standard Popularity
    'https://www.animegg.org/popular-series?limit=100',
    'https://www.animegg.org/popular-series?ongoing=true&limit=100',
    'https://www.animegg.org/popular-series?ongoing=false&limit=100',
    // Created Date (Newest to Oldest & Oldest to Newest)
    'https://www.animegg.org/popular-series?sortBy=createdAt&sortDirection=DESC&limit=100',
    'https://www.animegg.org/popular-series?sortBy=createdAt&sortDirection=ASC&limit=100',
    // Updated Date
    'https://www.animegg.org/popular-series?sortBy=updatedAt&sortDirection=DESC&limit=100',
    'https://www.animegg.org/popular-series?sortBy=updatedAt&sortDirection=ASC&limit=100',
    // Alphabetical (A-Z and Z-A)
    'https://www.animegg.org/popular-series?sortBy=title&sortDirection=ASC&limit=100',
    'https://www.animegg.org/popular-series?sortBy=title&sortDirection=DESC&limit=100',
    // Hits
    'https://www.animegg.org/popular-series?sortBy=hits&sortDirection=ASC&limit=100',
    'https://www.animegg.org/popular-series?sortBy=hits&sortDirection=DESC&limit=100',
  ];

  for (const sweepUrl of sweeps) {
    for (const start of [0, 625]) {
      const url = `${sweepUrl}&start=${start}`;
      process.stdout.write(`Sweeping: ${url.replace('https://www.animegg.org', '')}... `);
      try {
        const t0 = Date.now();
        const html = await fetchHtml(url);
        const listMatches = [...html.matchAll(/<li class=["']fea["']>([\s\S]*?)<\/li>/gi)];

        let newItems = 0;
        for (const m of listMatches) {
          const block = m[1];
          const slugMatch = block.match(/href=["']\/series\/([^"'#?]+)["']/i);
          const titleMatch = block.match(/<div class=["']rightpop["']><a[^>]*>([\s\S]*?)<\/a>/i);
          const epMatch = block.match(/(\d+)\s*Episodes/i);
          const statusMatch = block.match(/(Ongoing|Completed)/i);
          const imgMatch = block.match(/<img[^>]*src=["']([^"']+)["']/i);

          if (slugMatch) {
            const slug = slugMatch[1].trim();
            if (!seen.has(slug)) {
              seen.add(slug);
              newItems++;
              catalog.push({
                slug,
                title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : slug,
                total_episodes: epMatch ? parseInt(epMatch[1], 10) : 0,
                status: statusMatch ? statusMatch[1] : 'Unknown',
                image: imgMatch ? imgMatch[1] : null,
                rank: catalog.length + 1
              });
            }
          }
        }
        console.log(`OK (${Date.now() - t0}ms, +${newItems} unique, total: ${catalog.length})`);
        await sleep(500);
      } catch (err) {
        console.log(`ERR (${err.message})`);
      }
    }
  }

  console.log(`\n[PHASE 1] Catalog Harvest Complete! Total Unique Anime: ${catalog.length}`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`Saved catalog to: ${CATALOG_FILE}`);
  return catalog;
}

/**
 * Phase 2: Map AnimeGG Slugs to AniList and MAL IDs (High-Speed Indexed)
 */
async function mapCatalog(catalog) {
  console.log('\n=== [PHASE 2] Mapping AnimeGG Catalog to AniList & MAL ===');

  // Load Anikoto DB for local high-speed resolution
  let anikotoDb = { by_anilist: {}, by_slug: {} };
  if (fs.existsSync(ANIKOTO_FILE)) {
    try {
      anikotoDb = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
      console.log(`[MAPPER] Loaded ${Object.keys(anikotoDb.by_anilist || {}).length} anime from Anikoto DB.`);
    } catch (e) {
      console.warn(`[MAPPER] Could not read anikoto DB:`, e.message);
    }
  }

  // Pre-index Anikoto by normalized title & by slug
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

  // Build inverted static maps
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

  let matchedStatic = 0;
  let matchedAnikoto = 0;
  let matchedFuzzy = 0;
  let unmapped = 0;

  for (const anime of catalog) {
    // 1. Check static MAL maps and resolve AniList ID
    if (slugToMal[anime.slug]) {
      anime.mal_id = slugToMal[anime.slug];
      const malMatch = anikotoDb.by_mal?.[String(anime.mal_id)];
      if (malMatch?.anilist_id) {
        anime.anilist_id = malMatch.anilist_id;
        matchedStatic++;
      }
    }
    if (slugToAnilist[anime.slug]) {
      anime.anilist_id = slugToAnilist[anime.slug];
      matchedStatic++;
    }

    const norm = normalizeTitle(anime.title);

    // 2. Check exact title match from Anikoto DB
    if (!anime.anilist_id && norm) {
      const exactMatch = anikotoByTitle.get(norm);
      if (exactMatch && exactMatch.anilist_id) {
        anime.anilist_id = exactMatch.anilist_id;
        anime.mal_id = exactMatch.mal_id || anime.mal_id || null;
        matchedAnikoto++;
      }
    }

    // 3. Fast first-letter-partitioned fuzzy match
    if (!anime.anilist_id && norm && anime.rank <= 3000) {
      const firstLetter = norm[0];
      const candidates = anikotoByFirstLetter.get(firstLetter) || [];
      let bestScore = 0;
      let bestCandidate = null;

      for (const cand of candidates) {
        const sim = stringSimilarity(norm, cand.norm);
        if (sim > bestScore && sim >= 0.82) {
          bestScore = sim;
          bestCandidate = cand.anime;
        }
      }

      if (bestCandidate && bestCandidate.anilist_id) {
        anime.anilist_id = bestCandidate.anilist_id;
        anime.mal_id = bestCandidate.mal_id || anime.mal_id || null;
        matchedFuzzy++;
      }
    }

    if (!anime.anilist_id) {
      unmapped++;
    }
  }

  console.log(`[PHASE 2] Mapping Results:`);
  console.log(`  - Static Maps: ${matchedStatic}`);
  console.log(`  - Exact Anikoto Matches: ${matchedAnikoto}`);
  console.log(`  - High-Confidence Fuzzy Matches: ${matchedFuzzy}`);
  console.log(`  - Total Mapped: ${matchedStatic + matchedAnikoto + matchedFuzzy}`);
  console.log(`  - Unmapped: ${unmapped}`);

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`[MAPPER] Updated catalog saved to: ${CATALOG_FILE}`);
  return catalog;
}

/**
 * Scrape series episode list
 */
async function scrapeSeriesEpisodes(slug) {
  try {
    const html = await fetchHtml(`${BASE}/series/${slug}`);
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
            epSlug: hrefMatch[1],
            title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Episode ${epNum}`,
            hasSub: subMatch || !dubMatch,
            hasDub: dubMatch
          });
        }
      }
    }

    episodes.sort((a, b) => a.number - b.number);
    const seen = new Set();
    return episodes.filter(e => seen.has(e.number) ? false : (seen.add(e.number), true));
  } catch (err) {
    return [];
  }
}

/**
 * Extract direct MP4 and streams from embed ID
 */
async function scrapeEmbed(embedId) {
  try {
    const html = await fetchHtml(`${BASE}/embed/${embedId}`);
    const m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return [];

    let parsed = [];
    try {
      const asJson = m[1]
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      parsed = JSON.parse(asJson);
    } catch {
      return [];
    }

    return parsed.map(s => {
      let backup = null;
      if (s.bk) {
        try { backup = decodeURIComponent(Buffer.from(s.bk, 'base64').toString('utf8')); }
        catch { backup = null; }
      }
      return {
        quality: s.label || 'unknown',
        url: s.file ? (s.file.startsWith('http') ? s.file : `${BASE}${s.file}`) : '',
        backup
      };
    }).filter(s => s.url);
  } catch {
    return [];
  }
}

/**
 * Scrape episode streams for a single episode slug
 */
async function scrapeEpisodeStream(epSlug, audio = 'sub') {
  try {
    const html = await fetchHtml(`${BASE}/${epSlug}`);
    const tabs = [];
    for (const m of html.matchAll(/<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi)) {
      const tag = m[0];
      const embedId = tag.match(/data-id=["']([^"']+)["']/i)?.[1];
      const server = tag.match(/data-mirror=["']([^"']+)["']/i)?.[1] || 'AnimeGG';
      const version = tag.match(/data-version=["']([^"']+)["']/i)?.[1] || 'subbed';
      if (!embedId) continue;
      const normalized = version.startsWith('dub') ? 'dub' : 'sub';
      if (audio === 'all' || normalized === audio) {
        tabs.push({ embedId, embedUrl: `${BASE}/embed/${embedId}`, server, normalized });
      }
    }

    if (tabs.length === 0) return null;
    const primaryTab = tabs[0];
    const sources = await scrapeEmbed(primaryTab.embedId);

    return {
      embed_id: primaryTab.embedId,
      embed_url: primaryTab.embedUrl,
      audio: primaryTab.normalized,
      sources,
      stream_url: sources[0]?.url || primaryTab.embedUrl
    };
  } catch {
    return null;
  }
}

/**
 * Phase 3: Index Episodes for all anime into animegg_database.json (Concurrent)
 */
async function indexEpisodes(catalog, options = {}) {
  const { limit = null, scrapeStreams = false, maxStreamEps = 5, concurrency = 4 } = options;
  console.log(`\n=== [PHASE 3] Indexing Episodes (Limit: ${limit || 'ALL'}, Concurrency: ${concurrency}, Streams: ${scrapeStreams}) ===`);

  const db = loadDatabase();
  // Filter catalog: prioritize mapped anime first
  const targetList = limit
    ? catalog.slice(0, limit)
    : [...catalog.filter(a => a.anilist_id), ...catalog.filter(a => !a.anilist_id)];

  let processed = 0;
  let savedCount = 0;
  let currentIndex = 0;

  async function worker(workerId) {
    while (currentIndex < targetList.length) {
      const idx = currentIndex++;
      const item = targetList[idx];
      processed++;

      // Skip if already in DB with episodes
      const existing = db.by_slug[item.slug];
      if (existing && existing.episode_list && existing.episode_list.length > 0 && !scrapeStreams) {
        // Just ensure anilist/mal mappings are linked
        if (item.anilist_id && !db.by_anilist[String(item.anilist_id)]) db.by_anilist[String(item.anilist_id)] = existing;
        if (item.mal_id && !db.by_mal[String(item.mal_id)]) db.by_mal[String(item.mal_id)] = existing;
        console.log(`[W${workerId}][${processed}/${targetList.length}] ${item.slug} -> CACHED (${existing.episode_list.length} eps)`);
        continue;
      }

      const t0 = Date.now();
      const epList = await scrapeSeriesEpisodes(item.slug);

      if (epList.length === 0) {
        console.log(`[W${workerId}][${processed}/${targetList.length}] ${item.slug} -> NO EPS / FAILED`);
        continue;
      }

      const animeEntry = existing || {
        slug: item.slug,
        title: item.title,
        anilist_id: item.anilist_id || null,
        mal_id: item.mal_id || null,
        total_episodes: epList.length,
        image: item.image,
        episode_list: [],
        episodes: {}
      };

      animeEntry.total_episodes = epList.length;
      animeEntry.episode_list = epList.map(e => ({
        number: e.number,
        title: e.title,
        slug: e.epSlug,
        hasSub: e.hasSub,
        hasDub: e.hasDub
      }));

      if (scrapeStreams) {
        const streamTargets = epList.slice(0, maxStreamEps);
        for (const ep of streamTargets) {
          if (!animeEntry.episodes[ep.number]) {
            const streamData = await scrapeEpisodeStream(ep.epSlug, 'sub');
            if (streamData) {
              animeEntry.episodes[ep.number] = {
                title: ep.title,
                ...streamData
              };
            }
            await sleep(150);
          }
        }
      }

      // Index by slug
      db.by_slug[item.slug] = animeEntry;
      if (item.anilist_id) db.by_anilist[String(item.anilist_id)] = animeEntry;
      if (item.mal_id) db.by_mal[String(item.mal_id)] = animeEntry;

      savedCount++;
      console.log(`[W${workerId}][${processed}/${targetList.length}] ${item.slug} -> OK (${Date.now() - t0}ms, ${epList.length} eps)`);

      if (savedCount % 20 === 0) {
        saveDatabase(db);
        console.log(`  💾 [CHECKPOINT] Saved ${Object.keys(db.by_slug).length} anime to database.`);
      }

      await sleep(300);
    }
  }

  // Launch workers in parallel
  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  saveDatabase(db);
  console.log(`\n[PHASE 3] Complete! Total anime in database: ${Object.keys(db.by_slug).length}`);
}

/**
 * Main Orchestrator
 */
async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find(a => a.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.split('=')[1] : 'all';
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log(`========================================`);
  console.log(`   AnimeGG Master Database Builder      `);
  console.log(`   Phase: ${phase} | Limit: ${limit || 'None'} `);
  console.log(`========================================`);

  let catalog = [];
  if (fs.existsSync(CATALOG_FILE)) {
    try {
      catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      console.log(`[INIT] Loaded existing catalog: ${catalog.length} anime.`);
    } catch {}
  }

  if (phase === 'catalog' || (phase === 'all' && catalog.length === 0)) {
    catalog = await harvestCatalog();
  }

  if (phase === 'map' || phase === 'all') {
    if (catalog.length === 0) catalog = await harvestCatalog();
    catalog = await mapCatalog(catalog);
  }

  if (phase === 'episodes' || phase === 'all') {
    if (catalog.length === 0) catalog = await harvestCatalog();
    await indexEpisodes(catalog, { limit, scrapeStreams: false });
  }

  if (phase === 'streams') {
    if (catalog.length === 0) catalog = await harvestCatalog();
    await indexEpisodes(catalog, { limit: limit || 100, scrapeStreams: true, maxStreamEps: 10 });
  }

  console.log(`\n🎉 All requested operations finished!`);
}

main().catch(console.error);
