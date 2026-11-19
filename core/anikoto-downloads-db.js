import fs from "node:fs";
import path from "node:path";

const DOWNLOADS_DB_PATH = path.resolve(process.cwd(), "data/anikoto_downloads.json");

let DOWNLOADS_DB = {
  by_anilist: {},
  by_mal: {}
};
let lastDownloadsMtime = 0;
let isDirty = false;
let flushTimer = null;

export function loadDownloadsDb() {
  try {
    if (fs.existsSync(DOWNLOADS_DB_PATH)) {
      const stat = fs.statSync(DOWNLOADS_DB_PATH);
      if (stat.mtimeMs > lastDownloadsMtime) {
        DOWNLOADS_DB = JSON.parse(fs.readFileSync(DOWNLOADS_DB_PATH, "utf8"));
        if (!DOWNLOADS_DB.by_anilist) DOWNLOADS_DB.by_anilist = {};
        if (!DOWNLOADS_DB.by_mal) DOWNLOADS_DB.by_mal = {};
        lastDownloadsMtime = stat.mtimeMs;
      }
    }
  } catch (err) {
    console.error("[DownloadsDB] Error loading database:", err.message);
  }
  return DOWNLOADS_DB;
}

export function getDownloadsFromDb(anilistId, epNum, audio = "sub") {
  loadDownloadsDb();
  const idStr = String(anilistId);
  const anime = DOWNLOADS_DB.by_anilist?.[idStr];
  if (!anime) return null;

  const epStr = String(epNum);
  const epData = anime.episodes?.[epStr];
  if (!epData) return null;

  const audioData = epData[audio];
  if (!audioData) return null;

  return {
    anilistId: parseInt(anilistId, 10),
    malId: anime.mal_id || null,
    title: anime.title || null,
    episode: Number(epNum),
    audio,
    downloads: audioData.downloads || [],
    source: "database_cache",
    cached_at: epData.cached_at || null
  };
}

export function saveDownloadsToDb(anilistId, malId, title, epNum, audio = "sub", downloads = []) {
  if (!anilistId || !epNum || !downloads.length) return;
  loadDownloadsDb();

  const idStr = String(anilistId);
  if (!DOWNLOADS_DB.by_anilist[idStr]) {
    DOWNLOADS_DB.by_anilist[idStr] = {
      anilist_id: parseInt(anilistId, 10),
      mal_id: malId ? parseInt(malId, 10) : null,
      title: title || null,
      episodes: {}
    };
  }

  const anime = DOWNLOADS_DB.by_anilist[idStr];
  if (malId) {
    anime.mal_id = parseInt(malId, 10);
    DOWNLOADS_DB.by_mal[String(malId)] = parseInt(anilistId, 10);
  }
  if (title && !anime.title) {
    anime.title = title;
  }

  const epStr = String(epNum);
  if (!anime.episodes[epStr]) {
    anime.episodes[epStr] = {
      cached_at: Date.now()
    };
  }

  anime.episodes[epStr][audio] = {
    downloads,
    updated_at: Date.now()
  };

  scheduleFlush();
}

function scheduleFlush() {
  isDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDisk();
  }, 1000);
}

export function flushToDisk() {
  if (!isDirty) return;
  try {
    fs.writeFileSync(DOWNLOADS_DB_PATH, JSON.stringify(DOWNLOADS_DB, null, 2), "utf8");
    lastDownloadsMtime = fs.statSync(DOWNLOADS_DB_PATH).mtimeMs;
    isDirty = false;
  } catch (err) {
    console.error("[DownloadsDB] Error writing to disk:", err.message);
  }
}

// Initial load
loadDownloadsDb();
