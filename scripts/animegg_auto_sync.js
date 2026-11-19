import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function loadDatabase() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {}
  }
  return { updated_at: new Date().toISOString(), total_anime: 0, by_anilist: {}, by_mal: {}, by_slug: {} };
}

function saveDatabase(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

async function scrapeEmbed(embedId) {
  try {
    const html = await fetchHtml(`${BASE}/embed/${embedId}`);
    const m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return [];

    const asJson = m[1]
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    const parsed = JSON.parse(asJson);

    return parsed.map(s => {
      let backup = null;
      if (s.bk) {
        try { backup = decodeURIComponent(Buffer.from(s.bk, 'base64').toString('utf8')); } catch {}
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

async function scrapeEpisode(epSlug) {
  try {
    const cleanSlug = epSlug.replace(/^(\/)/, '').replace(/#.*$/, '');
    const html = await fetchHtml(`${BASE}/${cleanSlug}`);
    const titleMatch = html.match(/<div\b[^>]*class=["'][^"']*info[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const tabs = [];
    for (const m of html.matchAll(/<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi)) {
      const tag = m[0];
      const embedId = tag.match(/data-id=["']([^"']+)["']/i)?.[1];
      const server = tag.match(/data-mirror=["']([^"']+)["']/i)?.[1] || 'AnimeGG';
      const version = tag.match(/data-version=["']([^"']+)["']/i)?.[1] || 'subbed';
      if (!embedId) continue;
      tabs.push({ embedId, embedUrl: `${BASE}/embed/${embedId}`, server, audio: version.startsWith('dub') ? 'dub' : 'sub' });
    }

    if (tabs.length === 0) return null;
    const primary = tabs[0];
    const sources = await scrapeEmbed(primary.embedId);

    return {
      title,
      embed_id: primary.embedId,
      embed_url: primary.embedUrl,
      audio: primary.audio,
      sources,
      stream_url: sources[0]?.url || primary.embedUrl
    };
  } catch {
    return null;
  }
}

/**
 * Sync the latest released episodes from https://www.animegg.org/releases
 */
export async function syncLatestReleases() {
  console.log(`[AUTO-SYNC] Checking latest releases on AnimeGG...`);
  const html = await fetchHtml(`${BASE}/releases`);
  const epLinks = [...html.matchAll(/href="(\/[^"]*episode-[^"]*)"/g)].map(m => m[1]);
  const uniqueEpLinks = Array.from(new Set(epLinks.map(l => l.replace(/#.*$/, ''))));

  console.log(`[AUTO-SYNC] Found ${uniqueEpLinks.length} recent releases in feed.`);
  const db = loadDatabase();
  let newEpisodesCount = 0;

  for (const epPath of uniqueEpLinks.slice(0, 15)) {
    // e.g. /one-piece-episode-1160
    const m = epPath.match(/\/([a-zA-Z0-9_\-]+)-episode-(\d+)/i);
    if (!m) continue;

    const seriesSlug = m[1];
    const epNum = m[2];

    // Find anime in db
    let animeEntry = db.by_slug?.[seriesSlug];
    if (!animeEntry) {
      // Check by_anilist values
      for (const a of Object.values(db.by_anilist || {})) {
        if (a.slug === seriesSlug) {
          animeEntry = a;
          break;
        }
      }
    }

    // If anime is tracked in DB and this episode is missing -> fetch and update!
    if (animeEntry && (!animeEntry.episodes || !animeEntry.episodes[epNum])) {
      process.stdout.write(`  -> New Episode found: ${seriesSlug} Ep ${epNum}... `);
      const epData = await scrapeEpisode(epPath);
      if (epData) {
        if (!animeEntry.episodes) animeEntry.episodes = {};
        animeEntry.episodes[epNum] = epData;

        // Also sync across by_anilist, by_mal, and by_slug
        const alId = animeEntry.anilist_id;
        if (alId && db.by_anilist?.[String(alId)]) {
          if (!db.by_anilist[String(alId)].episodes) db.by_anilist[String(alId)].episodes = {};
          db.by_anilist[String(alId)].episodes[epNum] = epData;
        }

        const malId = animeEntry.mal_id;
        if (malId && db.by_mal?.[String(malId)]) {
          if (!db.by_mal[String(malId)].episodes) db.by_mal[String(malId)].episodes = {};
          db.by_mal[String(malId)].episodes[epNum] = epData;
        }

        newEpisodesCount++;
        console.log(`UPDATED (Embed: ${epData.embed_id})`);
      } else {
        console.log(`SKIPPED`);
      }
      await sleep(400);
    }
  }

  if (newEpisodesCount > 0) {
    saveDatabase(db);
    console.log(`[AUTO-SYNC] Successfully updated ${newEpisodesCount} new episodes into database!`);
  } else {
    console.log(`[AUTO-SYNC] All latest episodes are already up-to-date.`);
  }
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Direct execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const isDaemon = process.argv.includes('--daemon');

  if (isDaemon) {
    console.log('🚀 [AUTO-SYNC DAEMON] Started in 6-hour background mode.');
    syncLatestReleases().catch(console.error);

    setInterval(() => {
      console.log(`\n⏰ [AUTO-SYNC DAEMON] Running 6-hour scheduled sync...`);
      syncLatestReleases().catch(console.error);
    }, SIX_HOURS_MS);
  } else {
    syncLatestReleases().catch(console.error);
  }
}
