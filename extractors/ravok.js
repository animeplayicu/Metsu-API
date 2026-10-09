const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function canExtractRavok(url) {
  return /ravok\.buzz\/video\/([a-z0-9]+)/i.test(String(url));
}

/**
 * Extracts signed master.m3u8 and metadata from Ravok Buzz video embeds.
 */
export async function extractRavok(url, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, referer = "https://piratexplay.cc/" } = {}) {
  const m = String(url).match(/video\/([a-z0-9]+)/i);
  if (!m) throw new Error(`Invalid Ravok video URL: ${url}`);
  const hash = m[1];

  const postUrl = `https://ravok.buzz/player/index.php?data=${hash}&do=getVideo`;
  const res = await fetchImpl(postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": userAgent,
      "Referer": `https://ravok.buzz/video/${hash}`
    },
    body: new URLSearchParams({
      hash,
      r: referer
    }).toString()
  });

  if (!res.ok) throw new Error(`Ravok HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.videoSource) throw new Error("Ravok: videoSource not found in response");

  return {
    streamUrl: data.videoSource,
    poster: data.videoImage || null,
    hls: data.hls ?? true
  };
}
