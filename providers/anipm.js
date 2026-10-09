import { getMedia } from "../core/anilist.js";
import { episodeMeta, titleScore, UA } from "../core/new-provider-utils.js";
import { extractMegaPlayDetails } from "../extractors/megaplay.js";
import { get as cacheGet, set as cacheSet, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const ANIPM_BASE = "https://ani.pm";
const ANIPM_API  = "https://ani.pm/api";

const HEADERS = {
  "User-Agent": UA,
  "Referer": `${ANIPM_BASE}/`,
  "Accept": "application/json, text/plain, */*",
};

async function fetchJSON(url, customHeaders = {}) {
  const res = await fetch(url, {
    headers: { ...HEADERS, ...customHeaders },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} fetching ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Resolves an anime show on ani.pm by AniList ID, with search fallback.
 */
export async function resolveAniPmShow(anilistId, ctx = {}) {
  const cacheKey = `anipm:show:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (isFresh(cached)) return cached.data;

  // 1. Direct AniList ID lookup
  try {
    const direct = await fetchJSON(`${ANIPM_API}/anime/ani/${anilistId}`);
    if (direct?.id && Array.isArray(direct?.episodes) && direct.episodes.length > 0) {
      const showData = {
        id: direct.id,
        settlarId: direct.settlarId || direct.settlarCanonicalId || direct.id,
        title: direct.title || direct.romaji || null,
        episodes: direct.episodes,
        malId: direct.malId ? Number(direct.malId) : null,
        source: "anilist",
        hasDub: Boolean(direct.hasDub),
      };
      cacheSet(cacheKey, showData, SHOW_IDENTITY_TTL);
      return showData;
    }
  } catch (err) {
    // 404 or not found — proceed to search fallback
  }

  // 2. Search fallback
  const media = ctx.media || await getMedia(anilistId).catch(() => null);
  const titles = [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms || []),
  ].filter(Boolean);

  if (!titles.length) {
    throw new Error(`AniPM: Unable to find title for AniList ID ${anilistId}`);
  }

  let bestCandidate = null;
  for (const title of titles.slice(0, 3)) {
    try {
      const searchRes = await fetchJSON(`${ANIPM_API}/anime/search?q=${encodeURIComponent(title)}`);
      const items = searchRes?.items || [];
      if (!items.length) continue;

      // Exact AniList or MAL ID match
      for (const item of items) {
        if (item.anilistId && String(item.anilistId) === String(anilistId)) {
          bestCandidate = item;
          break;
        }
        if (media?.idMal && item.malId && Number(item.malId) === Number(media.idMal)) {
          bestCandidate = item;
          break;
        }
      }
      if (bestCandidate) break;

      // Score-based candidate matching
      let highestScore = 0;
      let matchedItem = null;
      for (const item of items) {
        const score = titleScore(title, item.title, item.slug || "");
        if (score > highestScore && score >= 0.5) {
          highestScore = score;
          matchedItem = item;
        }
      }
      if (matchedItem) {
        bestCandidate = matchedItem;
        break;
      }
    } catch {}
  }

  if (!bestCandidate?.id) {
    throw new Error(`AniPM: No matching anime found on ani.pm for AniList ${anilistId}`);
  }

  // Fetch full series episode list
  const series = await fetchJSON(`${ANIPM_API}/anime/series/${bestCandidate.id}`);
  if (!Array.isArray(series?.episodes) || !series.episodes.length) {
    throw new Error(`AniPM: No episodes found for series ID ${bestCandidate.id}`);
  }

  const showData = {
    id: bestCandidate.id,
    settlarId: bestCandidate.id,
    title: series.title || bestCandidate.title,
    episodes: series.episodes,
    malId: series.malId || bestCandidate.malId ? Number(series.malId || bestCandidate.malId) : null,
    source: "settlar",
    hasDub: Boolean(series.hasDub),
  };

  cacheSet(cacheKey, showData, SHOW_IDENTITY_TTL);
  return showData;
}

/**
 * Returns episode list mapped for Anivexa-API core.
 */
export async function getEpisodes(anilistId, ctx = {}) {
  const show = await resolveAniPmShow(anilistId, ctx);
  const items = show.episodes || [];

  if (!items.length) {
    throw new Error(`AniPM: No episodes available for AniList ID ${anilistId}`);
  }

  const sub = [];
  const dub = [];

  for (const item of items) {
    const num = Number(item.number);
    if (!Number.isFinite(num)) continue;

    const meta = episodeMeta(num, ctx);
    const title = item.title || meta.title || `Episode ${num}`;
    const duration = item.runtime || meta.duration || (item.runtimeSeconds ? Math.round(item.runtimeSeconds / 60) : null);
    const description = item.description || meta.description || null;
    const filler = Boolean(meta.filler);
    const recap = Boolean(meta.recap);

    let image = meta.image || null;
    if (item.thumbnail) {
      image = item.thumbnail.startsWith("http") ? item.thumbnail : `${ANIPM_BASE}${item.thumbnail}`;
    }

    const airDate = item.aired || meta.airDate || null;

    const base = {
      number: num,
      title,
      duration,
      filler,
      recap,
      uncensored: false,
      description,
      image,
      airDate,
    };

    if (item.sub !== false) {
      sub.push({
        id: `watch/anipm/${anilistId}/sub/anipm-${num}`,
        ...base,
        audio: "sub",
      });
    }

    if (item.dub === true || show.hasDub) {
      dub.push({
        id: `watch/anipm/${anilistId}/dub/anipm-${num}`,
        ...base,
        audio: "dub",
      });
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: show.title || ctx.media?.title?.english || ctx.media?.title?.romaji || null,
      malId: show.malId || ctx.media?.idMal || null,
      source: "anipm",
      settlarId: show.settlarId,
    },
    episodes: { sub, dub },
  };
}

/**
 * Watch handler: resolves playback stream from ani.pm + megaplay.buzz.
 */
export async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub" && audio !== "dub") {
    return jsonResponse({ error: "audio must be 'sub' or 'dub'" }, 400);
  }

  const show = await resolveAniPmShow(anilistId, ctx);
  const targetEp = (show.episodes || []).find((e) => Number(e.number) === Number(epNum));

  if (!targetEp) {
    return jsonResponse({ error: `AniPM: Episode ${epNum} not found` }, 404);
  }

  if (audio === "dub" && targetEp.dub === false && !show.hasDub) {
    return jsonResponse({ error: `AniPM: Dub not available for episode ${epNum}` }, 404);
  }

  const routeId = targetEp.routeId || `e${epNum}`;

  // Call playback-bootstrap on ani.pm
  let pbData = null;
  const pbEndpoints = [];

  if (show.source === "anilist") {
    pbEndpoints.push(`${ANIPM_API}/anime/playback-bootstrap/anilist/${anilistId}?ep=${encodeURIComponent(routeId)}&lang=${audio}&backup=1`);
  }
  if (show.settlarId) {
    pbEndpoints.push(`${ANIPM_API}/anime/playback-bootstrap/settlar/${show.settlarId}?ep=${encodeURIComponent(routeId)}&lang=${audio}&backup=1`);
  }

  for (const endpoint of pbEndpoints) {
    try {
      pbData = await fetchJSON(endpoint);
      if (pbData?.backupEmbed?.available || pbData?.settlarSelection) break;
    } catch {}
  }

  if (!pbData) {
    return jsonResponse({ error: `AniPM: Failed to retrieve playback bootstrap for episode ${epNum}` }, 502);
  }

  const streams   = [];
  const subtitles = [];
  const subSeen   = new Set();

  let intro = { start: 0, end: 0 };
  let outro = { start: 0, end: 0 };

  // Skip timestamps from ani.pm playback data if available
  if (pbData.skip?.op?.start || pbData.skip?.op?.end) {
    intro = {
      start: Math.round(Number(pbData.skip.op.start) || 0),
      end:   Math.round(Number(pbData.skip.op.end) || 0),
    };
  }
  if (pbData.skip?.ed?.start || pbData.skip?.ed?.end) {
    outro = {
      start: Math.round(Number(pbData.skip.ed.start) || 0),
      end:   Math.round(Number(pbData.skip.ed.end) || 0),
    };
  }

  // 1. Extract from backupEmbed (MegaPlay)
  const embedUrl = pbData.backupEmbed?.url;
  if (embedUrl) {
    try {
      const extracted = await extractMegaPlayDetails(embedUrl);
      const hlsSources = (extracted?.sources || []).filter((s) => s.url);

      if (extracted?.intro?.start || extracted?.intro?.end) {
        if (!intro.start && !intro.end) {
          intro = { start: Number(extracted.intro.start) || 0, end: Number(extracted.intro.end) || 0 };
        }
      }
      if (extracted?.outro?.start || extracted?.outro?.end) {
        if (!outro.start && !outro.end) {
          outro = { start: Number(extracted.outro.start) || 0, end: Number(extracted.outro.end) || 0 };
        }
      }

      // Collect subtitles
      for (const tr of extracted?.tracks || []) {
        if (!tr.file) continue;
        const mappedSub = {
          url: tr.file,
          label: tr.label || "English",
          srclang: (tr.label || "en").toLowerCase().slice(0, 2),
          default: Boolean(tr.default),
        };
        if (!subSeen.has(mappedSub.url)) {
          subSeen.add(mappedSub.url);
          subtitles.push(mappedSub);
        }
      }

      // Add HLS streams
      const ref = extracted?.origin ? `${extracted.origin}/` : "https://megaplay.buzz/";
      for (const src of hlsSources) {
        streams.push({
          url: src.url,
          proxied_url: `/proxy?url=${encodeURIComponent(src.url)}&ref=${encodeURIComponent(ref)}`,
          type: "hls",
          server: "MegaPlay",
          embedUrl,
          referer: ref,
          subtitles,
          priority: streams.length === 0 ? 5 : 4,
          isActive: streams.length === 0,
          intro: intro.start || intro.end ? intro : undefined,
          outro: outro.start || outro.end ? outro : undefined,
        });
      }

      // Add fallback embed player
      streams.push({
        url: embedUrl,
        type: "embed",
        server: "MegaPlay (Embed)",
        referer: "https://megaplay.buzz/",
        priority: 3,
        isActive: false,
      });
    } catch (err) {
      console.error(`[anipm:megaplay] Extraction error:`, err.message);
      // Fallback: raw embed URL
      streams.push({
        url: embedUrl,
        type: "embed",
        server: "MegaPlay (Embed)",
        referer: "https://megaplay.buzz/",
        priority: 4,
        isActive: streams.length === 0,
      });
    }
  }

  // 2. Settlar Session Embed fallback
  if (pbData.settlarSelection) {
    try {
      const sessParams = new URLSearchParams({
        selection: pbData.settlarSelection,
        provider: "anipm",
        ep: String(targetEp.number),
        channel: audio,
        telemetry: "0",
      });
      const sessData = await fetchJSON(`${ANIPM_API}/anime/settlar/session?${sessParams.toString()}`);
      if (sessData?.embedUrl) {
        streams.push({
          url: sessData.embedUrl,
          type: "embed",
          server: "Settlar (Embed)",
          referer: `${ANIPM_BASE}/`,
          priority: 2,
          isActive: streams.length === 0,
        });
      }
    } catch {}
  }

  if (!streams.length) {
    return jsonResponse({ error: `AniPM: No playable streams found for episode ${epNum}` }, 404);
  }

  const topStream = streams.find((s) => s.type === "hls") || streams[0];

  return jsonResponse({
    anilistId: parseInt(anilistId),
    malId: show.malId ? Number(show.malId) : null,
    episode: Number(epNum),
    audio,
    stream_url: topStream?.url || null,
    proxied_stream_url: topStream?.proxied_url || topStream?.url || null,
    intro,
    outro,
    streams,
    subtitles,
    downloads: [],
    headers: {
      "User-Agent": UA,
      "Referer": topStream?.referer || `${ANIPM_BASE}/`,
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleStream(anilistId, audio, epNum) {
  const watchResp = await handleWatch(anilistId, audio, epNum);
  const data = await watchResp.json();
  const target = data.proxied_stream_url || data.stream_url;
  if (!target) return jsonResponse({ error: "Stream not found" }, 404);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": target,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
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

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let m = path.match(/^\/watch\/anipm\/(\d+)\/(sub|dub)\/anipm-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/anipm\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/episodes\/anipm\/(\d+)\/?$/);
      if (m) {
        const eps = await getEpisodes(m[1]);
        return jsonResponse(eps);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message, stack: err.stack }, 500);
    }
  },
};
