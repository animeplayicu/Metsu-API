import { getMedia } from "../core/anilist.js";
import { findVideoExtractor } from "../extractors/index.js";
import {
  buildTitles,
  decodeEntities,
  diceCoeff,
  episodeMeta,
  expectedCount,
  json,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import { MAL_TO_ANIWAVES, ANILIST_TO_ANIWAVES } from "../mappings/aniwaves.js";

const BASE = "https://aniwaves.ru";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(value = "") {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function attribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${escapeRegex(name)}=["']([^"']*)["']`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function formatName(value) {
  const name = String(value || "").toUpperCase();
  if (name.includes("SPECIAL")) return "special";
  if (name === "TV" || name === "TV_SHORT") return "tv";
  if (name === "MOVIE") return "movie";
  if (name === "OVA") return "ova";
  if (name === "ONA") return "ona";
  if (name === "SPECIAL") return "special";
  return "";
}

function searchQueries(titles) {
  const queries = new Set();
  for (const raw of titles.slice(0, 4)) {
    const title = String(raw || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    queries.add(title);
    const plain = title.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
    if (plain.length >= 3) queries.add(plain);
    const family = plain
      .replace(/\b(?:the\s+)?final\s+chapters?\b/gi, " ")
      .replace(/\bfinal\s+(?:arc|edition)\b/gi, " ")
      .replace(/\b(?:kanketsu|kouhen|zenpen)\s*(?:hen)?\b/gi, " ")
      .replace(/\b(?:the\s+)?movie\b/gi, " ")
      .replace(/\b(?:season|part|cour|chapter)\s*(?:\d+|one|two|three|four|final)?\b/gi, " ")
      .replace(/\b(?:final|special)\s*(?:\d+|one|two|three|four)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (family.length >= 3 && family !== plain) queries.add(family);
  }
  return [...queries].filter((query) => query.length >= 3).slice(0, 3);
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(6000),
  });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`AniWaves HTTP ${response.status}: ${url}`);
    error.rawBody = raw;
    throw error;
  }
  return raw;
}

async function fetchAjax(path, referer) {
  const raw = await fetchText(`${BASE}${path}`, {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": referer,
  });
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = new Error(`AniWaves returned invalid JSON: ${path}`);
    error.rawBody = raw;
    throw error;
  }
  if (Number(data?.status) !== 200) {
    const error = new Error(data?.message || `AniWaves request failed: ${path}`);
    error.rawBody = raw;
    throw error;
  }
  return data.result;
}

function parseSearchCards(html) {
  const found = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = match[1];
    if (!/\bclass=["'][^"']*\bname\b[^"']*\bd-title\b/i.test(tag)) continue;
    const href = attribute(tag, "href");
    const slug = href.match(/^\/watch\/([a-z0-9-]+)$/i)?.[1];
    if (!slug || found.has(slug)) continue;
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    if (!Number.isFinite(siteId)) continue;
    const title = stripHtml(match[2]);
    if (!title) continue;
    found.set(slug, {
      slug,
      siteId,
      title,
      japanese: attribute(tag, "data-jp"),
    });
  }
  return [...found.values()];
}

async function search(query) {
  const html = await fetchText(`${BASE}/filter?keyword=${encodeURIComponent(query)}`, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": `${BASE}/`,
  });
  return parseSearchCards(html);
}

function detailField(html, label) {
  const match = html.match(new RegExp(`<div>\\s*${escapeRegex(label)}:\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function parseEpisodeCount(value) {
  const numbers = [...String(value).matchAll(/\d+/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  return { available: numbers[0] ?? 0, total: numbers[1] ?? numbers[0] ?? 0 };
}

async function fetchDetail(candidate) {
  const html = await fetchText(`${BASE}/watch/${candidate.slug}`, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": `${BASE}/`,
  });
  const premiered = detailField(html, "Premiered");
  const aired = detailField(html, "Date aired");
  const year = Number((aired.match(/\d{4}/)?.[0] ?? premiered.match(/\d{4}/)?.[0] ?? ""));

  const realSiteId = Number(
    html.match(/name=["']show_id["']\s+value=["'](\d+)["']/i)?.[1]
    || html.match(/id=["']watch-main["'][^>]*data-id=["'](\d+)["']/i)?.[1]
    || html.match(/data-id=["'](\d+)["'][^>]*id=["']watch-main["']/i)?.[1]
    || html.match(/["']anime_id["']:\s*["'](\d+)["']/i)?.[1]
  );

  const episodes = parseEpisodeCount(detailField(html, "Episodes"));
  const siteId = (Number.isFinite(realSiteId) && realSiteId > 0) ? realSiteId : candidate.siteId;

  // Reject dead pages, orphan pages, or pages with show_id 0
  if (!siteId || siteId === 0) return null;

  return {
    ...candidate,
    siteId,
    title: candidate.title || stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ""),
    type: formatName(detailField(html, "Type")),
    year: Number.isFinite(year) ? year : null,
    episodes,
  };
}

function candidateTitleScore(titles, candidate) {
  const values = [candidate.title, candidate.japanese, candidate.slug.replace(/-/g, " ")].filter(Boolean);
  let best = 0;
  for (const title of titles) {
    for (const value of values) best = Math.max(best, diceCoeff(title, value));
  }
  return best;
}

function coverageScore(candidate, expected, status) {
  if (!expected || expected < 1) return 0.5;
  if (candidate.episodes.available < 1) return 0;
  if (expected < 6) return 1;
  const needed = status === "FINISHED" ? Math.ceil(expected * 0.8) : Math.max(1, expected - 3);
  return Math.min(1, candidate.episodes.available / needed);
}

function validateCandidate(candidate, media, titles, expected) {
  const titleScore = candidateTitleScore(titles, candidate);
  const expectedType = formatName(media?.format);
  const expectedYear = Number(media?.startDate?.year ?? media?.seasonYear ?? 0) || null;
  if (titleScore < 0.60) return null;
  if (expectedType && candidate.type && expectedType !== candidate.type) return null;
  if (expectedYear && candidate.year && Math.abs(expectedYear - candidate.year) > 1) return null;
  const coverage = coverageScore(candidate, expected, media?.status);
  if (media?.status === "FINISHED" && expected >= 6 && coverage < 0.8) return null;
  const score = titleScore * 0.72 + (expectedType && candidate.type === expectedType ? 0.14 : 0.07) + (expectedYear && candidate.year === expectedYear ? 0.1 : 0.04) + coverage * 0.04;
  return { ...candidate, titleScore, coverage, score };
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:aniwaves:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;
  const media = ctx.media ?? await getMedia(anilistId);

  // 1. Static seed mapping lookup (0ms instant)
  const mappedSlug = ANILIST_TO_ANIWAVES[anilistId] || (media?.idMal ? MAL_TO_ANIWAVES[media.idMal] : null);
  if (mappedSlug) {
    const siteId = Number(mappedSlug.match(/-(\d+)$/)?.[1]);
    if (siteId > 0) {
      const data = {
        siteId,
        slug: mappedSlug,
        title: media?.title?.english || media?.title?.romaji || mappedSlug,
        score: 1.0,
        matchScore: 1.0,
        episodeCount: 0,
      };
      set(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  // 2. Fast sequential search queries (early stop once candidates found)
  const titles = buildTitles(media, ctx.anizip);
  const expected = expectedCount(media, ctx.anizip);
  const discovered = new Map();
  for (const query of searchQueries(titles)) {
    try {
      const results = await search(query);
      for (const candidate of results) {
        if (!discovered.has(candidate.slug)) discovered.set(candidate.slug, candidate);
      }
      if (discovered.size >= 4) break;
    } catch {}
  }

  // 3. Score candidates and fetch details for at most top 3
  const shortlist = [...discovered.values()]
    .map((candidate) => ({ candidate, score: candidateTitleScore(titles, candidate) }))
    .filter((item) => item.score >= 0.5)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.candidate);

  const details = await Promise.all(shortlist.map((candidate) => fetchDetail(candidate).catch(() => null)));
  const valid = details
    .filter(Boolean)
    .map((candidate) => validateCandidate(candidate, media, titles, expected))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  const selected = valid[0];
  if (!selected || selected.score < 0.65) {
    throw new Error(`AniWaves match not confident for AniList ${anilistId}`);
  }

  const data = {
    siteId: selected.siteId,
    slug: selected.slug,
    title: selected.title,
    score: selected.score,
    matchScore: selected.titleScore,
    episodeCount: selected.episodes.available,
  };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function parseEpisodes(html) {
  const episodes = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const number = Number(attribute(attrs, "data-num"));
    const sourceNumber = attribute(attrs, "data-slug") || String(number);
    if (!Number.isFinite(number) || number < 1 || seen.has(number)) continue;
    const ids = attribute(attrs, "data-ids");
    if (!ids) continue;
    seen.add(number);
    episodes.push({
      number,
      sourceNumber,
      ids,
      title: stripHtml(match[2]).replace(/^\d+\s*/, "") || `Episode ${number}`,
      airDate: attribute(attrs, "data-aired") || null,
      duration: Number(attribute(attrs, "data-duration")) || null,
      filler: attribute(attrs, "data-filler") === "1",
      recap: attribute(attrs, "data-recap") === "1",
      hasSub: attribute(attrs, "data-sub") === "1",
      hasDub: attribute(attrs, "data-dub") === "1",
    });
  }
  return episodes.sort((left, right) => left.number - right.number);
}

async function fetchEpisodes(series) {
  const cacheKey = `aniwaves:eps:${series.siteId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;
  const result = await fetchAjax(`/ajax/episode/list/${series.siteId}?vrf=`, `${BASE}/watch/${series.slug}`);
  const episodes = parseEpisodes(String(result || ""));
  if (!episodes.length) throw new Error(`AniWaves has no episodes for ${series.slug}`);
  set(cacheKey, episodes, 43200);
  return episodes;
}

function ordinal(value) {
  const match = String(value || "").toLowerCase().match(/\b(?:part|special|chapter)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!match) return 0;
  const word = match[1];
  const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return Number(word) || numbers[word] || 0;
}

function alignEpisodes(sourceEpisodes, media, expected) {
  if (!expected || sourceEpisodes.length <= expected) return sourceEpisodes;
  const targetTitles = [media?.title?.english, media?.title?.romaji, media?.title?.native].filter(Boolean);
  const targetOrdinal = Math.max(0, ...targetTitles.map(ordinal));
  if (targetOrdinal < 2) return sourceEpisodes;
  const start = sourceEpisodes.findIndex((episode) => ordinal(episode.title) === targetOrdinal);
  if (start < 0 || sourceEpisodes.length - start < expected) return sourceEpisodes;
  return sourceEpisodes.slice(start, start + expected).map((episode, index) => ({ ...episode, number: index + 1 }));
}

function buildEpisodeLists(anilistId, sourceEpisodes, ctx, expected) {
  const sub = [];
  const dub = [];
  const multi = [];
  for (const source of sourceEpisodes) {
    if (expected && source.number > expected) continue;
    const meta = episodeMeta(source.number, ctx);
    const base = {
      number: source.number,
      title: meta.title ?? source.title,
      duration: meta.duration ?? source.duration ?? null,
      filler: meta.filler ?? source.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate ?? source.airDate,
      recap: source.recap,
      sourceNumber: source.sourceNumber,
    };
    if (source.hasSub) sub.push({ ...base, id: `watch/aniwaves/${anilistId}/sub/aniwaves-${source.number}`, audio: "sub" });
    if (source.hasDub) dub.push({ ...base, id: `watch/aniwaves/${anilistId}/dub/aniwaves-${source.number}`, audio: "dub" });
    if (source.hasSub || source.hasDub) multi.push({ ...base, id: `watch/aniwaves/${anilistId}/multi/aniwaves-${source.number}`, audio: "multi" });
  }
  return { sub, dub, multi };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const [series, expected] = await Promise.all([
    resolveSeries(anilistId, localCtx),
    Promise.resolve(expectedCount(media, ctx.anizip)),
  ]);
  const episodes = alignEpisodes(await fetchEpisodes(series), media, expected);
  return {
    meta: {
      id: series.slug,
      title: series.title,
      source: "aniwaves",
      matchScore: Number(series.matchScore.toFixed(3)),
      numbering: "standard",
      episodeOffset: 0,
    },
    episodes: buildEpisodeLists(anilistId, episodes, localCtx, expected),
  };
}

function parseServerGroups(html) {
  const groups = [];
  const markers = [...html.matchAll(/<div\b([^>]*)>/gi)]
    .map((match) => ({ index: match.index, attrs: match[1], type: attribute(match[1], "data-type") }))
    .filter((item) => item.type === "sub" || item.type === "dub" || item.type === "ssub");
  for (let index = 0; index < markers.length; index++) {
    const current = markers[index];
    const end = markers[index + 1]?.index ?? html.length;
    const segment = html.slice(current.index, end);
    for (const match of segment.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
      const attrs = match[1];
      const linkId = attribute(attrs, "data-link-id");
      if (!linkId) continue;
      const rawName = stripHtml(match[2]) || "AniWaves";
      const svId = attribute(attrs, "data-sv-id") || null;
      const isMulti = svId === "15" || /mul-?aud/i.test(rawName);
      const isDatSaV = svId === "14" || /datsav/i.test(rawName);
      const isVidplay = svId === "4" || /vidplay/i.test(rawName) || /echovideo/i.test(rawName);
      const isDirect = isDatSaV || isMulti || isVidplay;
      let displayName = rawName;
      if (isMulti) displayName = "MuL-AuD (Multi-Audio)";
      else if (isDatSaV) displayName = "DatSaV (Direct MP4)";
      groups.push({
        audio: current.type,
        linkId,
        serverId: svId,
        server: displayName,
        isMultiAudio: isMulti,
        isDirect,
      });
    }
  }
  return groups;
}

async function fetchServers(series, episode) {
  const result = await fetchAjax(
    `/ajax/server/list?servers=${encodeURIComponent(series.siteId)}&eps=${encodeURIComponent(episode.sourceNumber)}`,
    `${BASE}/watch/${series.slug}/ep-${episode.sourceNumber}`,
  );
  return parseServerGroups(String(result || ""));
}

async function fetchSource(linkId, referer) {
  const result = await fetchAjax(`/ajax/sources?id=${encodeURIComponent(linkId)}&asi=0&autoPlay=0`, referer);
  if (!result?.url) throw new Error("AniWaves source response has no embed url");
  return result;
}

async function resolveSource(source, referer) {
  const extractor = findVideoExtractor(source.url);
  if (!extractor) return [];
  try {
    const streams = await extractor.extract(source.url, { userAgent: UA, referer });
    return streams.map((stream) => typeof stream === "string" ? { url: stream, type: "hls" } : stream);
  } catch {
    return [];
  }
}

function skipRange(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const start = Number(value[0]);
    const end = Number(value[1]);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  }
  if (typeof value === "object") {
    const start = Number(value.start ?? value.startTime ?? value[0]);
    const end = Number(value.end ?? value.endTime ?? value[1]);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  }
  return null;
}

async function fetchAniSkip(malId, epNum) {
  if (!malId) return { intro: null, outro: null };
  try {
    const res = await fetch(`https://api.aniskip.com/v2/skip-times/${encodeURIComponent(malId)}/${encodeURIComponent(epNum)}?types=op&types=ed&episodeLength=0`, {
      signal: AbortSignal.timeout(1500),
    });
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
  const series = await resolveSeries(anilistId, { ...ctx, media });
  const expected = expectedCount(media, ctx.anizip);
  const episodes = alignEpisodes(await fetchEpisodes(series), media, expected);
  const episode = episodes.find((item) => item.number === Number(epNum));
  if (!episode || (audio === "sub" && !episode.hasSub) || (audio === "dub" && !episode.hasDub)) {
    throw new Error(`AniWaves ${audio} episode ${epNum} not found`);
  }
  const [allServers, aniSkipData] = await Promise.all([
    fetchServers(series, episode),
    fetchAniSkip(media?.idMal, epNum).catch(() => ({ intro: null, outro: null })),
  ]);
  const allMatchingServers = allServers.filter((server) => {
    if (audio === "multi") return server.isMultiAudio || server.audio === "sub" || server.audio === "dub";
    if (server.audio === audio) return true;
    if (server.isMultiAudio) return true; // Multi-Audio contains Japanese & English, valid for both sub and dub
    return false;
  });
  if (!allMatchingServers.length) throw new Error(`AniWaves has no ${audio} servers for episode ${epNum}`);

  // Fast-path: Prioritize direct playable stream servers (DatSaV MP4, MuL-AuD, Vidplay/Echovideo)
  // Skip slow ad-heavy embed servers (BYFMS, DGHG) when direct servers are available
  const directServers = allMatchingServers.filter((server) => server.isDirect);
  const servers = directServers.length > 0 ? directServers : allMatchingServers;

  const referer = `${BASE}/watch/${series.slug}/ep-${episode.sourceNumber}`;
  const resolved = await Promise.all(servers.map(async (server) => {
    try {
      const source = await fetchSource(server.linkId, referer);
      const direct = source?.url ? await resolveSource(source, referer) : [];
      return { server, source, direct };
    } catch (error) {
      return { server, error, direct: [] };
    }
  }));
  const streams = [];
  let intro = null;
  let outro = null;
  for (const item of resolved) {
    if (!item.source?.url) continue;
    const sourceReferer = (() => {
      try { return `${new URL(item.source.url).origin}/`; } catch { return referer; }
    })();
    const skip = item.source.skip_data ?? {};
    intro ??= skipRange(skip.intro);
    outro ??= skipRange(skip.outro);
    for (const stream of item.direct) {
      const isMuL = item.server.isMultiAudio || stream.isMultiAudio || stream.server === "MuL-AuD";
      const isDatSaV = item.server.serverId === "14" || stream.server === "DatSaV";
      const isDirectMp4 = stream.type === "mp4";
      let priority = 4;
      if (isMuL) priority = 7;
      else if (isDatSaV) priority = 6;
      else if (isDirectMp4) priority = 5;
      else if (stream.type === "hls") priority = 5;

      if (stream.intro) intro ??= skipRange(stream.intro);
      if (stream.outro) outro ??= skipRange(stream.outro);

      streams.push({
        url: stream.url,
        proxied_url: `/proxy?url=${encodeURIComponent(stream.url)}&ref=${encodeURIComponent(sourceReferer)}`,
        type: stream.type,
        server: item.server.server,
        referer: sourceReferer,
        quality: stream.quality,
        isMultiAudio: Boolean(isMuL),
        subtitles: stream.tracks || [],
        priority,
        isActive: false,
      });
    }
    streams.push({
      url: item.source.url,
      type: "embed",
      server: item.server.server,
      referer: sourceReferer,
      priority: 2,
      isActive: false,
    });
  }
  if (!streams.length) {
    const failure = resolved.find((item) => item.error)?.error;
    throw failure ?? new Error(`AniWaves sources unavailable for episode ${epNum}`);
  }

  // Sort streams so MuL-AuD and DatSaV are prioritized at the very top
  streams.sort((a, b) => b.priority - a.priority);
  streams[0].isActive = true;
  const topStream = streams[0];

  // Fallback to AniSkip intro/outro if server had no skip data
  intro ??= aniSkipData?.intro ?? null;
  outro ??= aniSkipData?.outro ?? null;

  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: episode.number,
    audio,
    intro,
    outro,
    stream_url: topStream?.url || topStream?.proxied_url || null,
    raw_stream_url: topStream?.url || null,
    proxied_stream_url: topStream?.proxied_url || topStream?.url || null,
    streams,
  });
}

async function handleStream(anilistId, audio, epNum) {
  const watchResp = await handleWatch(anilistId, audio, epNum);
  const data = await watchResp.json();
  const target = data.stream_url;
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
    try {
      const match = url.pathname.match(/^\/watch\/aniwaves\/(\d+)\/(sub|dub|multi)\/aniwaves-(\d+)\/?$/);
      if (match) return await handleWatch(match[1], match[2], match[3]);

      const streamMatch = url.pathname.match(/^\/stream\/aniwaves\/(\d+)\/(sub|dub|multi)\/(\d+)\/?$/);
      if (streamMatch) return await handleStream(streamMatch[1], streamMatch[2], streamMatch[3]);

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, "Raw-ERROR": error.rawBody ?? null, stack: error.stack }, 500);
    }
  },
};

