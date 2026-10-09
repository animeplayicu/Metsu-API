const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE_DURL = "https://hugh.cdn.rumble.cloud/video/";
const QUALITY_CODES = ["oaa", "baa", "caa", "gaa", "haa"];
const QUALITY_LABELS = ["240p", "360p", "480p", "720p", "1080p"];

export function canExtractBlakite(url) {
  return /blakiteapi\.xyz/i.test(String(url));
}

/**
 * Extracts direct .m3u8 (HLS) and .mp4 stream links from BlakiteAPI.
 */
export async function extractBlakite(embedUrl, { tmdbId, episodeId, fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  let finalTmdbId = tmdbId;
  let finalEpId = episodeId;

  if (!finalTmdbId || !finalEpId) {
    const m = String(embedUrl).match(/blakiteapi\.xyz\/embed\/(\d+)\/([^/?#]+)/i);
    if (m) {
      finalTmdbId = finalTmdbId || m[1];
      finalEpId = finalEpId || m[2];
    }
  }

  if (!finalTmdbId) {
    throw new Error(`BlakiteAPI: Cannot determine tmdbId from ${embedUrl}`);
  }

  const apiUrl = finalEpId
    ? `https://blakiteapi.xyz/api/get.php?id=${encodeURIComponent(finalEpId)}&tmdbId=${encodeURIComponent(finalTmdbId)}`
    : `https://blakiteapi.xyz/api/get.php?tmdbId=${encodeURIComponent(finalTmdbId)}`;

  const res = await fetchImpl(apiUrl, {
    headers: {
      "User-Agent": userAgent,
      "Referer": "https://blakiteapi.xyz/"
    }
  });

  if (!res.ok) throw new Error(`BlakiteAPI HTTP ${res.status}`);
  const result = await res.json();

  if (!result?.success || !result?.data?.dataId) {
    throw new Error("BlakiteAPI: Invalid response or video dataId missing");
  }

  const { dataId, format, ranges, animeTitle, poster } = result.data;
  const streams = [];

  if (format === "M3U8" && ranges) {
    const rangeLines = ranges.split("\n").map(l => l.trim()).filter(Boolean);
    const rangeMap = {};
    for (const line of rangeLines) {
      const match = line.match(/^(\d+-\d+)\s*\(([^)]+)\)/);
      if (match) {
        rangeMap[match[2].trim().toLowerCase()] = match[1];
      }
    }

    for (let i = QUALITY_LABELS.length - 1; i >= 0; i--) {
      const label = QUALITY_LABELS[i];
      const range = rangeMap[label.toLowerCase()];
      if (range) {
        const code = QUALITY_CODES[i];
        const url = `${BASE_DURL}${dataId}.${code}.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl&r_range=${range}`;
        streams.push({
          quality: label,
          type: "hls",
          url
        });
      }
    }
  } else {
    // MP4 streams (1080p, 720p, 480p, 360p, 240p)
    for (let i = QUALITY_LABELS.length - 1; i >= 0; i--) {
      const label = QUALITY_LABELS[i];
      const code = QUALITY_CODES[i];
      const url = `${BASE_DURL}${dataId}.${code}.mp4`;
      streams.push({
        quality: label,
        type: "mp4",
        url
      });
    }
  }

  return {
    animeTitle,
    poster: poster || null,
    format: format || "M3U8",
    streams
  };
}
