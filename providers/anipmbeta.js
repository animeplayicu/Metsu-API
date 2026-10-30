import { getMedia } from "../core/anilist.js";
import { getAsync, setAsync, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const SITE = "https://beta.cno.to";
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

function cleanSlug(str) {
  if (!str) return "";
  return str
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateSlugCandidates(media) {
  const candidates = new Set();

  const addCandidate = (val) => {
    if (!val) return;
    // 1. Without apostrophes (e.g. "Journey's" -> "journeys")
    const noApos = val.replace(/['’]/g, "");
    const slug1 = cleanSlug(noApos);
    if (slug1) candidates.add(slug1);

    // 2. Standard slugify (apostrophes turn into hyphens)
    const slug2 = cleanSlug(val);
    if (slug2) candidates.add(slug2);
  };

  // From AniList siteUrl if available
  if (media.siteUrl) {
    const parts = media.siteUrl.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart && !/^\d+$/.test(lastPart)) {
      addCandidate(lastPart);
    }
  }

  if (media.title?.english) addCandidate(media.title.english);
  if (media.title?.romaji) addCandidate(media.title.romaji);
  if (media.title?.userPreferred) addCandidate(media.title.userPreferred);

  if (Array.isArray(media.synonyms)) {
    for (const syn of media.synonyms) {
      addCandidate(syn);
    }
  }

  return [...candidates];
}

async function resolveSlug(anilistId, media) {
  const cacheKey = `match:anipmbeta:${anilistId}`;
  const cached = await getAsync(cacheKey);
  if (cached && isFresh(cached)) {
    return cached.data;
  }

  const candidates = generateSlugCandidates(media);

  for (const slug of candidates) {
    const epStr = "E0001";
    const testUrl = `${SITE}/hls/${anilistId}-${slug}/${epStr}/master.m3u8`;
    try {
      const res = await fetch(testUrl, {
        method: "HEAD",
        headers: {
          Referer: `${SITE}/`,
          "User-Agent": UA,
        },
      });
      if (res.status === 200) {
        await setAsync(cacheKey, slug, SHOW_IDENTITY_TTL);
        return slug;
      }
    } catch {}
  }

  // Fallback to first English or Romaji slug
  const fallback = cleanSlug(media.title?.english || media.title?.romaji || media.title?.userPreferred);
  return fallback;
}

function parseMasterPlaylist(manifestText) {
  const audios = [];
  const subtitles = [];
  const lines = manifestText.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;

    if (line.includes("TYPE=AUDIO")) {
      const name = line.match(/NAME="([^"]+)"/)?.[1] || "Default Audio";
      const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1] || "ja";
      audios.push({ name, language: lang });
    } else if (line.includes("TYPE=SUBTITLES")) {
      const name = line.match(/NAME="([^"]+)"/)?.[1] || "Default Subtitles";
      const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1] || "en";
      subtitles.push({ name, language: lang });
    }
  }

  return { audios, subtitles };
}

export async function handleWatch(anilistId, audio = "sub", epNum = 1) {
  const idNum = Number(anilistId);
  const episodeNumber = Number(epNum);
  const media = await getMedia(idNum);
  if (!media) return json({ error: `AniList ID ${anilistId} not found` }, 404);

  const slug = await resolveSlug(idNum, media);
  if (!slug) return json({ error: `Could not resolve slug for AniList ID ${anilistId}` }, 404);

  const epStr = `E${String(episodeNumber).padStart(4, "0")}`;
  const hlsUrl = `${SITE}/hls/${idNum}-${slug}/${epStr}/master.m3u8`;
  const embedUrl = `${SITE}/watch/${slug}-${idNum}/${episodeNumber}?lang=${audio}&embed=ani`;

  // Fetch master playlist to verify & extract audio / sub metadata
  let masterContent = "";
  let audios = [];
  let subtitles = [];

  try {
    const res = await fetch(hlsUrl, {
      headers: {
        Referer: `${SITE}/`,
        "User-Agent": UA,
      },
    });

    if (res.status === 200) {
      masterContent = await res.text();
      const meta = parseMasterPlaylist(masterContent);
      audios = meta.audios;
      subtitles = meta.subtitles;
    }
  } catch {}

  const proxiedStreamUrl = `/proxy?url=${encodeURIComponent(hlsUrl)}&ref=${encodeURIComponent(`${SITE}/`)}`;

  return json({
    provider: "anipmbeta",
    anilistId: idNum,
    episode: episodeNumber,
    providerEpisode: episodeNumber,
    audio,
    stream_url: hlsUrl,
    proxied_stream_url: proxiedStreamUrl,
    embed_url: embedUrl,
    intro: null,
    outro: null,
    streams: [
      {
        server: "anipmbeta-hls",
        type: "hls",
        quality: "1080p",
        url: hlsUrl,
        proxied_url: proxiedStreamUrl,
        headers: {
          Referer: `${SITE}/`,
          "User-Agent": UA,
        },
      },
    ],
    audio_tracks: audios.length > 0 ? audios : [
      { name: "Japanese", language: "ja" },
      { name: "English", language: "en" }
    ],
    subtitles: subtitles.length > 0 ? subtitles : [
      { name: "English", language: "en" }
    ],
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
      id: `anipmbeta-${i}`,
      episode: i,
      title: `Episode ${i}`,
    });
  }

  return {
    provider: "anipmbeta",
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
      // Supports /watch/anipmbeta/:id/:audio/:ep and /watch/anipmbeta/:id/:audio/anipmbeta-:ep
      let m = path.match(/^\/watch\/anipmbeta\/(\d+)\/(sub|dub|multi)\/(?:anipmbeta-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/anipmbeta\/(\d+)\/(sub|dub|multi)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/episodes\/anipmbeta\/(\d+)\/?$/);
      if (m) return json(await getEpisodes(Number(m[1])));

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, stack: error.stack }, 500);
    }
  },
};
