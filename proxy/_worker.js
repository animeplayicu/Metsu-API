/**
 * Cloudflare Pages & Workers Universal M3U8 / HLS Stream Proxy
 * Specially optimized for Reanime (Flixcloud XOR decryption), Anikoto (MegaPlay/MegaCloud),
 * and anime HLS stream providers.
 *
 * Unlimited Bandwidth on Cloudflare Pages / Workers.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOWED_DOMAINS = [
  "animetsu.site",
  "animetsu.me",
  "animetsu.de",
  "animetsu.us",
  "aniflix.uno",
  "aniflix.in",
  "aniflix.us",
  "localhost",
  "127.0.0.1",
  "flixcloud.cc",
  "reanime.to",
  "anidream.to",
  "beta.cno.to",
  "cno.to",
  "ani.pm",
];

function isOriginAllowed(originOrReferer) {
  if (!originOrReferer) return true;
  try {
    const host = new URL(originOrReferer).hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

function getDynamicCorsHeaders(request) {
  const origin = request?.headers?.get?.("origin") || request?.headers?.get?.("Origin");
  const referer = request?.headers?.get?.("referer") || request?.headers?.get?.("Referer");
  let allowOrigin = "https://animetsu.site";
  if (origin && isOriginAllowed(origin)) {
    allowOrigin = origin;
  } else if (referer && isOriginAllowed(referer)) {
    try {
      allowOrigin = new URL(referer).origin;
    } catch {}
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Vary": "Origin",
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://animetsu.site",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Vary": "Origin",
};

const FLIX_SEGMENT_XOR_KEY = new Uint8Array([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

let _wreqFetch = null;
async function getWreqFetch() {
  if (_wreqFetch !== null) return _wreqFetch;
  try {
    const mod = await import("../core/wreq.js");
    _wreqFetch = mod.wreqFetch;
  } catch {
    _wreqFetch = false;
  }
  return _wreqFetch;
}

/**
 * Unwrap Flixcloud PNG/WebP disguised & XOR-encrypted MPEG-TS chunks
 */
function unwrapFlixSegment(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let offset = 0;
  let needsXor = false;

  const isWebp =
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;

  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;

  if (isWebp) {
    offset = 12;
    needsXor = bytes[offset] !== 0x47;
  } else if (isPng) {
    offset = 8;
    needsXor = bytes[offset] !== 0x47;
  }

  if (!offset) return { data: bytes, isTs: false };

  const out = new Uint8Array(bytes.length - offset);
  out.set(bytes.subarray(offset));

  if (needsXor) {
    const keyLen = FLIX_SEGMENT_XOR_KEY.length;
    for (let i = 0; i < out.length; i++) {
      out[i] ^= FLIX_SEGMENT_XOR_KEY[i % keyLen];
    }
  }

  return { data: out, isTs: true };
}

/**
 * Decrypt FlixCloud Base64 + XOR manifest if encrypted
 */
function decryptFlixManifest(rawString, keyBase64) {
  const trimmed = rawString.trim();
  if (trimmed.startsWith("#EXTM3U")) return trimmed;
  if (!keyBase64) return trimmed;

  try {
    const keyBin = atob(keyBase64);
    const payloadBin = atob(trimmed);
    const keyBytes = new Uint8Array(keyBin.length);
    for (let i = 0; i < keyBin.length; i++) keyBytes[i] = keyBin.charCodeAt(i);

    const outBytes = new Uint8Array(payloadBin.length);
    for (let i = 0; i < payloadBin.length; i++) {
      outBytes[i] = payloadBin.charCodeAt(i) ^ keyBytes[i % keyBytes.length];
    }

    const decoded = new TextDecoder("utf-8").decode(outBytes).trim();
    if (decoded.startsWith("#EXTM3U")) {
      return decoded;
    }
  } catch (err) {
    // If decryption fails, return original
  }
  return trimmed;
}

/**
 * Auto-detect referer and origin based on target URL if not explicitly provided
 */
function detectDefaultHeaders(targetUrl) {
  const host = targetUrl.hostname.toLowerCase();

  // Flixcloud / Reanime / Atomic CDN
  if (host.includes("flixcloud") || host.includes("reanime") || host.includes("atomic4cdn") || host.includes("rundowncdn")) {
    return {
      referer: "https://flixcloud.cc/",
      origin: "https://flixcloud.cc",
    };
  }

  // CNO / Ani.pm beta
  if (host.includes("cno.to")) {
    return {
      referer: "https://beta.cno.to/",
      origin: "https://beta.cno.to",
    };
  }

  // AniClover / Zanora
  if (host.includes("zanora") || host.includes("aniclover")) {
    return {
      referer: "https://aniclover.cc/",
      origin: "https://aniclover.cc",
    };
  }

  // Echovideo / Vidplay / VHS CDN / AniWaves
  if (host.includes("echovideo") || host.includes("vhscdn") || host.includes("vidplay")) {
    return {
      referer: "https://play.vhscdn.to/",
      origin: "https://play.vhscdn.to",
    };
  }

  // Anikoto / MegaPlay / HiAnime / RapidCloud
  if (host.includes("anikoto")) {
    return {
      referer: "https://anikototv.to/",
      origin: "https://anikototv.to",
    };
  }
  if (host.includes("megaplay") || host.includes("megacloud") || host.includes("rapid-cloud") || host.includes("hianimes") || host.includes("nexabloom")) {
    return {
      referer: "https://hianimes.re/",
      origin: "https://hianimes.re",
    };
  }

  // Animegg / Vidcache
  if (host.includes("animegg") || host.includes("vidcache")) {
    return {
      referer: "https://www.animegg.org/",
      origin: "https://www.animegg.org",
    };
  }

  // Aniwave / Vidstream / MegaF / EchoVideo
  if (host.includes("aniwave") || host.includes("aniwaves") || host.includes("vidstream") || host.includes("megaf") || host.includes("echovideo")) {
    return {
      referer: "https://play.echovideo.ru/",
      origin: "https://play.echovideo.ru",
    };
  }

  // AniZone / Vid-CDN
  if (host.includes("vid-cdn") || host.includes("anizone")) {
    return {
      referer: "https://anizone.to/",
      origin: "https://anizone.to",
    };
  }

  // Ani.pm / Settlar
  if (host.includes("settlar") || host.includes("anipm")) {
    return {
      referer: "https://embed.settlar.io/",
      origin: "https://embed.settlar.io",
    };
  }

  // Cno.to (AniPM Beta)
  if (host.includes("cno.to")) {
    return {
      referer: "https://beta.cno.to/",
      origin: "https://beta.cno.to",
      extraHeaders: {
        "x-anitv-peek": "1",
      },
    };
  }

  // Default fallback: use the target's own origin
  return {
    referer: `${targetUrl.origin}/`,
    origin: targetUrl.origin,
  };
}

function buildProxiedUrl(proxyOrigin, targetUrlStr, context) {
  const u = new URL(proxyOrigin);
  u.pathname = context.pathname || "/";
  u.searchParams.set("url", targetUrlStr);

  if (context.referer) u.searchParams.set("ref", context.referer);
  if (context.origin) u.searchParams.set("origin", context.origin);
  if (context.key) u.searchParams.set("key", context.key);
  if (context.ua && context.ua !== DEFAULT_UA) u.searchParams.set("ua", context.ua);
  if (context.customHeaders) u.searchParams.set("headers", context.customHeaders);

  return u.toString();
}

/**
 * Rewrite M3U8 playlist content line-by-line
 */
function rewriteM3U8(content, baseUrl, proxyOrigin, context) {
  const lines = content.split(/\r?\n/);
  const output = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      // Tags with URI="..." (e.g. #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-PRELOAD-HINT)
      if (trimmed.includes('URI="')) {
        line = line.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            const absolute = new URL(uri, baseUrl).href;
            const proxied = buildProxiedUrl(proxyOrigin, absolute, context);
            return `URI="${proxied}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      output.push(line);
    } else {
      // Segment or child playlist URL
      try {
        const absolute = new URL(trimmed, baseUrl).href;
        const proxied = buildProxiedUrl(proxyOrigin, absolute, context);
        output.push(proxied);
      } catch {
        output.push(line);
      }
    }
  }

  return output.join("\n");
}

/**
 * Cloudflare Edge-Cached CNO.TO Library Handler (6-hour Global CDN Cache)
 * Zero VPS RAM: Cloudflare Edge serves single-anime metadata (~150 bytes) directly from CDN cache.
 */
async function handleCnoLibrary(request, reqUrl, env = {}, ctx = null) {
  const corsHeaders = getDynamicCorsHeaders(request);
  const rawId = reqUrl.searchParams.get("id") || reqUrl.searchParams.get("anilistId") || reqUrl.pathname.split("/").pop();
  const anilistId = Number(rawId);
  const cacheKey = new Request("https://beta.cno.to/library.json");
  const cache = typeof caches !== "undefined" ? caches.default : null;
  let cachedResponse = cache ? await cache.match(cacheKey) : null;

  if (!cachedResponse) {
    const upstream = await fetch("https://beta.cno.to/library.json", {
      headers: {
        "User-Agent": DEFAULT_UA,
        Referer: "https://beta.cno.to/",
        "x-anitv-peek": "1",
      },
      cf: {
        cacheTtl: 21600, // 6 hours on Cloudflare Global Edge CDN
        cacheEverything: true,
      },
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `Upstream cno.to library HTTP ${upstream.status}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const text = await upstream.text();
    const cacheHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=21600, s-maxage=21600",
      ...corsHeaders,
    });
    cachedResponse = new Response(text, { status: 200, headers: cacheHeaders });

    if (cache) {
      ctx?.waitUntil?.(cache.put(cacheKey, cachedResponse.clone())) || await cache.put(cacheKey, cachedResponse.clone()).catch(() => {});
    }
  }

  // If specific ID requested, return ONLY that anime's metadata (~150 bytes, zero VPS RAM!)
  if (Number.isFinite(anilistId) && anilistId > 0) {
    const data = await cachedResponse.json();
    const item = data.titles?.find((t) => t.id === anilistId);
    if (!item) {
      return new Response(JSON.stringify({ error: "Anime not found in cno library" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    return new Response(JSON.stringify(item.lib), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600, s-maxage=21600",
        "CF-Cache-Status": "HIT",
        ...corsHeaders,
      },
    });
  }

  // If entire library requested, return full JSON with 6-hour CDN cache
  return new Response(cachedResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=21600, s-maxage=21600",
      ...corsHeaders,
    },
  });
}

/**
 * Main Request Handler
 */
async function handleRequest(request, env = {}, ctx = null) {
  const corsHeaders = getDynamicCorsHeaders(request);

  // Validate Origin and Referer
  const reqOrigin = request.headers.get("origin") || request.headers.get("Origin");
  const reqReferer = request.headers.get("referer") || request.headers.get("Referer");
  if ((reqOrigin && !isOriginAllowed(reqOrigin)) || (reqReferer && !isOriginAllowed(reqReferer))) {
    return new Response(JSON.stringify({ error: "Forbidden: Unauthorized domain" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "null",
      },
    });
  }

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const reqUrl = new URL(request.url);

  // Cloudflare Global CDN endpoint for cno.to Library (6-hour Edge Cache)
  if (reqUrl.pathname.includes("/cno-library") || reqUrl.searchParams.has("cno_library")) {
    return handleCnoLibrary(request, reqUrl, env, ctx);
  }

  // Cloudflare Native Edge Cache: check if response already cached in Cloudflare CDN Edge
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache && request.method === "GET") {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      const respHeaders = new Headers(cachedResponse.headers);
      respHeaders.set("CF-Cache-Status", "HIT");
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: respHeaders,
      });
    }
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isLocal = reqUrl.hostname === "localhost" || reqUrl.hostname.startsWith("127.");
  const proto = forwardedProto || (isLocal ? (reqUrl.protocol ? reqUrl.protocol.replace(":", "") : "http") : "https");
  const proxyOrigin = `${proto}://${reqUrl.host}`;

  // Extract query parameters
  let target = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("target");

  // Support /proxy?https://... or /proxy? https://... (without url= parameter)
  if (!target && reqUrl.search) {
    const rawQuery = reqUrl.search.replace(/^\?/, "").trim();
    if (/^https?:\/\//i.test(rawQuery)) {
      target = rawQuery;
    } else {
      try {
        const decoded = decodeURIComponent(rawQuery).trim();
        if (/^https?:\/\//i.test(decoded)) target = decoded;
      } catch {}
    }
  }

  // Support /proxy/https://... (path-based)
  if (!target && reqUrl.pathname.startsWith("/proxy/http")) {
    target = reqUrl.pathname.replace(/^\/proxy\//, "") + (reqUrl.search || "");
  }

  const keyParam = reqUrl.searchParams.get("key") || reqUrl.searchParams.get("playlist_key") || "";
  const refererParam = reqUrl.searchParams.get("ref") || reqUrl.searchParams.get("referer") || "";

  // If no ?url is supplied, serve the Web Player UI
  if (!target) {
    return servePlayerUI(proxyOrigin);
  }

  // Show Web Player UI only if explicitly requested via ?player=true or ?ui=true
  if (reqUrl.searchParams.get("player") === "true" || reqUrl.searchParams.get("ui") === "true") {
    return servePlayerUI(proxyOrigin, target, keyParam, refererParam);
  }

  // Base64 decode URL if needed (handles b64: or encoded query)
  if (target.startsWith("b64:")) {
    try {
      target = atob(target.slice(4));
    } catch {}
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid target URL: " + target }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }

  // Auto-detect or parse referer & origin
  const detected = detectDefaultHeaders(targetUrl);
  const referer =
    reqUrl.searchParams.get("ref") ||
    reqUrl.searchParams.get("referer") ||
    detected.referer;
  const origin = reqUrl.searchParams.get("origin") || detected.origin;
  const userAgent = reqUrl.searchParams.get("ua") || DEFAULT_UA;
  const customHeadersParam = reqUrl.searchParams.get("headers");

  const context = {
    pathname: reqUrl.pathname,
    referer,
    origin,
    key: keyParam,
    ua: userAgent,
    customHeaders: customHeadersParam,
  };

  // Build upstream request headers
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", userAgent);
  if (referer) upstreamHeaders.set("Referer", referer);
  if (origin) upstreamHeaders.set("Origin", origin);
  upstreamHeaders.set("Accept", "*/*");
  upstreamHeaders.set("Accept-Language", "en-US,en;q=0.9");

  // Forward Range header if present (crucial for video chunking/seeking)
  const range = request.headers.get("Range");
  if (range) {
    upstreamHeaders.set("Range", range);
  }

  // Apply auto-detected extra headers (e.g. x-anitv-peek for cno.to)
  if (detected.extraHeaders) {
    for (const [k, v] of Object.entries(detected.extraHeaders)) {
      upstreamHeaders.set(k, v);
    }
  }

  // Parse additional custom headers from JSON if provided
  if (customHeadersParam) {
    try {
      const extra = JSON.parse(customHeadersParam);
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === "string") upstreamHeaders.set(k, v);
      }
    } catch {}
  }

  const isCfHost = targetUrl.hostname.toLowerCase().includes("settlar") ||
                   targetUrl.hostname.toLowerCase().includes("anipm") ||
                   targetUrl.hostname.toLowerCase().includes("cno.to");

  let upstreamResponse;
  const wreq = await getWreqFetch();

  if (isCfHost && wreq) {
    try {
      const headersObj = Object.fromEntries(upstreamHeaders.entries());
      upstreamResponse = await wreq(targetUrl.href, {
        method: request.method,
        headers: headersObj,
        redirect: "follow",
      });
    } catch {}
  }

  if (!upstreamResponse) {
    try {
      upstreamResponse = await fetch(targetUrl.href, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch (err) {
      if (wreq) {
        try {
          const headersObj = Object.fromEntries(upstreamHeaders.entries());
          upstreamResponse = await wreq(targetUrl.href, {
            method: request.method,
            headers: headersObj,
            redirect: "follow",
          });
        } catch (wreqErr) {
          return new Response(
            JSON.stringify({
              error: "Upstream fetch failed",
              details: wreqErr.message,
              target: targetUrl.href,
            }),
            {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }
      } else {
        return new Response(
          JSON.stringify({
            error: "Upstream fetch failed",
            details: err.message,
            target: targetUrl.href,
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
    }
  }

  let rawContentType = (upstreamResponse.headers.get("content-type") || "").toLowerCase();

  // If upstream returned 403 or HTML challenge when expecting media, retry once with wreq
  if (
    wreq &&
    !isCfHost &&
    (upstreamResponse.status === 403 || (upstreamResponse.status === 200 && rawContentType.includes("text/html")))
  ) {
    try {
      const headersObj = Object.fromEntries(upstreamHeaders.entries());
      const retryRes = await wreq(targetUrl.href, {
        method: request.method,
        headers: headersObj,
        redirect: "follow",
      });
      const retryContentType = (retryRes.headers.get("content-type") || "").toLowerCase();
      if (retryRes.status === 200 && !retryContentType.includes("text/html")) {
        upstreamResponse = retryRes;
        rawContentType = retryContentType;
      }
    } catch {}
  }

  // Final URL after any redirects
  const finalBaseUrl = upstreamResponse.url || targetUrl.href;

  // For MP4 files (e.g. Animegg / Vidcache): stream directly with Range & 206 Partial Content support
  const isMp4 =
    targetUrl.pathname.endsWith(".mp4") ||
    rawContentType.includes("video/mp4") ||
    finalBaseUrl.includes(".mp4");

  if (isMp4) {
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", "video/mp4");
    responseHeaders.set("Accept-Ranges", "bytes");

    const contentLen = upstreamResponse.headers.get("content-length");
    if (contentLen) responseHeaders.set("Content-Length", contentLen);

    const contentRange = upstreamResponse.headers.get("content-range");
    if (contentRange) responseHeaders.set("Content-Range", contentRange);

    const edgeCacheSetting = "public, max-age=31536000, s-maxage=31536000, immutable";
    responseHeaders.set("Cache-Control", edgeCacheSetting);
    responseHeaders.set("CDN-Cache-Control", edgeCacheSetting);
    responseHeaders.set("Cloudflare-CDN-Cache-Control", edgeCacheSetting);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  // Read raw payload for playlists and media segments
  const arrayBuf = await upstreamResponse.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuf);

  // Check if content is an M3U8 playlist directly from header bytes
  const isDirectExtM3U =
    rawBytes.length >= 7 &&
    rawBytes[0] === 0x23 && // '#'
    rawBytes[1] === 0x45 && // 'E'
    rawBytes[2] === 0x58 && // 'X'
    rawBytes[3] === 0x54 && // 'T'
    rawBytes[4] === 0x4d && // 'M'
    rawBytes[5] === 0x33 && // '3'
    rawBytes[6] === 0x55;   // 'U'

  const isM3U8Url =
    isDirectExtM3U ||
    targetUrl.pathname.endsWith(".m3u8") ||
    targetUrl.search.includes(".m3u8") ||
    targetUrl.href.includes(".m3u8") ||
    targetUrl.pathname.endsWith(".key") ||
    rawContentType.includes("application/vnd.apple.mpegurl") ||
    rawContentType.includes("application/x-mpegurl") ||
    rawContentType.includes("audio/x-mpegurl");

  // If this might be an M3U8 playlist or encryption key
  if (isM3U8Url) {
    const rawText = new TextDecoder("utf-8").decode(rawBytes);

    // Check if plain M3U8 or encrypted FlixCloud manifest
    const decryptedText = decryptFlixManifest(rawText, keyParam);

    if (decryptedText.startsWith("#EXTM3U")) {
      const rewritten = rewriteM3U8(decryptedText, finalBaseUrl, proxyOrigin, context);
      const isMaster = targetUrl.pathname.endsWith("master.m3u8");
      const cacheControl = isMaster
        ? "public, max-age=600, s-maxage=600"
        : "public, max-age=7200, s-maxage=7200";

      const playlistResponse = new Response(rewritten, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": cacheControl,
          "CDN-Cache-Control": cacheControl,
          "Cloudflare-CDN-Cache-Control": cacheControl,
        },
      });

      if (cache && request.method === "GET") {
        ctx?.waitUntil?.(cache.put(request, playlistResponse.clone()));
      }

      return playlistResponse;
    }

    // JSON response auto-rewriter (e.g. for AniClover api/watch JSON)
    if (rawContentType.includes("application/json") || rawContentType.includes("text/json")) {
      let jsonText = new TextDecoder("utf-8").decode(arrayBuf);
      try {
        const data = JSON.parse(jsonText);
        const rewriteUrl = (u) => {
          if (typeof u === "string" && (u.includes("zanora.xyz") || u.includes("m3u8-proxy"))) {
            return `${proxyOrigin}/proxy?url=${encodeURIComponent(u)}&ref=https%3A%2F%2Faniclover.cc%2F`;
          }
          return u;
        };

        if (data.streamUrl) data.streamUrl = rewriteUrl(data.streamUrl);
        if (Array.isArray(data.streams)) {
          for (const s of data.streams) {
            if (s.url) s.url = rewriteUrl(s.url);
          }
        }
        if (Array.isArray(data.sources)) {
          for (const s of data.sources) {
            if (s.file) s.file = rewriteUrl(s.file);
          }
        }
        if (Array.isArray(data.subtitles)) {
          for (const s of data.subtitles) {
            if (s.url) s.url = rewriteUrl(s.url);
            if (s.file) s.file = rewriteUrl(s.file);
          }
        }
        if (Array.isArray(data.tracks)) {
          for (const t of data.tracks) {
            if (t.file) t.file = rewriteUrl(t.file);
          }
        }
        if (data.thumbnails) data.thumbnails = rewriteUrl(data.thumbnails);
        jsonText = JSON.stringify(data, null, 2);
      } catch {}

      return new Response(jsonText, {
        status: upstreamResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Binary key or other text response
    return new Response(arrayBuf, {
      status: upstreamResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": rawContentType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
        "CDN-Cache-Control": "public, max-age=86400",
      },
    });
  }

  // For media segments (.ts, .m4s, disguised .png / .webp chunks, etc.)
  const { data: segmentBytes, isTs } = unwrapFlixSegment(arrayBuf);

  const responseHeaders = new Headers(corsHeaders);
  if (isTs || (segmentBytes.length > 0 && segmentBytes[0] === 0x47)) {
    responseHeaders.set("Content-Type", "video/mp2t");
  } else if (rawContentType) {
    responseHeaders.set("Content-Type", rawContentType);
  } else {
    responseHeaders.set("Content-Type", "video/mp2t");
  }

  responseHeaders.set("Content-Length", String(segmentBytes.byteLength));
  responseHeaders.set("Accept-Ranges", "bytes");

  // Extreme Edge Caching (1 Year) for Cloudflare CDN Edge nodes
  const edgeCacheSetting = "public, max-age=31536000, s-maxage=31536000, immutable";
  responseHeaders.set("Cache-Control", edgeCacheSetting);
  responseHeaders.set("CDN-Cache-Control", edgeCacheSetting);
  responseHeaders.set("Cloudflare-CDN-Cache-Control", edgeCacheSetting);

  const segmentResponse = new Response(segmentBytes, {
    status: 200,
    statusText: "OK",
    headers: responseHeaders,
  });

  if (cache && request.method === "GET") {
    ctx?.waitUntil?.(cache.put(request, segmentResponse.clone()));
  }

  return segmentResponse;
}

/**
 * Built-in Web Video Player UI for testing
 */
function servePlayerUI(proxyOrigin, initialUrl = "", initialKey = "", initialRef = "") {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metsu Stream Proxy | Cloudflare Pages</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card: #121927;
      --border: #1f2a3d;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent: #06b6d4;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at top, #131b2e 0%, var(--bg) 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    .container {
      width: 100%;
      max-width: 960px;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    .header {
      text-align: center;
    }
    .header h1 {
      font-size: 2.2rem;
      background: linear-gradient(135deg, #a5b4fc, #38bdf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .header p {
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
      margin-bottom: 0.75rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
    }
    input, select {
      background: #0c121e;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.75rem 1rem;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: all 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    @media (max-width: 640px) {
      .row { grid-template-columns: 1fr; }
    }
    .btn {
      background: linear-gradient(135deg, var(--primary), var(--primary-hover));
      color: white;
      border: none;
      border-radius: 10px;
      padding: 0.85rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
    }
    .video-container {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .url-output {
      margin-top: 1rem;
      background: #090d16;
      border: 1px solid var(--border);
      padding: 0.75rem;
      border-radius: 8px;
      font-family: monospace;
      font-size: 0.82rem;
      word-break: break-all;
      color: #38bdf8;
      cursor: pointer;
    }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge">🚀 Cloudflare Pages / Worker Proxy</div>
      <h1>Metsu HLS Stream Proxy</h1>
      <p>High-speed, zero-bandwidth-drain proxy for Reanime, Anikoto, and HLS streams</p>
    </div>

    <div class="card" style="border-color: #6366f1; background: rgba(99, 102, 241, 0.05);">
      <h3 style="margin-bottom: 0.75rem; color: #a5b4fc; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
        ⚡ Quick Anime Player (Reanime / Anikoto)
      </h3>
      <div class="row">
        <div class="form-group">
          <label for="quickProvider">Provider</label>
          <select id="quickProvider">
            <option value="reanime">Reanime (Flixcloud Encrypted)</option>
            <option value="anikoto">Anikoto (Megaplay / HiAnime)</option>
            <option value="animegg">Animegg (Direct MP4)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="quickAnilistId">AniList ID (e.g. 16498 for Attack on Titan)</label>
          <input type="text" id="quickAnilistId" value="16498" />
        </div>
      </div>
      <div class="row">
        <div class="form-group">
          <label for="quickAudio">Audio</label>
          <select id="quickAudio">
            <option value="sub">Sub (Japanese + English Sub)</option>
            <option value="dub">Dub (English)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="quickEp">Episode</label>
          <input type="number" id="quickEp" value="1" min="1" />
        </div>
      </div>
      <button class="btn" style="background: linear-gradient(135deg, #06b6d4, #6366f1);" onclick="loadAndPlayQuickAnime()">
        ⚡ Fetch & Play Anime from Reanime/Anikoto
      </button>
      <div id="quickStatus" style="font-size: 0.85rem; color: #38bdf8; margin-top: 0.5rem; display: none;"></div>
    </div>

    <div class="card">
      <div class="video-container">
        <video id="player" controls playsinline></video>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 0.75rem; font-size: 1rem; color: var(--text-muted);">Custom M3U8 Stream Tester</h3>
      <div class="form-group">
        <label for="streamUrl">M3U8 Stream URL</label>
        <input type="text" id="streamUrl" placeholder="https://.../master.m3u8" />
      </div>

      <div class="row">
        <div class="form-group">
          <label for="key">FlixCloud Decryption Key (For Reanime)</label>
          <input type="text" id="key" placeholder="VxTj7nxvuWLVckZi6HU..." />
        </div>
        <div class="form-group">
          <label for="referer">Referer Header</label>
          <input type="text" id="referer" placeholder="https://reanime.to/ or https://flixcloud.cc/" />
        </div>
      </div>

      <button class="btn" onclick="playStream()">▶ Play Custom M3U8</button>

      <div id="outputBox" style="display: none;">
        <div class="status-badge"><span class="dot"></span> Proxied Stream URL (Click to copy):</div>
        <div class="url-output" id="proxiedUrlDisplay" onclick="copyUrl()"></div>
      </div>
    </div>
  </div>

  <script>
    const proxyBase = window.location.origin + window.location.pathname.replace(/\\/$/, "");
    let hls = null;

    async function loadAndPlayQuickAnime() {
      const provider = document.getElementById("quickProvider").value;
      const anilistId = document.getElementById("quickAnilistId").value.trim();
      const audio = document.getElementById("quickAudio").value;
      const ep = document.getElementById("quickEp").value.trim();
      const status = document.getElementById("quickStatus");

      if (!anilistId) return alert("Please enter an AniList ID");

      status.style.display = "block";
      status.textContent = "⏳ Fetching stream details from " + provider + "...";

      try {
        const apiUrl = window.location.origin + "/watch/" + provider + "/" + anilistId + "/" + audio + "/" + provider + "-" + ep;
        const res = await fetch(apiUrl);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || ("API returned status " + res.status));
        }
        const data = await res.json();
        const streamUrl = data.stream_url || data.streams?.[0]?.url;
        if (!streamUrl) throw new Error("No stream URL found in API response");

        const key = data.key || data.playlist_key || data.streams?.[0]?.playlist_key || data.streams?.[0]?.key || "";
        const referer = (provider === "reanime") ? "https://flixcloud.cc/" : (provider === "animegg" ? "https://www.animegg.org/" : (data.streams?.[0]?.referer || data.headers?.Referer || "https://hianimes.re/"));

        document.getElementById("streamUrl").value = streamUrl;
        document.getElementById("key").value = key;
        document.getElementById("referer").value = referer;

        status.textContent = "✅ Loaded: " + (data.anime || "Anime") + " Ep " + ep + " (" + (data.server || "Stream") + "). Starting playback...";

        playStream();
      } catch (err) {
        status.textContent = "❌ Failed: " + err.message;
      }
    }

    function playStream() {
      const rawUrl = document.getElementById("streamUrl").value.trim();
      const referer = document.getElementById("referer").value.trim();
      const key = document.getElementById("key").value.trim();
      if (!rawUrl) return alert("Please enter an M3U8 URL");

      const u = new URL(proxyBase + (proxyBase.endsWith("/") ? "" : "/"));
      u.searchParams.set("url", rawUrl);
      if (referer) u.searchParams.set("ref", referer);
      if (key) u.searchParams.set("key", key);

      const proxiedUrl = u.toString();
      document.getElementById("proxiedUrlDisplay").textContent = proxiedUrl;
      document.getElementById("outputBox").style.display = "block";

      const video = document.getElementById("player");
      const isMp4 = rawUrl.includes(".mp4") || proxiedUrl.includes(".mp4");

      if (isMp4) {
        if (hls) {
          hls.destroy();
          hls = null;
        }
        video.src = proxiedUrl;
        video.muted = true;
        video.play().catch((err) => {
          console.log("Autoplay blocked, click play on video player:", err);
        });
      } else if (Hls.isSupported()) {
        if (hls) hls.destroy();
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
        });
        hls.loadSource(proxiedUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.muted = true; // Chrome/Edge requires muted for instant autoplay
          video.play().catch((err) => {
            console.log("Autoplay blocked, click play on video player:", err);
          });
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error("HLS Error:", data);
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = proxiedUrl;
        video.play().catch(() => {});
      }
    }

    function copyUrl() {
      const text = document.getElementById("proxiedUrlDisplay").textContent;
      navigator.clipboard.writeText(text).then(() => {
        alert("Copied to clipboard!");
      });
    }

    const initUrl = ${JSON.stringify(initialUrl)};
    const initKey = ${JSON.stringify(initialKey)};
    const initRef = ${JSON.stringify(initialRef)};

    window.addEventListener("DOMContentLoaded", () => {
      if (initUrl) {
        document.getElementById("streamUrl").value = initUrl;
        if (initKey) document.getElementById("key").value = initKey;
        if (initRef) document.getElementById("referer").value = initRef;
        setTimeout(playStream, 100);
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// Support both Cloudflare Workers & Cloudflare Pages Functions
export default {
  async fetch(request, env = {}, ctx = null) {
    return handleRequest(request, env, ctx);
  },
};
