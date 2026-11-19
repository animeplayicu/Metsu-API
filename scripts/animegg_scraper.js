import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAL_TO_ANIMEGG, ANILIST_TO_ANIMEGG } from '../mappings/animegg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, '../data/animegg_database.json');

const BASE = 'https://www.animegg.org';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': BASE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

/**
 * Load or initialize database
 */
function loadDatabase() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      console.warn('Could not parse existing database, starting fresh.');
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
  db.total_anime = Object.keys(db.by_slug).length;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);
}

/**
 * Extract direct MP4 & backup sources from an embed ID
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
  } catch (err) {
    return [];
  }
}

/**
 * Scrape all episode tabs and streams for an episode page
 */
async function scrapeEpisode(epSlug, audio = 'sub') {
  try {
    const html = await fetchHtml(`${BASE}/${epSlug}`);
    const titleMatch = html.match(/<div\b[^>]*class=["'][^"']*info[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

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

    // Resolve streams for top tab
    const primaryTab = tabs[0];
    const sources = await scrapeEmbed(primaryTab.embedId);

    return {
      title,
      embed_id: primaryTab.embedId,
      embed_url: primaryTab.embedUrl,
      audio: primaryTab.normalized,
      sources,
      stream_url: sources[0]?.url || primaryTab.embedUrl
    };
  } catch (err) {
    return null;
  }
}

/**
 * Scrape series episode list
 */
async function scrapeSeriesEpisodes(slug) {
  const html = await fetchHtml(`${BASE}/series/${slug}`);
  const episodes = [];
  
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    if (!block.includes('anm_det_pop')) continue;
    const hrefMatch = block.match(/href=["']\/([^"'#]+)/i);
    const href = hrefMatch ? hrefMatch[1] : '';
    const strongMatch = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    const strongText = strongMatch ? strongMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const numMatch = strongText.match(/(\d+)\s*$/);
    if (!href || !numMatch) continue;

    const number = parseInt(numMatch[1], 10);
    episodes.push({ number, epSlug: href });
  }

  episodes.sort((a, b) => a.number - b.number);
  const seen = new Set();
  return episodes.filter(e => seen.has(e.number) ? false : (seen.add(e.number), true));
}

/**
 * Scrape a full anime series (or subset of episodes)
 */
export async function scrapeAnime(slug, options = {}) {
  const { maxEpisodes = 10, anilistId = null, malId = null, audio = 'sub' } = options;
  console.log(`\n[SCRAPE] Starting ${slug} (AniList: ${anilistId}, MAL: ${malId})...`);

  const epList = await scrapeSeriesEpisodes(slug);
  console.log(`[SCRAPE] Found ${epList.length} episodes for ${slug}`);

  const episodesData = {};
  const targetEpisodes = maxEpisodes ? epList.slice(0, maxEpisodes) : epList;

  for (const ep of targetEpisodes) {
    process.stdout.write(`  -> Scraping Ep ${ep.number}... `);
    const t0 = Date.now();
    const epData = await scrapeEpisode(ep.epSlug, audio);
    if (epData) {
      episodesData[ep.number] = epData;
      console.log(`OK (${Date.now() - t0}ms, ${epData.sources.length} sources)`);
    } else {
      console.log('FAILED');
    }
    await sleep(250); // Be polite to the server
  }

  return {
    slug,
    anilist_id: anilistId,
    mal_id: malId,
    total_episodes: epList.length,
    scraped_episodes: Object.keys(episodesData).length,
    episodes: episodesData
  };
}

/**
 * Main batch runner
 */
async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5;
  const epLimitArg = args.find(a => a.startsWith('--ep-limit='));
  const epLimit = epLimitArg ? parseInt(epLimitArg.split('=')[1], 10) : 5;

  console.log(`=== AnimeGG Scraper Starting ===`);
  console.log(`Anime Limit: ${limit}, Episodes per anime: ${epLimit}`);

  const db = loadDatabase();

  // 1. Invert MAL mappings to find slugs
  const entries = Object.entries(MAL_TO_ANIMEGG);
  console.log(`Total mapped entries available: ${entries.length}`);

  let count = 0;
  for (const [malIdStr, slug] of entries) {
    if (count >= limit) break;
    const malId = parseInt(malIdStr, 10);
    // Find AniList ID if mapped or equal
    let anilistId = malId; // Many MAL & AniList match or we check ANILIST_TO_ANIMEGG
    for (const [alId, sl] of Object.entries(ANILIST_TO_ANIMEGG)) {
      if (sl === slug) anilistId = parseInt(alId, 10);
    }

    try {
      const animeData = await scrapeAnime(slug, {
        maxEpisodes: epLimit,
        anilistId,
        malId,
        audio: 'sub'
      });

      // Save into DB
      db.by_slug[slug] = animeData;
      if (anilistId) db.by_anilist[String(anilistId)] = animeData;
      if (malId) db.by_mal[String(malId)] = animeData;

      saveDatabase(db);
      console.log(`[SAVED] Saved ${slug} into database successfully!`);
      count++;
    } catch (err) {
      console.error(`[ERROR] Failed to scrape ${slug}:`, err.message);
    }

    await sleep(500);
  }

  console.log(`\n=== Batch Scraping Completed. Total in DB: ${Object.keys(db.by_slug).length} ===`);
  console.log(`Database saved at: ${DATA_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
