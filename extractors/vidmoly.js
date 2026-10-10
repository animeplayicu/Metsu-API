import https from "node:https";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const dnsCache = new Map();

/**
 * Resolves hostname via Cloudflare DNS over HTTPS (DoH)
 * to bypass local ISP DNS hijacking (e.g. Airtel/Jio block on vidmoly).
 */
async function resolveDoH(hostname) {
  if (dnsCache.has(hostname)) return dnsCache.get(hostname);
  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { "accept": "application/dns-json" }
    });
    const data = await res.json();
    const ip = data?.Answer?.find(a => a.type === 1)?.data;
    if (ip) {
      dnsCache.set(hostname, ip);
      return ip;
    }
  } catch {
    // Fall back to native DNS
  }
  return null;
}

/**
 * Custom fetcher that connects directly to the resolved IP with correct SNI/Host,
 * handling redirects automatically.
 */
async function fetchWithDoH(urlStr, options = {}, maxRedirects = 4) {
  if (maxRedirects <= 0) throw new Error("Too many redirects");
  const url = new URL(urlStr);
  const dohIp = await resolveDoH(url.hostname);

  if (!dohIp) {
    const res = await fetch(urlStr, options);
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: async () => text
    };
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: dohIp,
      port: 443,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: {
        ...(options.headers || {}),
        "Host": url.hostname
      },
      servername: url.hostname
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith("/")) {
          redirectUrl = `${url.protocol}//${url.hostname}${redirectUrl}`;
        }
        fetchWithDoH(redirectUrl, options, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => data
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

export function canExtractVidmoly(url) {
  return /vidmoly\.(net|biz|to|org)/i.test(String(url));
}

/**
 * Extracts HLS stream (.m3u8) links from Vidmoly embed.
 * Returns both the Master HLS and individual resolution streams (e.g. 720p, 360p).
 */
export async function extractVidmoly(embedUrl, { userAgent = DEFAULT_USER_AGENT, referer } = {}) {
  let url = String(embedUrl).startsWith("//") ? `https:${embedUrl}` : String(embedUrl);

  const response = await fetchWithDoH(url, {
    headers: {
      "User-Agent": userAgent,
      "Referer": referer ?? "https://piratexplay.cc/"
    }
  });

  if (!response.ok) throw new Error(`Vidmoly fetch HTTP ${response.status}`);
  const html = await response.text();

  const match = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
  if (!match) throw new Error("Vidmoly m3u8 not found in embed HTML");

  const masterUrl = match[1];
  const streams = [
    {
      quality: "auto",
      url: masterUrl,
      type: "hls",
      isMaster: true
    }
  ];

  // Try parsing the individual sub-renditions (e.g. 720p, 360p) from master.m3u8
  try {
    const m3u8Res = await fetch(masterUrl, {
      headers: {
        "User-Agent": userAgent,
        "Referer": "https://vidmoly.biz/"
      }
    });

    if (m3u8Res.ok) {
      const m3u8Text = await m3u8Res.text();
      const lines = m3u8Text.split("\n").map(l => l.trim());
      const audios = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
          const nameMatch = line.match(/NAME="([^"]+)"/i);
          const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
          const uriMatch = line.match(/URI="([^"]+)"/i);
          const defMatch = /DEFAULT=YES/i.test(line);
          audios.push({
            name: nameMatch ? nameMatch[1] : "Audio",
            language: langMatch ? langMatch[1] : null,
            default: defMatch,
            url: uriMatch ? uriMatch[1] : null
          });
        } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.startsWith("#")) {
            let quality = "default";
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
            if (resMatch) {
              const h = resMatch[1].split("x")[1];
              quality = `${h}p`;
            }
            streams.push({
              quality,
              url: nextLine,
              type: "hls",
              isMaster: false
            });
          }
        }
      }

      return {
        masterUrl,
        audios,
        streams
      };
    }
  } catch {
    // If master fetch fails, we still return the masterUrl stream
  }

  return {
    masterUrl,
    audios: [],
    streams
  };
}

