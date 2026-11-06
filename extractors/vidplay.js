const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export function canExtractVidplay(url) {
  const str = String(url);
  return (
    /(?:echovideo|vhscdn|vidplay|mycloud|mcloud|vizcloud)\.[a-z0-9.-]+\/embed-[012]\//i.test(str) ||
    /\/embed-[012]\/[a-zA-Z0-9_-]+/i.test(str)
  );
}

export async function extractVidplay(embedUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const url = new URL(String(embedUrl));
  const match = url.pathname.match(/^\/(embed-[012])\/([^/]+)$/i);
  const type = match?.[1];
  const id = match?.[2];
  if (!id) throw new Error(`Cannot extract Vidplay id from ${embedUrl}`);
  const endpoint = new URL(`/${type}/getSources`, url.origin);
  endpoint.searchParams.set("id", id);
  for (const [k, v] of url.searchParams.entries()) {
    if (k !== "id") endpoint.searchParams.set(k, v);
  }
  const response = await fetchImpl(endpoint.href, {
    headers: {
      "User-Agent": userAgent,
      "Referer": embedUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!response.ok) throw new Error(`Vidplay sources HTTP ${response.status}`);
  const data = await response.json();
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const intro = data?.intro?.start || data?.intro?.end ? data.intro : null;
  const outro = data?.outro?.start || data?.outro?.end ? data.outro : null;

  const sources = [];
  if (typeof data?.sources === "string" && data.sources) {
    sources.push({
      url: data.sources,
      type: data.sources.includes(".m3u8") ? "hls" : "mp4",
      quality: "auto",
      server: "Vidplay",
      tracks,
      intro,
      outro,
    });
  } else if (Array.isArray(data?.sources)) {
    for (const item of data.sources) {
      const srcUrl = typeof item === "string" ? item : item?.file ?? item?.url;
      if (srcUrl) {
        sources.push({
          url: srcUrl,
          type: srcUrl.includes(".m3u8") ? "hls" : "mp4",
          quality: item?.label || "auto",
          server: "Vidplay",
          tracks,
          intro,
          outro,
        });
      }
    }
  }
  if (!sources.length) throw new Error("Vidplay response has no sources");
  return sources;
}
