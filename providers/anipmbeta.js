import fs from "fs";
import path from "path";
import { getMedia } from "../core/anilist.js";
import { getAsync, setAsync, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import proxyHandler from "../proxy/_worker.js";

const SITE = "https://beta.cno.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DATA_FILE = path.join(process.cwd(), "data", "anipmbeta_library.json");

const LANG_NAMES = {
  jpn: "Japanese",
  ja: "Japanese",
  eng: "English",
  en: "English",
  fre: "French",
  fr: "French",
  ger: "German",
  de: "German",
  ita: "Italian",
  it: "Italian",
  spa: "Spanish",
  es: "Spanish",
  por: "Portuguese",
  pt: "Portuguese",
  rus: "Russian",
  ru: "Russian",
  ara: "Arabic",
  ar: "Arabic",
  chi: "Chinese",
  zh: "Chinese",
  kor: "Korean",
  ko: "Korean",
  ind: "Indonesian",
  id: "Indonesian",
  tha: "Thai",
  th: "Thai",
  vie: "Vietnamese",
  vi: "Vietnamese",
  pol: "Polish",
  pl: "Polish",
  may: "Malay",
  ms: "Malay",
};

function formatLangName(code) {
  return LANG_NAMES[code?.toLowerCase()] || code?.toUpperCase() || "Default";
}

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

/**
 * Low-RAM On-Demand Disk Search:
 * Scans local file for the single requested AniList ID without holding 5MB in memory.
 * Memory is immediately freed by V8 garbage collection.
 */
function lookupOnDisk(anilistId) {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const content = fs.readFileSync(DATA_FILE, "utf8");
    const needle = `"id":${anilistId},`;
    const idx = content.indexOf(needle);
    if (idx === -1) return null;

    const slice = content.slice(idx, idx + 1200);
    const folder = slice.match(/"folder":"([^"]+)"/)?.[1];
    const epsStr = slice.match(/"eps":\[([^\]]+)\]/)?.[1];
    const eps = epsStr ? epsStr.split(",").map(Number) : [];

    // Extract audio and subs arrays if present
    const audioMatch = slice.match(/"audio":\[([^\]]+)\]/)?.[1];
    const audio = audioMatch ? audioMatch.split(",").map((s) => s.replace(/"/g, "").trim()) : [];

    const subsMatch = slice.match(/"subs":\[([^\]]+)\]/)?.[1];
    const subs = subsMatch ? subsMatch.split(",").map((s) => s.replace(/"/g, "").trim()) : [];

    return folder ? { folder, eps, audio, subs } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch from Cloudflare Global CDN (6-hour Edge Cache, 0 VPS RAM):
 * Cloudflare Edge CDN caches the library for 21600s and returns only the single anime metadata (~150 bytes).
 */
async function fetchFromCloudflareCdn(anilistId) {
  try {
    const cdnUrl = `http://127.0.0.1:${process.env.PORT || 3020}/proxy/cno-library?id=${anilistId}`;
    const res = await fetch(cdnUrl, {
      headers: { "User-Agent": UA },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.folder) return data;
    }
  } catch {}
  return null;
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
    const noApos = val.replace(/['’]/g, "");
    const slug1 = cleanSlug(noApos);
    if (slug1) candidates.add(slug1);

    const slug2 = cleanSlug(val);
    if (slug2) candidates.add(slug2);
  };

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

/**
 * Zero-RAM Resolution:
 * 1. SmartCache disk file (.cache/ - 100 bytes per anime)
 * 2. On-demand local disk scan (transient, no RAM held)
 * 3. Cloudflare Edge CDN (6-hour edge cache)
 */
async function resolveMediaFolder(anilistId, media) {
  const idNum = Number(anilistId);

  // 1. SmartCache disk file check (persisted tiny 100-byte JSON, 0 RAM)
  const cacheKey = `match:anipmbeta_meta:${idNum}`;
  const cached = await getAsync(cacheKey);
  if (cached && isFresh(cached) && cached.data?.folder) {
    return { folder: cached.data.folder, lib: cached.data };
  }

  // 2. On-demand local disk file lookup (reads only when needed, frees memory immediately)
  let entry = lookupOnDisk(idNum);

  // 3. Cloudflare Global CDN fallback (6-hour cached at edge)
  if (!entry) {
    entry = await fetchFromCloudflareCdn(idNum);
  }

  if (entry && entry.folder) {
    // Cache the single 100-byte result on disk (6 hours = 21600s)
    await setAsync(cacheKey, entry, 21600);
    return { folder: entry.folder, lib: entry };
  }

  // 4. Fallback: Probing candidates with HEAD request
  if (media) {
    const candidates = generateSlugCandidates(media);
    for (const slug of candidates) {
      const epStr = "E0001";
      const testUrl = `${SITE}/hls/${idNum}-${slug}/${epStr}/master.m3u8`;
      try {
        const res = await fetch(testUrl, {
          method: "HEAD",
          headers: {
            Referer: `${SITE}/`,
            "User-Agent": UA,
            "x-anitv-peek": "1",
          },
        });
        if (res.status === 200) {
          const fallbackEntry = { folder: `${idNum}-${slug}`, eps: [1], audio: [], subs: [] };
          await setAsync(cacheKey, fallbackEntry, SHOW_IDENTITY_TTL);
          return { folder: fallbackEntry.folder, lib: fallbackEntry };
        }
      } catch {}
    }
  }

  // 5. Default title fallback
  const fallbackSlug = cleanSlug(media?.title?.english || media?.title?.romaji || media?.title?.userPreferred || "anime");
  return { folder: `${idNum}-${fallbackSlug}`, lib: null };
}

export async function handleWatch(anilistId, audio = "sub", epNum = 1) {
  const idNum = Number(anilistId);
  const episodeNumber = Number(epNum);
  const media = await getMedia(idNum);

  const { folder, lib } = await resolveMediaFolder(idNum, media);
  if (!folder) return json({ error: `Could not resolve folder for AniList ID ${anilistId}` }, 404);

  const epStr = `E${String(episodeNumber).padStart(4, "0")}`;
  const hlsUrl = `${SITE}/hls/${folder}/${epStr}/master.m3u8`;
  const cleanSlugPart = folder.replace(/^\d+-/, "");
  const embedUrl = `${SITE}/watch/${cleanSlugPart}-${idNum}/${episodeNumber}?lang=${audio}&embed=ani`;

  // Pre-generate audio and subtitle track metadata instantly from database
  const audio_tracks = lib?.audio?.length
    ? lib.audio.map((lang) => ({
        name: formatLangName(lang),
        language: lang,
      }))
    : [
        { name: "Japanese", language: "ja" },
        { name: "English", language: "en" },
      ];

  const subtitles = lib?.subs?.length
    ? lib.subs.map((lang) => ({
        name: formatLangName(lang),
        language: lang,
      }))
    : [{ name: "English", language: "en" }];

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
          "x-anitv-peek": "1",
        },
      },
    ],
    audio_tracks,
    subtitles,
  });
}

export async function handleStream(anilistId, audio, epNum, request = null, env = {}) {
  const idNum = Number(anilistId);
  const episodeNumber = Number(epNum);
  const media = await getMedia(idNum);

  const { folder } = await resolveMediaFolder(idNum, media);
  if (!folder) return json({ error: `Could not resolve folder for AniList ID ${anilistId}` }, 404);

  const epStr = `E${String(episodeNumber).padStart(4, "0")}`;
  const hlsUrl = `${SITE}/hls/${folder}/${epStr}/master.m3u8`;

  const reqUrl = request ? new URL(request.url) : null;
  if (reqUrl && reqUrl.searchParams.get("redirect") === "true") {
    const proxiedStreamUrl = `/proxy?url=${encodeURIComponent(hlsUrl)}&ref=${encodeURIComponent(`${SITE}/`)}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: proxiedStreamUrl,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=1800",
      },
    });
  }

  // DIRECT STREAMING: Return 200 OK directly with rewritten M3U8 content!
  // Zero 302 redirect round-trip overhead!
  const reqHost = reqUrl ? reqUrl.host : `localhost:${process.env.PORT || 3020}`;
  const proto = reqUrl?.protocol || "http:";
  const proxyUrl = `${proto}//${reqHost}/proxy?url=${encodeURIComponent(hlsUrl)}&ref=${encodeURIComponent(`${SITE}/`)}`;

  const proxyRequest = new Request(proxyUrl, {
    method: "GET",
    headers: {
      "User-Agent": request?.headers?.get("User-Agent") || UA,
      Accept: "*/*",
      Referer: `${SITE}/`,
    },
  });

  return proxyHandler.fetch(proxyRequest, env);
}

export async function getEpisodes(anilistId, ctx = {}) {
  const idNum = Number(anilistId);

  // 1. Check SmartCache disk or on-demand disk scan
  const media = ctx.media ?? await getMedia(idNum);
  const { lib } = await resolveMediaFolder(idNum, media);

  if (lib && Array.isArray(lib.eps) && lib.eps.length > 0) {
    const episodes = lib.eps.map((i) => ({
      id: `anipmbeta-${i}`,
      episode: i,
      title: `Episode ${i}`,
    }));

    return {
      provider: "anipmbeta",
      anilistId: idNum,
      totalEpisodes: episodes.length,
      episodes,
    };
  }

  // 2. Fallback to AniList metadata
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
  async fetch(request, env = {}) {
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
      let m = path.match(/^\/watch\/anipmbeta\/(\d+)\/(sub|dub|multi)\/(?:anipmbeta-)?(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/anipmbeta\/(\d+)\/(sub|dub|multi)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3], request, env);

      m = path.match(/^\/episodes\/anipmbeta\/(\d+)\/?$/);
      if (m) return json(await getEpisodes(Number(m[1])));

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, stack: error.stack }, 500);
    }
  },
};
