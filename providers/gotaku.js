import { getMedia } from "../core/anilist.js";
import { getAsync, setAsync, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const BASE = "https://gotaku.to";

// Fast in-memory resolution cache
const titleCache = new Map();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      ...extraHeaders,
    },
  });
}

async function searchGotaku(query) {
  if (!query || !query.trim()) return [];
  try {
    const res = await fetch(`${BASE}/api/v1/titles?q=${encodeURIComponent(query.trim())}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch {
    return [];
  }
}

async function resolveGotakuTitle(idOrAnilist, fallbackTitle = null) {
  const idStr = String(idOrAnilist).trim();

  // 1. Check in-memory Map
  if (titleCache.has(idStr)) {
    return titleCache.get(idStr);
  }

  // 2. Check smartcache
  const cacheKey = `gotaku:title:${idStr}`;
  const cached = await getAsync(cacheKey);
  if (cached && isFresh(cached)) {
    titleCache.set(idStr, cached.data);
    return cached.data;
  }

  // 3. If id is already a Gotaku ID (alphanumeric like 'gsrswx')
  if (!/^\d+$/.test(idStr)) {
    const directEntry = {
      gotaku_id: idStr,
      name: fallbackTitle || idStr,
      anilist_id: null,
      episodes: { sub: null, dub: null, total: null },
    };
    titleCache.set(idStr, directEntry);
    return directEntry;
  }

  // 4. Resolve via AniList ID and Gotaku live search
  let titleToSearch = fallbackTitle;
  let anilistMedia = null;

  try {
    anilistMedia = await getMedia(Number(idStr));
    titleToSearch = anilistMedia?.title?.english || anilistMedia?.title?.romaji || anilistMedia?.title?.userPreferred;
  } catch {}

  if (titleToSearch) {
    const results = await searchGotaku(titleToSearch);
    if (results.length > 0) {
      // Find best match: prefer exact match or main TV title
      const cleanSearch = titleToSearch.toLowerCase().replace(/[^a-z0-9]/g, "");
      let bestMatch = results[0];
      for (const item of results) {
        const cleanName = (item.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (cleanName === cleanSearch) {
          bestMatch = item;
          break;
        }
      }

      const entry = {
        gotaku_id: bestMatch.id,
        name: bestMatch.name,
        anilist_id: bestMatch.anilist_id || (anilistMedia ? anilistMedia.id : Number(idStr)),
        episodes: {
          sub: bestMatch.episodes?.latest_sub ?? null,
          dub: bestMatch.episodes?.latest_dub ?? null,
          total: bestMatch.episodes?.total ?? null,
        },
      };

      // Cache in memory and smartcache
      titleCache.set(idStr, entry);
      titleCache.set(entry.gotaku_id, entry);
      await setAsync(cacheKey, entry, SHOW_IDENTITY_TTL);
      return entry;
    }
  }

  return null;
}

export async function handleWatch(id, audio = "sub", ep = 1) {
  const epNum = Math.max(1, parseInt(ep, 10) || 1);
  const track = audio === "dub" ? "dub" : "sub";

  const entry = await resolveGotakuTitle(id);
  if (!entry) {
    return json({ error: `Anime not found on Gotaku for identifier: ${id}` }, 404);
  }

  const gotakuId = entry.gotaku_id;
  const embedUrl = `${BASE}/title/${gotakuId}?ep=${epNum}&track=${track}`;

  const availableSub = entry.episodes?.sub ?? null;
  const availableDub = entry.episodes?.dub ?? null;

  return json({
    provider: "gotaku",
    anilistId: entry.anilist_id,
    gotakuId: entry.gotaku_id,
    name: entry.name,
    episode: epNum,
    audio: track,
    embed_url: embedUrl,
    streams: [
      {
        name: "Gotaku Player",
        type: "embed",
        url: embedUrl,
        quality: "auto",
        track: track,
      },
    ],
    episodes: {
      sub: availableSub,
      dub: availableDub,
      total: entry.episodes?.total ?? Math.max(availableSub || 0, availableDub || 0),
    },
  });
}

export async function handleEmbedHtml(id, ep = 1, audio = "sub") {
  const watchResp = await handleWatch(id, audio, ep);
  const data = await watchResp.json();
  if (data.error) {
    return new Response(`<h3>${data.error}</h3>`, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.name} - Episode ${data.episode} (Gotaku Player)</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe
    src="${data.embed_url}"
    allowfullscreen="true"
    webkitallowfullscreen="true"
    mozallowfullscreen="true"
    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
    referrerpolicy="origin"
  ></iframe>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=600",
    },
  });
}

export async function getEpisodes(id) {
  const entry = await resolveGotakuTitle(id);
  if (!entry) {
    return json({ error: `Anime not found on Gotaku for identifier: ${id}` }, 404);
  }

  const maxEp = Math.max(
    entry.episodes?.sub || 0,
    entry.episodes?.dub || 0,
    entry.episodes?.total || 0,
    1
  );

  const episodes = [];
  for (let i = 1; i <= maxEp; i++) {
    episodes.push({
      id: `gotaku-${i}`,
      episode: i,
      title: `Episode ${i}`,
      has_sub: entry.episodes?.sub ? i <= entry.episodes.sub : true,
      has_dub: entry.episodes?.dub ? i <= entry.episodes.dub : false,
      embed: `${BASE}/title/${entry.gotaku_id}?ep=${i}`,
    });
  }

  return {
    provider: "gotaku",
    anilistId: entry.anilist_id,
    gotakuId: entry.gotaku_id,
    name: entry.name,
    totalEpisodes: episodes.length,
    episodes,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    try {
      let m = url.pathname.match(/^\/watch\/gotaku\/([a-zA-Z0-9_-]+)\/(sub|dub)\/(?:gotaku-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = url.pathname.match(/^\/watch\/gotaku\/([a-zA-Z0-9_-]+)\/(\d+)\/?$/);
      if (m) return await handleWatch(m[1], "sub", m[2]);

      m = url.pathname.match(/^\/embed\/gotaku\/([a-zA-Z0-9_-]+)\/(\d+)\/?$/);
      if (m) return await handleEmbedHtml(m[1], m[2], url.searchParams.get("audio") || "sub");

      m = url.pathname.match(/^\/episodes\/gotaku\/([a-zA-Z0-9_-]+)\/?$/);
      if (m) return json(await getEpisodes(m[1]));

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
