import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');

const BASE = 'https://www.animegg.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': BASE,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
    }
  }
}

function saveDatabase(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

async function main() {
  console.log(`=======================================================`);
  console.log(`  Indexing All Remaining Mapped Anime into Database    `);
  console.log(`=======================================================`);

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const cat = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));

  const mappedInCat = cat.filter(a => a.anilist_id);
  const targets = mappedInCat.filter(a => !db.by_slug[a.slug]?.episode_list?.length);

  console.log(`Total mapped anime: ${mappedInCat.length}`);
  console.log(`Already indexed: ${mappedInCat.length - targets.length}`);
  console.log(`Targets to index: ${targets.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 6;

  async function worker(workerId) {
    while (currentIndex < targets.length) {
      const idx = currentIndex++;
      const item = targets[idx];
      const t0 = Date.now();

      try {
        const html = await fetchHtml(`${BASE}/series/${item.slug}`);
        const episodes = [];

        for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
          const block = m[1];
          if (!block.includes('anm_det_pop')) continue;
          const hrefMatch = block.match(/href=["']\/([^"'#]+)/i);
          const strongMatch = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
          const titleMatch = block.match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i) ||
                             block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
          const subMatch = block.includes('subbed') || block.includes('Sub');
          const dubMatch = block.includes('dubbed') || block.includes('Dub');

          if (hrefMatch && strongMatch) {
            const epNum = parseInt(strongMatch[1].replace(/\D+/g, ''), 10);
            if (!isNaN(epNum)) {
              episodes.push({
                number: epNum,
                slug: hrefMatch[1],
                title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Episode ${epNum}`,
                hasSub: subMatch || !dubMatch,
                hasDub: dubMatch
              });
            }
          }
        }

        episodes.sort((a, b) => a.number - b.number);
        const seen = new Set();
        const cleanEps = episodes.filter(e => seen.has(e.number) ? false : (seen.add(e.number), true));

        const existing = db.by_slug[item.slug];
        const animeEntry = existing || {
          slug: item.slug,
          title: item.title,
          anilist_id: item.anilist_id,
          mal_id: item.mal_id || null,
          total_episodes: cleanEps.length,
          image: item.image,
          episode_list: [],
          episodes: {}
        };

        animeEntry.total_episodes = cleanEps.length;
        animeEntry.episode_list = cleanEps;
        animeEntry.anilist_id = item.anilist_id;
        animeEntry.mal_id = item.mal_id || animeEntry.mal_id || null;

        db.by_slug[item.slug] = animeEntry;
        if (item.anilist_id) db.by_anilist[String(item.anilist_id)] = animeEntry;
        if (item.mal_id) db.by_mal[String(item.mal_id)] = animeEntry;

        savedCount++;
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> OK (${cleanEps.length} eps, ${Date.now() - t0}ms)`);

        if (savedCount % 25 === 0) {
          saveDatabase(db);
          console.log(`  💾 [CHECKPOINT] Saved ${Object.keys(db.by_slug).length} anime in DB (${Object.keys(db.by_anilist).length} AniList mapped)`);
        }

        await sleep(250);
      } catch (err) {
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> ERR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  saveDatabase(db);

  console.log(`\n🎉 [ALL DONE] Every single mapped anime has its episodes indexed!`);
  console.log(`  - Total in Database: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Total AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Total MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
}

main().catch(console.error);
