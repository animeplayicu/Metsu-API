import { getMedia } from "../core/anilist.js";

const BASE = "https://api.aniclover.cc";
const REFERER = "https://aniclover.cc/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function buildProxyUrl(url, ref = REFERER) {
  if (!url) return null;
  return `/proxy?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`;
}

export async function handleWatch(anilistId, audio = "sub", epNum = 1) {
  const idNum = Number(anilistId);
  const episodeNumber = Number(epNum);
  const lang = audio === "dub" ? "dub" : "sub";

  const targetUrl = `${BASE}/api/watch/${idNum}/${lang}/${episodeNumber}`;

  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": UA,
      Referer: REFERER,
      Origin: "https://aniclover.cc",
    },
  });

  if (!response.ok) {
    return json({ error: `AniClover returned HTTP ${response.status}` }, response.status);
  }

  const data = await response.json();
  if (!data || !data.success) {
    return json({ error: data?.message || "AniClover streams unavailable" }, 404);
  }

  const rawStreamUrl = data.streamUrl || data.streams?.[0]?.url || data.sources?.[0]?.file || null;
  if (!rawStreamUrl) {
    return json({ error: "AniClover response has no stream url" }, 404);
  }

  const proxiedStreamUrl = buildProxyUrl(rawStreamUrl, REFERER);

  // Process subtitles
  const rawSubs = Array.isArray(data.subtitles) && data.subtitles.length > 0 
    ? data.subtitles 
    : (Array.isArray(data.tracks) ? data.tracks.filter(t => t.kind === "captions" || t.kind === "subtitles") : []);

  const subtitles = rawSubs.map((s) => {
    const rawUrl = s.url || s.file || "";
    return {
      lang: s.lang || s.language || s.label || "English",
      label: s.label || s.lang || "English",
      url: rawUrl,
      proxied_url: buildProxyUrl(rawUrl, REFERER),
      kind: s.kind || "captions",
      default: Boolean(s.default),
    };
  });

  // Process thumbnails if present
  let thumbnails = null;
  if (data.thumbnails) {
    thumbnails = buildProxyUrl(data.thumbnails, REFERER);
  } else {
    const thumbTrack = data.tracks?.find(t => t.kind === "thumbnails");
    if (thumbTrack?.file) {
      thumbnails = buildProxyUrl(thumbTrack.file, REFERER);
    }
  }

  const serverName = data.server || data.provider || "HD1";

  const streams = [
    {
      server: serverName,
      type: "hls",
      quality: "1080p",
      url: rawStreamUrl,
      proxied_url: proxiedStreamUrl,
      headers: {
        Referer: REFERER,
        "User-Agent": UA,
      },
      subtitles,
      thumbnails,
    },
  ];

  return json({
    provider: "aniclover",
    anilistId: idNum,
    episode: episodeNumber,
    providerEpisode: episodeNumber,
    audio: lang,
    server: serverName,
    stream_url: rawStreamUrl,
    proxied_stream_url: proxiedStreamUrl,
    intro: data.intro || null,
    outro: data.outro || null,
    thumbnails,
    streams,
    subtitles,
  });
}

export async function handleStream(anilistId, audio, epNum) {
  const watchResp = await handleWatch(anilistId, audio, epNum);
  const data = await watchResp.json();
  const target = data.proxied_stream_url || data.stream_url;
  if (!target) return json({ error: "Stream not found" }, 404);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export async function getEpisodes(anilistId, ctx = {}) {
  const idNum = Number(anilistId);
  const media = ctx.media ?? await getMedia(idNum);
  const totalEp = media?.episodes ?? (media?.nextAiringEpisode?.episode ? media.nextAiringEpisode.episode - 1 : 12);

  const episodes = [];
  for (let i = 1; i <= Math.max(1, totalEp); i++) {
    episodes.push({
      id: `aniclover-${i}`,
      episode: i,
      title: `Episode ${i}`,
    });
  }

  return {
    provider: "aniclover",
    anilistId: idNum,
    totalEpisodes: episodes.length,
    episodes,
  };
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

    const path = new URL(request.url).pathname;
    try {
      let m = path.match(/^\/watch\/aniclover\/(\d+)\/(sub|dub|multi)\/(?:aniclover-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/aniclover\/(\d+)\/(sub|dub|multi)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/episodes\/aniclover\/(\d+)\/?$/);
      if (m) return json(await getEpisodes(Number(m[1])));

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, stack: error.stack }, 500);
    }
  },
};

