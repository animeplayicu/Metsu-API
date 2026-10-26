const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export function canExtractDataSv(url) {
  return /play\.echovideo\.ru\/embed-(?:20|21|\d+)\//i.test(String(url));
}

export async function extractDataSv(embedUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const url = new URL(String(embedUrl));
  const match = url.pathname.match(/^\/embed-(\d+)\/([^/]+)$/i);
  if (!match) throw new Error(`Cannot extract DATASV / MuL-AuD id from ${embedUrl}`);
  const [, embedNum, id] = match;
  const endpoint = new URL(`/embed-${embedNum}/getSources`, url.origin);
  endpoint.searchParams.set("id", id);
  const response = await fetchImpl(endpoint, {
    headers: {
      "User-Agent": userAgent,
      "Referer": embedUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!response.ok) throw new Error(`DATASV / MuL-AuD sources HTTP ${response.status}`);
  const data = await response.json();
  const sources = [];
  const isMulti = embedNum === "21";
  const serverName = isMulti ? "MuL-AuD" : "DatSaV";
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const intro = data?.intro?.start || data?.intro?.end ? data.intro : null;
  const outro = data?.outro?.start || data?.outro?.end ? data.outro : null;

  if (typeof data?.sources === "string" && data.sources) {
    sources.push({
      url: data.sources,
      type: data.sources.includes(".m3u8") ? "hls" : "mp4",
      quality: "auto",
      server: serverName,
      isMultiAudio: isMulti,
      tracks,
      intro,
      outro,
    });
  } else if (data?.sources && typeof data.sources === "object") {
    for (const [quality, urls] of Object.entries(data.sources)) {
      for (const source of Array.isArray(urls) ? urls : [urls]) {
        if (typeof source === "string" && source) {
          sources.push({
            url: source,
            type: source.includes(".m3u8") ? "hls" : "mp4",
            quality,
            server: serverName,
            isMultiAudio: isMulti,
            tracks,
            intro,
            outro,
          });
        }
      }
    }
  }

  if (!sources.length) throw new Error("DATASV / MuL-AuD response has no sources");

  const available = await Promise.all(sources.map(async (source) => {
    try {
      const check = await fetchImpl(source.url, {
        method: "GET",
        headers: { "User-Agent": userAgent, "Referer": `${url.origin}/`, "Range": "bytes=0-0" },
      });
      return (check.ok || check.status === 206) ? source : null;
    } catch {
      return source; // keep source on network blip
    }
  }));

  const valid = available.filter(Boolean);
  return valid.length ? valid : sources;
}

