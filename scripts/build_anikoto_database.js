import fs from "node:fs";
import path from "node:path";
import { decodeEntities } from "../core/new-provider-utils.js";

const BASE = "https://anikototv.bz";
const DB_PATH = path.resolve(process.cwd(), "data/anikoto_database.json");
const STATE_PATH = path.resolve(process.cwd(), "data/.anikoto_state.json");
const ANIPM_PATH = path.resolve(process.cwd(), "data/anipmbeta_library.json");

const TOTAL_PAGES = 311;
const CONCURRENCY = 2; // Polite concurrency to prevent HTTP 429
const DELAY_MS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function cleanSlug(slug) {
  return (slug || "")
    .replace(/-[a-f0-9]{5}$/i, "")
    .replace(/-[a-z0-9]{5}$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

console.log("Loading AniPM Beta reference library for AniList ID mapping...");
const anipmData = JSON.parse(fs.readFileSync(ANIPM_PATH, "utf8"));
const anipmTitles = Object.values(anipmData.titles || {});

const titleLookup = new Map();
const slugLookup = new Map();

for (const item of anipmTitles) {
  if (!item.id) continue;
  const entry = { anilist_id: item.id, mal_id: item.mal || null };

  if (item.title) titleLookup.set(normalize(item.title), entry);
  if (item.native) titleLookup.set(normalize(item.native), entry);
  if (item.lib?.folder) {
    const slugPart = item.lib.folder.replace(/^\d+-/, "");
    slugLookup.set(cleanSlug(slugPart), entry);
  }
}
console.log(`Indexed ${titleLookup.size} normalized titles and ${slugLookup.size} slugs.`);

async function scrapePage(pageNum, retries = 5) {
  const url = `${BASE}/filter?page=${pageNum}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,*/*",
          "Referer": `${BASE}/`,
        },
      });

      if (res.status === 429) {
        const waitTime = attempt * 4000;
        console.warn(`[Page ${pageNum}] Rate limited (429), pausing ${waitTime / 1000}s...`);
        await sleep(waitTime);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      const parts = html.split('<div class="item ">').slice(1);
      const items = [];

      for (const block of parts) {
        const showId = block.match(/data-tip="(\d+)"/)?.[1] || null;
        const slug = block.match(/href="https:\/\/anikototv\.bz\/watch\/([^"/?#]+)/)?.[1] || null;
        const nameMatch = block.match(/<a class="name d-title"[^>]*>([\s\S]*?)<\/a>/i);
        const jpMatch = block.match(/data-jp="([^"]*)"/i);
        const typeMatch = block.match(/<div class="right">([^<]+)<\/div>/i);

        const subMatch = block.match(/<span class="ep-status sub"><span>\s*(\d+)<\/span><\/span>/i);
        const dubMatch = block.match(/<span class="ep-status dub"><span>\s*(\d+)<\/span><\/span>/i);
        const totalMatch = block.match(/<span class="ep-status total"><span>\s*(\d+)<\/span><\/span>/i);

        if (slug) {
          const title = nameMatch ? decodeEntities(nameMatch[1].replace(/<[^>]*>/g, "").trim()) : slug;
          const jpTitle = jpMatch ? decodeEntities(jpMatch[1].trim()) : null;

          let match = titleLookup.get(normalize(title)) ||
                      (jpTitle ? titleLookup.get(normalize(jpTitle)) : null) ||
                      slugLookup.get(cleanSlug(slug)) ||
                      null;

          items.push({
            show_id: showId ? Number(showId) : null,
            slug,
            title,
            jp_title: jpTitle,
            type: typeMatch ? typeMatch[1].trim() : null,
            anilist_id: match?.anilist_id || null,
            mal_id: match?.mal_id || null,
            episodes: {
              sub: subMatch ? Number(subMatch[1]) : 0,
              dub: dubMatch ? Number(dubMatch[1]) : 0,
              total: totalMatch ? Number(totalMatch[1]) : null,
            },
          });
        }
      }
      return items;
    } catch (err) {
      if (attempt === retries) {
        console.error(`[Page ${pageNum}] Failed after ${retries} attempts:`, err.message);
        return [];
      }
      await sleep(1500 * attempt);
    }
  }
  return [];
}

async function run() {
  console.log(`Starting Anikoto Database builder across ${TOTAL_PAGES} pages...`);

  let db = {
    updated_at: new Date().toISOString(),
    total_anime: 0,
    by_slug: {},
    by_show_id: {},
    by_anilist: {},
    by_mal: {},
  };

  let startPage = 1;
  if (fs.existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      startPage = (state.last_page || 0) + 1;
      if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
        console.log(`Resuming from page ${startPage} (already loaded ${Object.keys(db.by_slug).length} titles).`);
      }
    } catch {}
  }

  const startTime = Date.now();

  for (let page = startPage; page <= TOTAL_PAGES; page += CONCURRENCY) {
    const batchPages = [];
    for (let i = 0; i < CONCURRENCY && page + i <= TOTAL_PAGES; i++) {
      batchPages.push(page + i);
    }

    const batchResults = await Promise.all(batchPages.map((p) => scrapePage(p)));

    for (const items of batchResults) {
      for (const item of items) {
        db.by_slug[item.slug] = item;
        if (item.show_id) db.by_show_id[String(item.show_id)] = item;
        if (item.anilist_id) {
          const alKey = String(item.anilist_id);
          const current = db.by_anilist[alKey];
          if (!current || (item.episodes.sub + item.episodes.dub > (current.episodes?.sub || 0) + (current.episodes?.dub || 0))) {
            db.by_anilist[alKey] = item;
          }
        }
        if (item.mal_id) {
          const malKey = String(item.mal_id);
          const current = db.by_mal[malKey];
          if (!current || (item.episodes.sub + item.episodes.dub > (current.episodes?.sub || 0) + (current.episodes?.dub || 0))) {
            db.by_mal[malKey] = item;
          }
        }
      }
    }

    const lastBatchPage = batchPages[batchPages.length - 1];
    db.total_anime = Object.keys(db.by_slug).length;
    db.updated_at = new Date().toISOString();

    // Checkpoint every 10 pages or at the end
    if (lastBatchPage % 10 === 0 || lastBatchPage >= TOTAL_PAGES) {
      fs.writeFileSync(DB_PATH, JSON.stringify(db));
      fs.writeFileSync(STATE_PATH, JSON.stringify({ last_page: lastBatchPage }));

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const matchedAl = Object.keys(db.by_anilist).length;
      console.log(`[Page ${lastBatchPage}/${TOTAL_PAGES}] Titles: ${db.total_anime} (AniList mapped: ${matchedAl}) | Elapsed: ${elapsedSec}s`);
    }

    await sleep(DELAY_MS);
  }

  // Cleanup state file when finished
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
  }

  const finalSizeMB = (fs.statSync(DB_PATH).size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Anikoto Database build complete!`);
  console.log(`Total Anime Titles: ${db.total_anime}`);
  console.log(`Mapped AniList IDs: ${Object.keys(db.by_anilist).length}`);
  console.log(`Database File: data/anikoto_database.json (${finalSizeMB} MB)`);
}

run().catch(console.error);
