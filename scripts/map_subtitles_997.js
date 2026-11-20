import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');
const DUMP_FILE = path.join(__dirname, '../data/anilist_dump.json');

const BASE = 'https://www.animegg.org';
const ANILIST_URL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function getBestSearchTerm(raw) {
  const dec = decodeEntities(raw);

  // 1. If has colon: "Detective Conan Movie 18: The Sniper from Another Dimension" -> "The Sniper from Another Dimension"
  if (dec.includes(':')) {
    const parts = dec.split(':').map(p => p.trim()).filter(Boolean);
    const sub = parts[parts.length - 1];
    if (sub.length >= 4 && !/^(season|part|book)\s*\d+$/i.test(sub)) {
      return sub.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // 2. Strip Movie \d+ or Season \d+
  let stripped = dec
    .replace(/\s*movie\s*\d+\s*(:)?\s*/gi, ' ')
    .replace(/\s*season\s*\d+\s*(:)?\s*/gi, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped;
}

function stringSimilarity(n1, n2) {
  if (n1 === n2) return 1.0;
  if (!n1 || !n2) return 0;
  if (n1.length < 2 || n2.length < 2) return 0;

  const getBigrams = str => {
    const bigrams = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(n1);
  const b2 = getBigrams(n2);
  let intersection = 0;
  for (const [k, count1] of b1.entries()) {
    if (b2.has(k)) intersection += Math.min(count1, b2.get(k));
  }

  const total = (n1.length - 1) + (n2.length - 1);
  return (2 * intersection) / total;
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
  console.log('=== [SUBTITLE & SMART TERM SEARCH PASS] ===');
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const unmapped = catalog.filter(a => !a.anilist_id);
  console.log(`Unmapped items to process: ${unmapped.length}`);

  let dump = [];
  try { dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8')); } catch {}
  const seenDumpIds = new Set(dump.map(d => d.id));

  const BATCH_SIZE = 10;
  let matchedCount = 0;

  for (let i = 0; i < unmapped.length; i += BATCH_SIZE) {
    const chunk = unmapped.slice(i, i + BATCH_SIZE);
    const subqueries = [];

    chunk.forEach((item, idx) => {
      let term = getBestSearchTerm(item.title);
      if (term.length < 3) term = item.slug.replace(/-/g, ' ');
      const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      subqueries.push(`q${idx}: Page(perPage: 3) { media(search: "${escaped}", type: ANIME) { id idMal title { romaji english native } synonyms } }`);
    });

    const query = `query { ${subqueries.join(' ')} }`;

    let data = null;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query })
        });

        if (res.status === 429) {
          console.log(`\n[RATE LIMIT] Sleeping 60s at batch ${Math.floor(i / BATCH_SIZE) + 1}...`);
          await sleep(60000);
          continue;
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        data = json.data;
        break;
      } catch (e) {
        retries--;
        await sleep(2000);
      }
    }

    if (data) {
      chunk.forEach((item, idx) => {
        const results = data[`q${idx}`]?.media || [];
        if (!results.length) return;

        const targetClean = decodeEntities(item.title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const searchTermClean = getBestSearchTerm(item.title).toLowerCase();

        let bestItem = null;
        let bestScore = 0;

        for (const cand of results) {
          const candTitles = [cand.title?.romaji, cand.title?.english, ...(cand.synonyms || [])].filter(Boolean);
          for (const ct of candTitles) {
            const ctClean = ct.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
            const sim1 = stringSimilarity(targetClean, ctClean);
            const sim2 = stringSimilarity(searchTermClean, ctClean);
            const contains = (searchTermClean.length >= 4 && ctClean.includes(searchTermClean)) || (targetClean.length >= 4 && ctClean.includes(targetClean));
            const score = contains ? Math.max(sim1, sim2, 0.75) : Math.max(sim1, sim2);

            if (score > bestScore) {
              bestScore = score;
              bestItem = cand;
            }
          }
        }

        if (bestItem && bestScore >= 0.60) {
          item.anilist_id = bestItem.id;
          item.mal_id = bestItem.idMal || null;
          matchedCount++;

          if (!seenDumpIds.has(bestItem.id)) {
            seenDumpIds.add(bestItem.id);
            dump.push(bestItem);
          }
        }
      });
    }

    process.stdout.write(`\r[BATCH ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(unmapped.length / BATCH_SIZE)}] Matched: ${matchedCount} (Total: ${catalog.filter(c => c.anilist_id).length}/${catalog.length})`);

    if ((i / BATCH_SIZE) % 15 === 0) {
      fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
      fs.writeFileSync(DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');
    }

    await sleep(750);
  }

  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  fs.writeFileSync(DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');

  console.log(`\n\n🎉 Newly mapped in subtitle pass: ${matchedCount}`);
  const finalMapped = catalog.filter(c => c.anilist_id).length;
  console.log(`🔥 Total Mapped in Catalog: ${finalMapped} / ${catalog.length} (${(finalMapped / catalog.length * 100).toFixed(1)}%)`);

  // Sync with DB
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  for (const item of catalog) {
    if (db.by_slug[item.slug]) {
      const entry = db.by_slug[item.slug];
      if (item.anilist_id) entry.anilist_id = item.anilist_id;
      if (item.mal_id) entry.mal_id = item.mal_id;

      if (entry.anilist_id) {
        const aid = String(entry.anilist_id);
        const ex = db.by_anilist[aid];
        if (!ex || (!entry.slug.includes('-dub') && ex.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (ex.episode_list?.length || 0))) {
          db.by_anilist[aid] = entry;
        }
      }
      if (entry.mal_id) {
        const mid = String(entry.mal_id);
        const exm = db.by_mal[mid];
        if (!exm || (!entry.slug.includes('-dub') && exm.slug.includes('-dub')) || ((entry.episode_list?.length || 0) > (exm.episode_list?.length || 0))) {
          db.by_mal[mid] = entry;
        }
      }
    }
  }

  // Fetch episodes for any missing
  const targets = catalog.filter(a => a.anilist_id && (!db.by_slug[a.slug]?.episode_list?.length));
  console.log(`Targets missing episode lists in DB: ${targets.length}`);

  let currentIndex = 0;
  let savedCount = 0;
  const CONCURRENCY = 12;

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
          const subMatch = block.includes('subbed') || block.includes('Sub');
          const dubMatch = block.includes('dubbed') || block.includes('Dub');

          if (hrefMatch) {
            const slugNum = hrefMatch[1].match(/-episode-(\d+)$/i)?.[1] || hrefMatch[1].match(/(\d+)$/)?.[1];
            const epNum = slugNum ? parseInt(slugNum, 10) : null;
            if (epNum) {
              episodes.push({
                number: epNum,
                slug: hrefMatch[1],
                title: `Episode ${epNum}`,
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

        const aid = String(item.anilist_id);
        const ex = db.by_anilist[aid];
        if (!ex || (!animeEntry.slug.includes('-dub') && ex.slug.includes('-dub')) || (cleanEps.length > (ex.episode_list?.length || 0))) {
          db.by_anilist[aid] = animeEntry;
        }

        if (item.mal_id) {
          const mid = String(item.mal_id);
          const exm = db.by_mal[mid];
          if (!exm || (!animeEntry.slug.includes('-dub') && exm.slug.includes('-dub')) || (cleanEps.length > (exm.episode_list?.length || 0))) {
            db.by_mal[mid] = animeEntry;
          }
        }

        savedCount++;
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> OK (${cleanEps.length} eps, ${Date.now() - t0}ms)`);

        if (savedCount % 50 === 0) {
          saveDatabase(db);
        }

        await sleep(150);
      } catch (err) {
        console.log(`[W${workerId}][${idx + 1}/${targets.length}] ${item.slug} -> ERR: ${err.message}`);
      }
    }
  }

  if (targets.length > 0) {
    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);
  }

  saveDatabase(db);

  let totalEps = 0;
  for (const s in db.by_slug) {
    totalEps += (db.by_slug[s].episode_list || []).length;
  }

  console.log(`\n=======================================================`);
  console.log(`🎉 [FINAL DATABASE STATUS]`);
  console.log(`  - Total Anime in Catalog: ${catalog.length}`);
  console.log(`  - Total Mapped in Catalog: ${finalMapped} (${(finalMapped / catalog.length * 100).toFixed(1)}%)`);
  console.log(`  - Total Series in DB by_slug: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Unique AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Unique MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
  console.log(`  - Total Indexed Episodes: ${totalEps}`);
  console.log(`=======================================================`);
}

main().catch(console.error);
