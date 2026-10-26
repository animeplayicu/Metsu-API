import { getMedia } from "../core/anilist.js";
import {
  attr,
  decodeEntities,
  diceCoeff,
  episodeMeta,
  expectedCount,
  fetchHtml,
  json,
  norm,
  stripTags,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import { getMappedSlug } from "../mappings/animegg.js";

const BASE = "https://www.animegg.org";

// In-memory 5-minute cache for series episode lists to avoid redundant scrapes
const seriesEpisodeCache = new Map();

async function search(query) {
  if (!query || !query.trim()) return [];
  try {
    const html = await fetchHtml(`${BASE}/search/?q=${encodeURIComponent(query.trim())}`);
    const results = [];
    const matches = html.matchAll(/<a\b[^>]*class=["'][^"']*\bmse\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    for (const m of matches) {
      const raw = m[0];
      const slug = raw.match(/href=["']\/series\/([^"'/?#]+)/i)?.[1];
      if (!slug) continue;
      const titleMatch = raw.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
      const title = titleMatch ? decodeEntities(stripTags(titleMatch)) : slug.replace(/-/g, " ");
      const altMatch = raw.match(/Alt Titles\s*:\s*([^<]+)/i)?.[1];
      const altTitles = altMatch ? decodeEntities(altMatch).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
      const epMatch = raw.match(/Episodes\s*:\s*(\d+)/i)?.[1];
      const epCount = epMatch ? parseInt(epMatch, 10) : null;
      const statusMatch = raw.match(/Status\s*:\s*([^<]+)/i)?.[1]?.trim() || "";

      results.push({
        slug,
        title,
        altTitles,
        epCount,
        status: statusMatch,
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function scrapeSeries(slug) {
  if (seriesEpisodeCache.has(slug)) {
    const cached = seriesEpisodeCache.get(slug);
    if (Date.now() - cached.ts < 300000) {
      return cached.episodes;
    }
  }

  const html = await fetchHtml(`${BASE}/series/${slug}`);
  const episodes = [];
  for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    if (!/\banm_det_pop\b/.test(block)) continue;
    const link = block.match(/<a\b[^>]*class=["'][^"']*anm_det_pop[^"']*["'][^>]*>/i)?.[0] ?? "";
    const href = attr(link, "href").replace(/#.*$/, "").replace(/^\//, "");
    const strong = stripTags(block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? "");
    const rangeMatch = strong.match(/(\d+)-(\d+)\s*$/);
    const numMatch = rangeMatch || strong.match(/(\d+)\s*$/);
    if (!numMatch || !href) continue;
    const number = parseInt(numMatch[1], 10);
    const title = stripTags(block.match(/<i\b[^>]*class=["'][^"']*anititle[^"']*["'][^>]*>([\s\S]*?)<\/i>/i)?.[1] ?? "") || strong;
    const audio = [];
    if (/\bbtn-subbed\b/.test(block)) audio.push("sub");
    if (/\bbtn-dubbed\b/.test(block)) audio.push("dub");
    episodes.push({ number, title, epSlug: href, hasSub: audio.includes("sub"), hasDub: audio.includes("dub") });
  }
  episodes.sort((a, b) => a.number - b.number);
  const seen = new Set();
  const deduped = episodes.filter((e) => seen.has(e.number) ? false : (seen.add(e.number), true));
  seriesEpisodeCache.set(slug, { episodes: deduped, ts: Date.now() });
  return deduped;
}

async function scrapeEmbed(embedId) {
  const html = await fetchHtml(`${BASE}/embed/${embedId}`, { Referer: BASE });
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
  return parsed.map((s) => {
    let backup = null;
    if (s.bk) {
      try { backup = decodeURIComponent(atob(s.bk)); }
      catch { backup = null; }
    }
    return {
      quality: s.label || "unknown",
      url: s.file ? (s.file.startsWith("http") ? s.file : `${BASE}${s.file}`) : "",
      backup,
    };
  }).filter((s) => s.url);
}

async function scrapeEpisodeWatch(epSlug, audio) {
  const html = await fetchHtml(`${BASE}/${epSlug}`, { Referer: BASE });
  const title = stripTags(html.match(/<div\b[^>]*class=["'][^"']*info[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
  const tabs = [];
  for (const m of html.matchAll(/<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi)) {
    const tag = m[0];
    const embedId = attr(tag, "data-id");
    const server = attr(tag, "data-mirror") || "AnimeGG";
    const version = attr(tag, "data-version") || "subbed";
    if (!embedId) continue;
    const normalized = version.startsWith("dub") ? "dub" : "sub";
    if (audio === "all" || normalized === audio) {
      tabs.push({ embedId, embedUrl: `${BASE}/embed/${embedId}`, server, normalized });
    }
  }
  const results = await Promise.allSettled(tabs.map(async (tab, i) => {
    const sources = await scrapeEmbed(tab.embedId);
    const streams = sources.map((s, j) => {
      const ref = `${new URL(tab.embedUrl).origin}/`;
      const proxied = `/proxy?url=${encodeURIComponent(s.url)}&ref=${encodeURIComponent(ref)}`;
      const streamObj = {
        url: proxied,
        raw_url: s.url,
        proxied_url: proxied,
        type: s.url.includes(".m3u8") ? "hls" : "mp4",
        quality: s.quality,
        backup: s.backup ? `/proxy?url=${encodeURIComponent(s.backup)}&ref=${encodeURIComponent(ref)}` : null,
        raw_backup: s.backup,
        audio: tab.normalized,
        server: tab.server,
        embed: tab.embedUrl,
        referer: ref,
        priority: tabs.length - i,
        isActive: i === 0 && j === 0,
      };
      if (s.backup && s.backup.startsWith("http")) {
        streamObj.proxied_backup = `/proxy?url=${encodeURIComponent(s.backup)}&ref=${encodeURIComponent(ref)}`;
      }
      return streamObj;
    });
    streams.push({
      url: tab.embedUrl,
      type: "embed",
      audio: tab.normalized,
      server: `${tab.server}-embed`,
      referer: `${new URL(tab.embedUrl).origin}/`,
      priority: 1,
      isActive: false,
    });
    return streams;
  }));
  return { title, streams: results.flatMap((r) => r.status === "fulfilled" ? r.value : []) };
}

function scoreCandidate(candidate, targetTitles, expected) {
  const candStrings = [
    candidate.title,
    candidate.slug.replace(/-/g, " "),
    ...(candidate.altTitles || []),
  ];

  let bestTitleScore = 0;
  for (const target of targetTitles) {
    if (!target) continue;
    for (const cand of candStrings) {
      if (!cand) continue;
      const d = diceCoeff(target, cand);
      if (d > bestTitleScore) bestTitleScore = d;
    }
  }

  // Deprioritize dedicated -dub slugs
  if (candidate.slug.endsWith("-dub")) {
    bestTitleScore *= 0.7;
  }

  // Season number consistency
  const targetHasSeasonNum = targetTitles.some((t) =>
    /\b(season\s*[2-9]|\d+nd\s*season|\d+rd\s*season|\d+th\s*season|part\s*[2-9])\b/i.test(t)
  );
  const candHasSeasonNum =
    /\b(season\s*[2-9]|\d+nd\s*season|\d+rd\s*season|\d+th\s*season|part\s*[2-9])\b/i.test(candidate.title) ||
    /-(season-[2-9]|[2-9]nd-season|[2-9]rd-season|[2-9]th-season|part-[2-9])/i.test(candidate.slug);

  if (!targetHasSeasonNum && candHasSeasonNum) {
    bestTitleScore *= 0.2;
  } else if (targetHasSeasonNum && !candHasSeasonNum) {
    bestTitleScore *= 0.3;
  }

  // Episode count matching bonus / penalty
  let countScore = 1.0;
  if (expected && candidate.epCount && candidate.epCount > 0) {
    if (candidate.epCount === expected) {
      countScore = 1.25;
    } else if (Math.abs(candidate.epCount - expected) <= 2) {
      countScore = 1.05;
    } else {
      const minMultiplier = bestTitleScore >= 0.85 ? 0.75 : 0.4;
      countScore = Math.max(minMultiplier, 1 - Math.abs(candidate.epCount - expected) / Math.max(expected, candidate.epCount));
    }
  }

  return bestTitleScore * countScore;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:animegg:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const malId = media?.idMal ?? ctx.anizip?.mappings?.mal_id ?? null;

  // 1. Direct Static Map check (MAL ID or AniList ID) -> 0ms lookup!
  const mappedSlug = getMappedSlug(malId, anilistId);
  if (mappedSlug) {
    const data = {
      slug: mappedSlug,
      title: media?.title?.romaji || media?.title?.english || mappedSlug,
      mode: "local",
      offset: 0,
      score: 1.0,
      source: "static_map",
    };
    set(cacheKey, data, SHOW_IDENTITY_TTL);
    return data;
  }

  // 2. High-speed dynamic search
  const expected = expectedCount(media, ctx.anizip);
  const targetTitles = [
    media?.title?.romaji,
    media?.title?.english,
    ...(media?.synonyms || []),
  ].filter(Boolean);

  // Search using MAL Romaji title first (closest to AnimeGG naming), then English
  const primaryQuery = media?.title?.romaji || media?.title?.english || "";
  let candidates = await search(primaryQuery);

  let scored = candidates.map((c) => ({
    ...c,
    score: scoreCandidate(c, targetTitles, expected),
  })).sort((a, b) => b.score - a.score);

  // If top candidate is not high-confidence, try franchise base query (without Season/Part suffixes)
  if (!scored.length || scored[0].score < 0.65) {
    const baseQuery = primaryQuery
      .replace(/\b(season\s*\d+|part\s*\d+|\d+nd\s*season|\d+rd\s*season|\d+th\s*season)\b/gi, "")
      .replace(/[:\-–—].*$/, "")
      .trim();

    if (baseQuery && baseQuery.toLowerCase() !== primaryQuery.toLowerCase()) {
      const fallbackCandidates = await search(baseQuery);
      const seen = new Set(candidates.map((c) => c.slug));
      for (const fc of fallbackCandidates) {
        if (!seen.has(fc.slug)) candidates.push(fc);
      }
      scored = candidates.map((c) => ({
        ...c,
        score: scoreCandidate(c, targetTitles, expected),
      })).sort((a, b) => b.score - a.score);
    }
  }

  // Also check English title if Romaji was different and score is still low
  if ((!scored.length || scored[0].score < 0.65) && media?.title?.english && media.title.english !== primaryQuery) {
    const enCandidates = await search(media.title.english);
    const seen = new Set(candidates.map((c) => c.slug));
    for (const ec of enCandidates) {
      if (!seen.has(ec.slug)) candidates.push(ec);
    }
    scored = candidates.map((c) => ({
      ...c,
      score: scoreCandidate(c, targetTitles, expected),
    })).sort((a, b) => b.score - a.score);
  }

  const best = scored.find((c) => c.score >= 0.5);
  if (!best) throw new Error(`AnimeGG match not found for AniList ${anilistId}`);

  const data = {
    slug: best.slug,
    title: best.title,
    mode: "local",
    offset: 0,
    score: Number(best.score.toFixed(3)),
    source: "dynamic_search",
  };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeLists(anilistId, series, providerEpisodes, ctx, expected) {
  const sub = [], dub = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    const base = {
      number,
      title: meta.title ?? src.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
    };
    if (src.hasSub) sub.push({ ...base, id: `watch/animegg/${anilistId}/sub/animegg-${number}`, audio: "sub" });
    if (src.hasDub) dub.push({ ...base, id: `watch/animegg/${anilistId}/dub/animegg-${number}`, audio: "dub" });
  }
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media, ctx.anizip);
  return {
    meta: {
      id: series.slug,
      title: series.title,
      source: "animegg",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function fetchAniSkip(malId, epNum) {
  if (!malId) return { intro: null, outro: null };
  try {
    const res = await fetch(`https://api.aniskip.com/v2/skip-times/${encodeURIComponent(malId)}/${encodeURIComponent(epNum)}?types=op&types=ed&episodeLength=0`);
    if (!res.ok) return { intro: null, outro: null };
    const data = await res.json();
    let intro = null;
    let outro = null;
    for (const r of data?.results || []) {
      if (r.skipType === "op" && r.interval) {
        intro = { start: Math.round(r.interval.startTime), end: Math.round(r.interval.endTime) };
      } else if (r.skipType === "ed" && r.interval) {
        outro = { start: Math.round(r.interval.startTime), end: Math.round(r.interval.endTime) };
      }
    }
    return { intro, outro };
  } catch {
    return { intro: null, outro: null };
  }
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const [series, aniSkipData] = await Promise.all([
    resolveSeries(anilistId, { ...ctx, media }),
    fetchAniSkip(media?.idMal, epNum).catch(() => ({ intro: null, outro: null })),
  ]);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const episodes = await scrapeSeries(series.slug);
  const ep = episodes.find((e) => e.number === providerEp);
  if (!ep) return json({ error: `AnimeGG episode ${providerEp} not found` }, 404);
  let watch = await scrapeEpisodeWatch(ep.epSlug, audio);
  let effectiveAudio = audio;

  // If the requested audio track (e.g. sub) is not available on AnimeGG for this episode,
  // fallback to any available audio track so the video plays instead of returning null
  if (!watch.streams.length && audio !== "all") {
    const fallbackWatch = await scrapeEpisodeWatch(ep.epSlug, "all");
    if (fallbackWatch.streams.length) {
      watch = fallbackWatch;
      effectiveAudio = watch.streams[0]?.audio || audio;
    }
  }

  const qualityWeight = (q) => {
    const n = parseInt(q, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const directStreams = watch.streams.filter((s) => s.type === "hls" || s.type === "mp4");
  const topStream = [...directStreams].sort((a, b) => qualityWeight(b.quality) - qualityWeight(a.quality))[0] || watch.streams[0];

  if (topStream) {
    for (const s of watch.streams) {
      s.isActive = s.url === topStream.url && s.quality === topStream.quality;
    }
  }

  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: providerEp,
    audio: effectiveAudio,
    requestedAudio: audio,
    title: watch.title,
    intro: aniSkipData?.intro ?? null,
    outro: aniSkipData?.outro ?? null,
    stream_url: topStream?.proxied_url || topStream?.url || null,
    raw_stream_url: topStream?.raw_url || topStream?.url || null,
    proxied_stream_url: topStream?.proxied_url || topStream?.url || null,
    streams: watch.streams,
  });
}

async function handleStream(anilistId, audio, epNum) {
  const watchResp = await handleWatch(anilistId, audio, epNum);
  const data = await watchResp.json();
  const target = data.proxied_stream_url || data.stream_url;
  if (!target) return json({ error: "Stream not found" }, 404);
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
      const m = url.pathname.match(/^\/watch\/animegg\/(\d+)\/(sub|dub)\/animegg-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      const streamMatch = url.pathname.match(/^\/stream\/animegg\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (streamMatch) return await handleStream(streamMatch[1], streamMatch[2], streamMatch[3]);

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
