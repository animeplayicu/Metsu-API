import {
  json,
  episodeMeta,
  buildTitles,
  diceCoeff,
  fetchHtml
} from "../core/new-provider-utils.js";
import { getMedia } from "../core/anilist.js";
import {
  get as cacheGet,
  set as cacheSet,
  isFresh,
  SHOW_IDENTITY_TTL,
  WATCH_TTL
} from "../core/smartcache.js";
import { canExtractRavok, extractRavok } from "../extractors/ravok.js";
import { canExtractBlakite, extractBlakite } from "../extractors/blakite.js";
import { canExtractRubystm, extractRubystm } from "../extractors/rubystm.js";
import { canExtractVidmoly, extractVidmoly } from "../extractors/vidmoly.js";

const BASE = "https://piratexplay.cc";

/**
 * Resolves an AniList ID to PirateXPlay series/movie slug and season.
 */
export async function resolveShow(anilistId, ctx = {}) {
  const cacheKey = `np:piratexplay:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (isFresh(cached)) return cached.data;

  // 1. Ensure AniZip mappings are present in ctx
  if (!ctx.anizip) {
    ctx.anizip = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`).then(r => r.json()).catch(() => null);
  }

  // Fetch TMDB ID from anizip or fallback to ARM API
  let tmdbId = ctx.anizip?.mappings?.themoviedb_id ? String(ctx.anizip.mappings.themoviedb_id) : null;
  let tmdbSeason = null;

  if (!tmdbId) {
    const armRes = await fetch(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${anilistId}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    }).then(r => r.json()).catch(() => null);
    if (armRes?.themoviedb) tmdbId = String(armRes.themoviedb);
    if (armRes?.["themoviedb-season"] != null) tmdbSeason = String(armRes["themoviedb-season"]);
  }

  let matched = null;

  // 2. Fast path: if TMDB ID is known, search directly by TMDB ID
  if (tmdbId) {
    const searchUrl = `${BASE}/api/search.php/?keyword=${encodeURIComponent(tmdbId)}&page=1`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json"
      }
    }).then(r => r.json()).catch(() => null);

    const items = searchRes?.data || [];
    matched = items.find(d => {
      const url = d.tmdb?.url || "";
      return url.endsWith(`-${tmdbId}`) || url.includes(`-${tmdbId}-`);
    });
  }

  // 3. Fallback: title search if TMDB ID search yielded nothing
  if (!matched) {
    const media = ctx.media || await getMedia(anilistId).catch(() => null);
    const titles = buildTitles(media, ctx.anizip);

    for (const title of titles.slice(0, 3)) {
      if (!title) continue;
      const searchUrl = `${BASE}/api/search.php/?keyword=${encodeURIComponent(title)}&page=1`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json"
        }
      }).then(r => r.json()).catch(() => null);

      const items = searchRes?.data || [];
      if (!items.length) continue;

      if (tmdbId) {
        matched = items.find(d => {
          const url = d.tmdb?.url || "";
          return url.endsWith(`-${tmdbId}`) || url.includes(`-${tmdbId}-`);
        });
        if (matched) break;
      }

      let best = null;
      let bestScore = 0;
      for (const item of items) {
        const itemTitle = item.tmdb?.title || "";
        const score = diceCoeff(title, itemTitle);
        if (score > bestScore && score >= 0.6) {
          bestScore = score;
          best = item;
        }
      }
      if (best) {
        matched = best;
        break;
      }
    }
  }

  if (!matched || !matched.tmdb?.url) {
    throw new Error(`PirateXPlay: show not found for AniList ${anilistId}`);
  }

  const showData = {
    tmdbId,
    type: matched.tmdb.type || "series",
    slug: matched.tmdb.url,
    season: tmdbSeason
  };

  cacheSet(cacheKey, showData, SHOW_IDENTITY_TTL);
  return showData;
}

/**
 * Extracts episodes list for an anime.
 */
export async function getEpisodes(anilistId, ctx = {}) {
  if (!ctx.anizip) {
    ctx.anizip = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`).then(r => r.json()).catch(() => null);
  }
  const show = await resolveShow(anilistId, ctx);
  const multi = [];

  if (show.type === "movie") {
    const meta = episodeMeta(1, ctx);
    multi.push({
      id: `watch/piratexplay/${anilistId}/multi/piratexplay-movie-${show.slug}`,
      number: 1,
      title: meta.title || "Movie",
      duration: meta.duration,
      audio: "multi",
      filler: false,
      recap: false,
      uncensored: false,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate
    });
  } else {
    let seriesUrl = `${BASE}/series/${show.slug}/`;
    let html = await fetchHtml(seriesUrl);

    // Determine target season from show.season or AniZip
    let targetSeason = show.season || null;
    const anizipEps = ctx.anizip?.episodes;
    if (!targetSeason && anizipEps) {
      targetSeason = anizipEps["1"]?.seasonNumber || null;
    }
    if (!targetSeason) targetSeason = 1;

    // Flexible season parser (handles multiline tags, class variations, etc.)
    for (const m of html.matchAll(/<a\b([\s\S]*?)>/gi)) {
      const tag = m[1];
      const sMatch = tag.match(/data-season=["'](\d+)["']/i);
      const hMatch = tag.match(/href=["']([^"']+)["']/i);
      const isAct = /active/i.test(tag.match(/class=["']([^"']+)["']/i)?.[1] || "");
      if (sMatch && hMatch && String(sMatch[1]) === String(targetSeason) && !isAct) {
        const fullSeasonUrl = hMatch[1].startsWith("http") ? hMatch[1] : `${BASE}${hMatch[1]}`;
        const seasonHtml = await fetchHtml(fullSeasonUrl).catch(() => null);
        if (seasonHtml) html = seasonHtml;
        break;
      }
    }

    // Parse episodes from episode list
    const epRegex = /<article\s+class="[^"]*episodes[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<a\s+[^>]*href="([^"]+)"/gi;
    let match;
    const parsedEps = [];

    while ((match = epRegex.exec(html)) !== null) {
      const epHref = match[3];
      const epSlugMatch = epHref.match(/\/episode\/([^/]+)\/?/);
      const epSlug = epSlugMatch ? epSlugMatch[1] : null;
      if (!epSlug) continue;

      const numMatch = epSlug.match(/-(\d+)x(\d+)$/);
      const seasonNum = numMatch ? parseInt(numMatch[1], 10) : 1;
      const epNum = numMatch ? parseInt(numMatch[2], 10) : parsedEps.length + 1;

      parsedEps.push({
        seasonNum,
        epNum,
        title: match[2] || `Episode ${epNum}`,
        image: match[1] || null,
        epSlug
      });
    }

    parsedEps.sort((a, b) => a.epNum - b.epNum);

    // Sync with AniZip episode mapping if available
    let mappedCount = 0;

    if (anizipEps && Object.keys(anizipEps).length > 0) {
      for (const [alEpStr, azEp] of Object.entries(anizipEps)) {
        if (!/^\d+$/.test(alEpStr)) continue;
        const alEpNum = parseInt(alEpStr, 10);
        if (!Number.isFinite(alEpNum)) continue;

        const targetEpNum = azEp?.episodeNumber ?? alEpNum;
        const targetSeasonNum = azEp?.seasonNumber;

        const matchedEp = parsedEps.find(p => {
          if (targetSeasonNum && p.seasonNum && p.seasonNum !== targetSeasonNum) return false;
          return p.epNum === targetEpNum;
        });

        if (matchedEp) {
          mappedCount++;
          const meta = episodeMeta(alEpNum, ctx);
          const title = meta.title || matchedEp.title || `Episode ${alEpNum}`;

          multi.push({
            id: `watch/piratexplay/${anilistId}/multi/piratexplay-${alEpNum}`,
            number: alEpNum,
            title,
            duration: meta.duration,
            audio: "multi",
            filler: meta.filler || false,
            recap: false,
            uncensored: false,
            description: meta.description,
            image: matchedEp.image || meta.image,
            airDate: meta.airDate,
            epSlug: matchedEp.epSlug
          });
        }
      }
    }

    // Fallback: if AniZip mapping not present or didn't match, map parsed episodes directly
    if (mappedCount === 0) {
      for (const ep of parsedEps) {
        const meta = episodeMeta(ep.epNum, ctx);
        const title = ep.title || meta.title || `Episode ${ep.epNum}`;

        multi.push({
          id: `watch/piratexplay/${anilistId}/multi/piratexplay-${ep.epNum}`,
          number: ep.epNum,
          title,
          duration: meta.duration,
          audio: "multi",
          filler: meta.filler || false,
          recap: false,
          uncensored: false,
          description: meta.description,
          image: ep.image || meta.image,
          airDate: meta.airDate,
          epSlug: ep.epSlug
        });
      }
    }
  }

  const sub = multi.map(e => ({
    ...e,
    id: `watch/piratexplay/${anilistId}/sub/piratexplay-${e.number}`,
    audio: "sub"
  }));
  const dub = multi.map(e => ({
    ...e,
    id: `watch/piratexplay/${anilistId}/dub/piratexplay-${e.number}`,
    audio: "dub"
  }));

  return {
    meta: {
      title: ctx.media?.title?.english ?? ctx.media?.title?.romaji ?? null,
      tmdbId: show.tmdbId,
      source: "piratexplay"
    },
    episodes: {
      sub,
      dub,
      multi
    }
  };
}

/**
 * Extracts streams/embeds from the episode page.
 */
export async function handleWatch(anilistId, audio, epParam, ctx = {}) {
  let epSlug = epParam;
  let resolvedEpNum = null;

  // If epParam is a simple episode number (e.g. 1, 2, 25), resolve its real slug
  if (/^\d+$/.test(epParam)) {
    const targetNum = parseInt(epParam, 10);
    resolvedEpNum = targetNum;
    try {
      const epsData = await getEpisodes(anilistId, ctx);
      const list = epsData.episodes?.multi || epsData.episodes?.sub || [];
      const found = list.find(e => e.number === targetNum);
      if (found?.epSlug) {
        epSlug = found.epSlug;
      } else {
        const show = await resolveShow(anilistId, ctx);
        epSlug = `${show.slug}-${show.season || 1}x${targetNum}`;
      }
    } catch {}
  }
  let pageUrl = epSlug.startsWith("movie-")
    ? `${BASE}/movies/${epSlug.replace(/^movie-/, "")}/`
    : `${BASE}/episode/${epSlug}/`;

  const html = await fetchHtml(pageUrl);
  if (!html) {
    return json({ error: "PirateXPlay: episode page fetch failed" }, 500);
  }

  // Parse server names from buttons
  const serverMap = {};
  const serverRegex = /href="#(options-\d+)"[^>]*>[\s\S]*?<span class="server">([^<]+)<\/span>/g;
  let sMatch;
  while ((sMatch = serverRegex.exec(html)) !== null) {
    serverMap[sMatch[1]] = sMatch[2].trim();
  }

  // Parse iframes
  const iframeRegex = /<div\s+id="(options-\d+)"[^>]*>[\s\S]*?<iframe[^>]+?(?:src|data-src)="([^"]+)"/gi;
  const streams = [];
  let iMatch;

  while ((iMatch = iframeRegex.exec(html)) !== null) {
    const optId = iMatch[1];
    let streamUrl = iMatch[2];
    if (streamUrl.startsWith("//")) streamUrl = `https:${streamUrl}`;

    // Decode URL if necessary
    if (streamUrl.startsWith("https%3A%2F%2F") || streamUrl.startsWith("http%3A%2F%2F")) {
      try {
        streamUrl = decodeURIComponent(streamUrl);
      } catch {}
    }

    const serverName = serverMap[optId] || `Server ${streams.length + 1}`;

    streams.push({
      url: streamUrl,
      type: "embed",
      server: serverName,
      referer: `${BASE}/`,
      priority: streams.length === 0 ? 5 : 3,
      isActive: streams.length === 0
    });

    // If proxy/play.php has direct target in param, add as helper
    if (streamUrl.includes("proxy/play.php?url=")) {
      try {
        const u = new URL(streamUrl);
        const directUrl = u.searchParams.get("url");
        if (directUrl) {
          streams.push({
            url: directUrl,
            type: "embed",
            server: `${serverName} (Direct)`,
            referer: `${BASE}/`,
            priority: 4,
            isActive: false
          });
        }
      } catch {}
    }

    // If proxy/multi.php has base64 data parameter, decode and add languages
    if (streamUrl.includes("proxy/multi.php?data=")) {
      try {
        const u = new URL(streamUrl);
        const dataParam = u.searchParams.get("data");
        if (dataParam) {
          const decoded = JSON.parse(Buffer.from(dataParam, "base64").toString("utf-8"));
          if (Array.isArray(decoded)) {
            for (const item of decoded) {
              if (item.link) {
                streams.push({
                  url: item.link,
                  type: "embed",
                  server: `${serverName} (${item.language || "Audio"})`,
                  referer: `${BASE}/`,
                  priority: 4,
                  isActive: false
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  // Extract direct media streams (HLS m3u8 & MP4) from candidate servers
  const directStreams = await extractDirectMediaStreams(streams);

  // Combine direct media streams first, then embed fallbacks
  const allStreams = [...directStreams, ...streams];

  if (!allStreams.length) {
    return json({ error: "PirateXPlay: no streams found for episode" }, 404);
  }

  // Sort: direct streams (HLS / MP4) first, prioritized by resolution / server quality
  allStreams.sort((a, b) => {
    const isDirectA = a.type === "hls" || a.type === "mp4" ? 1 : 0;
    const isDirectB = b.type === "hls" || b.type === "mp4" ? 1 : 0;
    if (isDirectA !== isDirectB) return isDirectB - isDirectA;
    return (b.priority || 0) - (a.priority || 0);
  });

  // Deduplicate streams by URL
  const seenUrls = new Set();
  const uniqueStreams = [];
  for (const s of allStreams) {
    if (!seenUrls.has(s.url)) {
      seenUrls.add(s.url);
      uniqueStreams.push(s);
    }
  }

  uniqueStreams.forEach((s, idx) => {
    s.isActive = idx === 0;
  });

  const topStream = uniqueStreams.find(s => s.type === "hls" || s.type === "mp4") || uniqueStreams[0];

  const numMatch = epSlug.match(/-(\d+)x(\d+)$/);
  const epNum = resolvedEpNum || (numMatch ? parseInt(numMatch[2], 10) : 1);

  return new Response(
    JSON.stringify(
      {
        anilistId: Number(anilistId),
        episode: epNum,
        audio,
        stream_url: topStream?.url || null,
        proxied_stream_url: topStream?.proxied_url || topStream?.url || null,
        stream_type: topStream?.type || "embed",
        streams: uniqueStreams
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      }
    }
  );
}

/**
 * Extracts direct HLS (.m3u8) and MP4 video streams from candidate embed links.
 */
async function extractDirectMediaStreams(streams) {
  const directStreams = [];
  const tasks = [];

  for (const item of streams) {
    const rawUrl = item.url;

    if (canExtractBlakite(rawUrl)) {
      tasks.push(
        extractBlakite(rawUrl)
          .then(res => {
            if (res?.streams?.length) {
              for (const s of res.streams) {
                directStreams.push({
                  url: s.url,
                  type: s.type, // "hls" or "mp4"
                  quality: s.quality,
                  server: `Blakite - ${s.quality} (${s.type.toUpperCase()})`,
                  referer: "https://hugh.cdn.rumble.cloud/",
                  priority: s.quality === "1080p" ? 7 : (s.quality === "720p" ? 6 : 5),
                  isActive: false
                });
              }
            }
          })
          .catch(() => null)
      );
    } else if (canExtractRavok(rawUrl)) {
      tasks.push(
        extractRavok(rawUrl)
          .then(res => {
            if (res?.streamUrl) {
              directStreams.push({
                url: res.streamUrl,
                proxied_url: `/proxy?url=${encodeURIComponent(res.streamUrl)}&ref=${encodeURIComponent("https://ravok.buzz/")}`,
                type: "hls",
                server: `${item.server} (Direct Master HLS)`,
                poster: res.poster || null,
                referer: "https://ravok.buzz/",
                priority: 5,
                isActive: false
              });
            }
          })
          .catch(() => null)
      );
    } else if (canExtractRubystm(rawUrl)) {
      tasks.push(
        extractRubystm(rawUrl)
          .then(res => {
            if (res?.streamUrl) {
              directStreams.push({
                url: res.streamUrl,
                proxied_url: `/proxy?url=${encodeURIComponent(res.streamUrl)}&ref=${encodeURIComponent("https://rubystm.com/")}`,
                type: "hls",
                server: `${item.server} (Direct HLS)`,
                referer: "https://rubystm.com/",
                priority: 4,
                isActive: false
              });
            }
          })
          .catch(() => null)
      );
    } else if (canExtractVidmoly(rawUrl)) {
      tasks.push(
        extractVidmoly(rawUrl)
          .then(res => {
            const streamList = res?.streams || (Array.isArray(res) ? res.map(u => ({ url: u, quality: "auto" })) : []);
            const audios = res?.audios || [];
            const hasMultiAudio = audios.length > 1;

            for (const s of streamList) {
              const isMaster = s.isMaster || s.quality === "auto";
              let label = isMaster ? (hasMultiAudio ? "Multi-Audio Master" : "Adaptive Master") : s.quality;

              directStreams.push({
                url: s.url,
                proxied_url: `/proxy?url=${encodeURIComponent(s.url)}&ref=${encodeURIComponent("https://vidmoly.biz/")}`,
                type: "hls",
                quality: s.quality,
                server: `${item.server} - ${label}`,
                audios: isMaster ? audios : [],
                referer: "https://vidmoly.biz/",
                priority: isMaster ? (hasMultiAudio ? 6 : 5) : 4,
                isActive: false
              });
            }
          })
          .catch(() => null)
      );
    }
  }

  await Promise.allSettled(tasks);
  return directStreams;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let m = path.match(/^\/watch\/piratexplay\/(\d+)\/(sub|dub|multi)\/piratexplay-(.+)\/?$/);
      if (m) {
        return await handleWatch(m[1], m[2], m[3]);
      }

      m = path.match(/^\/episodes\/piratexplay\/(\d+)\/?$/);
      if (m) {
        const eps = await getEpisodes(m[1]);
        return json(eps);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  }
};
