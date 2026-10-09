const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function canExtractRubystm(url) {
  return /(?:rubystm\.com|streamruby\.com)/i.test(String(url));
}

function unpack(p, a, c, k) {
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp("\\b" + c.toString(a) + "\\b", "g"), k[c]);
    }
  }
  return p;
}

/**
 * Extracts master.m3u8 from Rubystm / StreamRuby packed players.
 */
export async function extractRubystm(embedUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const cleanUrl = String(embedUrl).replace("/e/", "/");
  const res = await fetchImpl(cleanUrl, {
    headers: {
      "User-Agent": userAgent,
      "Referer": "https://rubystm.com/"
    }
  });

  if (!res.ok) throw new Error(`Rubystm HTTP ${res.status}`);
  const html = await res.text();

  const match = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?return p\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/);
  if (!match) throw new Error("Rubystm: Packed playerjs script not found");

  const p = match[1];
  const a = parseInt(match[2], 10);
  const c = parseInt(match[3], 10);
  const k = match[4].split("|");
  const unpacked = unpack(p, a, c, k);

  const fileMatch = unpacked.match(/sources:\s*\[\s*\{\s*file:\s*["']([^"']+)["']/i);
  if (!fileMatch) throw new Error("Rubystm: Video file URL not found in unpacked script");

  return {
    streamUrl: fileMatch[1],
    type: "hls"
  };
}
