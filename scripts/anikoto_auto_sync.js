import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveDownloadsToDb, flushToDisk } from '../core/anikoto-downloads-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '../data/anikoto_database.json');

const BASE = 'https://anikototv.bz';
const MAPPER = 'https://mapper.nekostream.site/api/mal';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Referer': `${BASE}/`,
  'X-Requested-With': 'XMLHttpRequest'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
      console.error('Error loading DB:', e.message);
    }
  }
  return { by_anilist: {}, by_mal: {}, by_slug: {}, by_show_id: {} };
}

function saveDb(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.writeFileSync(DB_PATH, JSON.stringify(db), 'utf8');
}

async function fetchRecentlyUpdated(page = 1) {
  const url = page === 1 ? `${BASE}/filter?sort=recently_updated` : `${BASE}/filter?sort=recently_updated&page=${page}`;
  console.log(`[Auto-Sync] Fetching updated anime from: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching recently_updated`);
  const html = await res.text();

  const items = [];
  const itemRegex = /<div class="ani poster tip" data-tip="([^"]+)">[\s\S]*?<a href="https:\/\/anikototv\.bz\/watch\/([^"/]+)\/ep-1">[\s\S]*?<img [^>]*alt="([^"]+)"[\s\S]*?<div class="left">([\s\S]*?)<\/div>/g;

  let m;
  while ((m = itemRegex.exec(html)) !== null) {
    const showId = m[1].trim();
    const slug = m[2].trim();
    const title = m[3].trim();
    const metaHtml = m[4];

    const subMatch = metaHtml.match(/class="ep-status sub"[^>]*>\s*<span>\s*(\d+)/i);
    const dubMatch = metaHtml.match(/class="ep-status dub"[^>]*>\s*<span>\s*(\d+)/i);

    const latestSub = subMatch ? parseInt(subMatch[1], 10) : null;
    const latestDub = dubMatch ? parseInt(dubMatch[1], 10) : null;

    items.push({ showId, slug, title, latestSub, latestDub });
  }

  return items;
}

async function resolveEpisodeServers(showId, epNum, audio = 'sub') {
  try {
    const epRes = await fetch(`${BASE}/ajax/episode/list/${showId}`, { headers: HEADERS });
    const epJson = await epRes.json();
    const epHtml = epJson?.result || '';

    // Match the target episode tag
    const epTagMatch = epHtml.match(new RegExp(`<a\\s+[^>]*data-num="${epNum}"[^>]*>`, 'i'));
    if (!epTagMatch) return null;

    const tag = epTagMatch[0];
    const dataIds = (tag.match(/data-ids="([^"]+)"/) || [])[1];
    const malId = (tag.match(/data-mal="([^"]+)"/) || [])[1];
    const slug = (tag.match(/data-slug="([^"]+)"/) || [])[1];
    const timestamp = (tag.match(/data-timestamp="([^"]+)"/) || [])[1];

    if (!dataIds) return null;

    // Parallel fetch servers and mapper download links
    const [srvRes, mapperRes] = await Promise.all([
      fetch(`${BASE}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`, { headers: HEADERS }).then(r => r.json()).catch(() => null),
      (malId && slug && timestamp)
        ? fetch(`${MAPPER}/${malId}/${slug}/${timestamp}`, { headers: HEADERS }).then(r => r.json()).catch(() => null)
        : Promise.resolve(null)
    ]);

    const srvHtml = srvRes?.result || '';
    const serverRegex = /<li[^>]*data-link-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
    let sMatch;
    const serverLinks = [];

    while ((sMatch = serverRegex.exec(srvHtml)) !== null) {
      const linkId = sMatch[1];
      const name = sMatch[2].replace(/<[^>]+>/g, '').trim();
      const subIdx = srvHtml.lastIndexOf('data-type="sub"', sMatch.index);
      const dubIdx = srvHtml.lastIndexOf('data-type="dub"', sMatch.index);
      const srvType = dubIdx > subIdx ? 'dub' : 'sub';

      if (srvType === audio) {
        serverLinks.push({ linkId, name, type: srvType });
      }
    }

    // Resolve embed URLs for all servers in parallel
    const resolvedServers = await Promise.all(
      serverLinks.map(async (s) => {
        try {
          const res = await fetch(`${BASE}/ajax/server?get=${encodeURIComponent(s.linkId)}`, { headers: HEADERS });
          const json = await res.json();
          return {
            name: s.name,
            type: s.type,
            url: json?.result?.url || null,
            skip_data: json?.result?.skip_data || null
          };
        } catch {
          return null;
        }
      })
    );

    const validServers = resolvedServers.filter(s => s && s.url);
    const topEmbed = validServers.find(s => s.name === 'HD-1')?.url || validServers[0]?.url || null;

    // Format download links from mapper
    const downloads = [];
    if (mapperRes) {
      for (const [source, data] of Object.entries(mapperRes)) {
        if (source === 'status') continue;
        const audioDl = data?.[audio]?.download;
        if (audioDl && typeof audioDl === 'object') {
          for (const [quality, dUrl] of Object.entries(audioDl)) {
            if (dUrl && typeof dUrl === 'string') {
              downloads.push({
                quality,
                url: dUrl,
                server: `${source} (Animepahe)`
              });
            }
          }
        }
      }
    }

    return {
      embed_url: topEmbed,
      servers: validServers,
      downloads,
      malId: malId ? parseInt(malId, 10) : null
    };
  } catch (err) {
    console.error(`Error resolving episode ${epNum} for show ${showId}:`, err.message);
    return null;
  }
}

export async function runAutoSync(maxShowsToSync = 20) {
  console.log(`[Auto-Sync] === Starting Anikoto 6-Hour Auto-Sync (Max: ${maxShowsToSync}) ===`);
  const db = loadDb();
  const recentItems = await fetchRecentlyUpdated(1);
  console.log(`[Auto-Sync] Discovered ${recentItems.length} updated anime candidates.`);

  let syncedEpisodesCount = 0;
  let newAnimeAddedCount = 0;
  const syncedDetails = [];

  for (const item of recentItems) {
    if (syncedEpisodesCount >= maxShowsToSync) break;

    let existing = db.by_show_id?.[item.showId] || db.by_slug?.[item.slug];

    // Automatically add newly released anime series to catalog
    if (!existing) {
      console.log(`[Auto-Sync] 🌟 New anime discovered: "${item.title}" (Show ID: ${item.showId})! Adding to catalog...`);
      existing = {
        show_id: Number(item.showId),
        slug: item.slug,
        title: item.title,
        jp_title: item.title,
        type: 'TV',
        anilist_id: null,
        mal_id: null,
        episodes: { sub: item.latestSub || 1, dub: item.latestDub || 0, total: null },
        watch_url: `https://anikototv.bz/watch/${item.slug}/ep-{ep}`,
        episode_counts: { sub: item.latestSub || 1, dub: item.latestDub || 0, total: item.latestSub || 1 },
        episodes_cache: {}
      };
      db.by_slug[item.slug] = existing;
      db.by_show_id[String(item.showId)] = existing;
      newAnimeAddedCount++;
    }

    // Update episode counts
    if (item.latestSub && (!existing.episode_counts || item.latestSub > (existing.episode_counts.sub || 0))) {
      if (!existing.episode_counts) existing.episode_counts = {};
      existing.episode_counts.sub = item.latestSub;
      if (item.latestDub) existing.episode_counts.dub = item.latestDub;
    }

    const targetEp = item.latestSub;
    if (!targetEp) continue;

    const cacheKey = `sub_${targetEp}`;
    const isAlreadyCached = existing.episodes_cache?.[cacheKey]?.embed_url;

    if (!isAlreadyCached) {
      console.log(`[Auto-Sync] ⚡ Syncing Ep ${targetEp} for: ${item.title} (Show ID: ${item.showId})...`);
      const resolved = await resolveEpisodeServers(item.showId, targetEp, 'sub');

      if (resolved && resolved.servers.length) {
        if (!existing.episodes_cache) existing.episodes_cache = {};
        existing.episodes_cache[cacheKey] = {
          embed_url: resolved.embed_url,
          servers: resolved.servers,
          headers: {
            'User-Agent': UA,
            'Referer': 'https://megaplay.buzz/'
          },
          cached_at: Date.now()
        };

        if (resolved.malId && !existing.mal_id) {
          existing.mal_id = resolved.malId;
          db.by_mal[String(resolved.malId)] = existing;
        }

        if (resolved.downloads.length && existing.anilist_id) {
          saveDownloadsToDb(existing.anilist_id, resolved.malId || existing.mal_id, item.title, targetEp, 'sub', resolved.downloads);
        }

        syncedEpisodesCount++;
        syncedDetails.push({
          title: item.title,
          showId: item.showId,
          episode: targetEp,
          serversCount: resolved.servers.length,
          downloadsCount: resolved.downloads.length
        });
        console.log(`[Auto-Sync]   ✓ Cached ${resolved.servers.length} servers & ${resolved.downloads.length} downloads for Ep ${targetEp}!`);
        await sleep(400);
      }
    }
  }

  saveDb(db);
  flushToDisk();
  console.log(`[Auto-Sync] === Completed: ${syncedEpisodesCount} episodes synced, ${newAnimeAddedCount} new anime cataloged ===`);

  return {
    status: 'success',
    timestamp: new Date().toISOString(),
    syncedEpisodesCount,
    newAnimeAddedCount,
    syncedDetails
  };
}

// If run directly from CLI
if (process.argv[1] && process.argv[1].endsWith('anikoto_auto_sync.js')) {
  runAutoSync(15).then(() => process.exit(0)).catch(e => {
    console.error('Auto-sync failed:', e);
    process.exit(1);
  });
}
