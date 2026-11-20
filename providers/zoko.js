import { getMedia } from "../core/anilist.js";

const BASE = "https://zokoanime.video";
const REFERER = "https://hianime.fm/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OBF_KEY = "otaku-embed-v1";

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

function buildProxyUrl(url, ref = "https://zokoanime.video/") {
  if (!url) return null;
  return `/proxy?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`;
}

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

function deobfuscate(blob) {
  return JSON.parse(decodeURIComponent(escape(xor(Buffer.from(blob, "base64").toString("binary")))));
}

async function resolveMalId(idOrAnilist, ctx = {}) {
  const idNum = Number(idOrAnilist);
  if (!idNum) return idOrAnilist;

  try {
    const media = ctx.media ?? (await getMedia(idNum));
    if (media?.idMal) return media.idMal;
  } catch {}

  return idNum;
}

export async function handleWatch(anilistOrMalId, audio = "sub", epNum = 1, ctx = {}) {
  const episodeNumber = Number(epNum) || 1;
  const lang = audio === "dub" ? "dub" : "sub";
  const malId = await resolveMalId(anilistOrMalId, ctx);

  const targetUrl = `${BASE}/stream/mal/${malId}/${episodeNumber}/${lang}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Referer: REFERER,
        Origin: "https://hianime.fm",
      },
    });

    if (!response.ok) {
      return json({ error: `HiAnime (Zoko) returned HTTP ${response.status}` }, response.status);
    }

    const html = await response.text();
    const match = html.match(/window\.__P\s*=\s*"([^"]+)"/);
    if (!match) {
      return json({ error: "Stream payload not found or episode unavailable" }, 404);
    }

    const payload = deobfuscate(match[1]);
    const rawStreamUrl = payload.src || null;
    if (!rawStreamUrl) {
      return json({ error: "HiAnime response has no stream url" }, 404);
    }

    const proxiedStreamUrl = buildProxyUrl(rawStreamUrl, BASE);

    // Process subtitles
    const subtitles = (Array.isArray(payload.subtitles) ? payload.subtitles : []).map((s) => {
      const rawUrl = s.src || s.url || "";
      return {
        lang: s.lang || "en",
        label: s.label || s.lang || "English",
        url: rawUrl,
        proxied_url: buildProxyUrl(rawUrl, BASE),
        default: Boolean(s.default),
      };
    });

    // Process thumbnails & poster
    const thumbnails = payload.sprite_vtt ? buildProxyUrl(payload.sprite_vtt, BASE) : null;
    const poster = payload.poster ? buildProxyUrl(payload.poster, BASE) : null;

    // Intro / Outro skips
    const intro = payload.skip?.intro ? { start: payload.skip.intro.start, end: payload.skip.intro.end } : null;
    const outro = payload.skip?.outro ? { start: payload.skip.outro.start, end: payload.skip.outro.end } : null;

    const streams = [
      {
        server: "Zoko HD",
        type: "hls",
        quality: "1080p",
        url: rawStreamUrl,
        proxied_url: proxiedStreamUrl,
        referer: `${BASE}/`,
        headers: {
          Referer: `${BASE}/`,
          "User-Agent": UA,
        },
        subtitles,
        thumbnails,
      },
    ];

    return json({
      provider: "zoko",
      anilistId: Number(anilistOrMalId) || null,
      malId,
      episode: episodeNumber,
      providerEpisode: episodeNumber,
      audio: lang,
      server: "Zoko HD",
      stream_url: rawStreamUrl,
      proxied_stream_url: proxiedStreamUrl,
      referer: `${BASE}/`,
      intro,
      outro,
      poster,
      sprite_vtt: payload.sprite_vtt || null,
      thumbnails,
      streams,
      subtitles,
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

export async function handleStream(anilistOrMalId, audio, epNum, ctx = {}) {
  const watchResp = await handleWatch(anilistOrMalId, audio, epNum, ctx);
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
  const media = ctx.media ?? (await getMedia(idNum));
  const malId = media?.idMal || idNum;
  const totalEp = media?.episodes ?? (media?.nextAiringEpisode?.episode ? media.nextAiringEpisode.episode - 1 : 12);

  const episodes = [];
  for (let i = 1; i <= Math.max(1, totalEp); i++) {
    episodes.push({
      id: `zoko-${i}`,
      episode: i,
      title: `Episode ${i}`,
    });
  }

  return {
    provider: "zoko",
    anilistId: idNum,
    malId,
    totalEpisodes: episodes.length,
    episodes,
  };
}

export default {
  async fetch(request, env) {
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
      let m = path.match(/^\/watch\/(?:zoko|hianime)\/(\d+)\/(sub|dub)\/(?:zoko-|hianime-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/watch\/(?:zoko|hianime)\/(\d+)\/(?:zoko-|hianime-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], "sub", m[2]);

      m = path.match(/^\/stream\/(?:zoko|hianime)\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/(?:zoko|hianime)\/(\d+)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], "sub", m[2]);

      m = path.match(/^\/episodes\/(?:zoko|hianime)\/(\d+)\/?$/);
      if (m) return json(await getEpisodes(Number(m[1])));

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, stack: error.stack }, 500);
    }
  },
};
