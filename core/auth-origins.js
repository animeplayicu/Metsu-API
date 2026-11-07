const ALLOWED_DOMAINS = [
  // User frontend domains & subdomains
  "animetsu.site",
  "animetsu.me",
  "animetsu.de",
  "animetsu.us",
  "aniflix.uno",
  "aniflix.in",
  "aniflix.us",
  // Localhost development
  "localhost",
  "127.0.0.1",
  // Internal streaming upstreams
  "flixcloud.cc",
  "reanime.to",
  "anidream.to",
  "beta.cno.to",
  "cno.to",
  "ani.pm",
];

export function isDomainAllowed(originOrReferer) {
  if (!originOrReferer) return true; // Direct server / backend / curl calls without browser origin
  try {
    const parsed = new URL(originOrReferer);
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

export function validateRequestOrigin(request) {
  const origin = request.headers.get("origin") || request.headers.get("Origin");
  if (origin && !isDomainAllowed(origin)) {
    return false;
  }
  const referer = request.headers.get("referer") || request.headers.get("Referer");
  if (referer && !isDomainAllowed(referer)) {
    return false;
  }
  return true;
}

export function getCorsHeaders(request) {
  const origin = request?.headers?.get?.("origin") || request?.headers?.get?.("Origin");
  const referer = request?.headers?.get?.("referer") || request?.headers?.get?.("Referer");
  let allowOrigin = "https://animetsu.site";
  if (origin && isDomainAllowed(origin)) {
    allowOrigin = origin;
  } else if (referer && isDomainAllowed(referer)) {
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
