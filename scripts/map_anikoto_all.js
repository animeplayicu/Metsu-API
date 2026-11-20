import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');
const ANILIST_DUMP_FILE = path.join(__dirname, '../data/anilist_dump.json');
const ANIMEGG_FILE = path.join(__dirname, '../data/animegg_database.json');
const ANIPM_FILE = path.join(__dirname, '../data/anipmbeta_library.json');

const ANILIST_URL = 'https://graphql.anilist.co';

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

function clean(s) {
  if (!s) return '';
  return decodeEntities(s)
    .toLowerCase()
    .replace(/-[a-f0-9]{4,6}$/i, '') // strip anikoto hash suffix like -dd6f6
    .replace(/\s*-\s*movie\b/gi, '')
    .replace(/\s*\((tv|movie|ova|ona|special|specials|dub|sub)\)/gi, '')
    .replace(/\s*\[(tv|movie|ova|ona|special|specials|dub|sub)\]/gi, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanForSearch(raw) {
  if (!raw) return '';
  return decodeEntities(raw)
    .replace(/-[a-f0-9]{4,6}$/i, '')
    .replace(/\s*-\s*movie\b/gi, '')
    .replace(/\s*\((tv|movie|ova|ona|special|specials|dub|sub)\)/gi, '')
    .replace(/\s*\[(tv|movie|ova|ona|special|specials|dub|sub)\]/gi, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function saveAnikotoDb(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(ANIKOTO_FILE), { recursive: true });
  const tmp = ANIKOTO_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, ANIKOTO_FILE);
}

async function main() {
  console.log(`=======================================================`);
  console.log(`   Anikoto Full AniList & MAL Mapping Pipeline        `);
  console.log(`=======================================================`);

  const anikoto = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
  anikoto.by_slug = anikoto.by_slug || {};
  anikoto.by_anilist = anikoto.by_anilist || {};
  anikoto.by_mal = anikoto.by_mal || {};

  const totalSeries = Object.keys(anikoto.by_slug).length;
  const initialMapped = Object.values(anikoto.by_slug).filter(a => a.anilist_id).length;
  console.log(`Total Anikoto Series: ${totalSeries}`);
  console.log(`Initially Mapped: ${initialMapped} (${(initialMapped / totalSeries * 100).toFixed(1)}%)`);
  console.log(`Initially Unmapped: ${totalSeries - initialMapped}`);

  // STAGE 1: Offline Fast In-Memory Index Match
  console.log(`\n=== [STAGE 1] Building Master Lookup Index ===`);
  const lookup = new Map();
  const noSpaceLookup = new Map();

  function addIndex(titleStr, id, mal) {
    if (!titleStr) return;
    const c = clean(titleStr);
    if (c.length >= 2) {
      if (!lookup.has(c)) lookup.set(c, { id, mal });
      const ns = c.replace(/\s+/g, '');
      if (ns.length >= 3 && !noSpaceLookup.has(ns)) noSpaceLookup.set(ns, { id, mal });
    }
  }

  let dump = [];
  if (fs.existsSync(ANILIST_DUMP_FILE)) {
    try {
      dump = JSON.parse(fs.readFileSync(ANILIST_DUMP_FILE, 'utf8'));
      console.log(`Indexing AniList Dump (${dump.length} items)...`);
      for (const m of dump) {
        if (m.title?.romaji) addIndex(m.title.romaji, m.id, m.idMal);
        if (m.title?.english) addIndex(m.title.english, m.id, m.idMal);
        if (m.title?.native) addIndex(m.title.native, m.id, m.idMal);
        if (Array.isArray(m.synonyms)) {
          for (const syn of m.synonyms) addIndex(syn, m.id, m.idMal);
        }
      }
    } catch {}
  }

  if (fs.existsSync(ANIMEGG_FILE)) {
    try {
      const egg = JSON.parse(fs.readFileSync(ANIMEGG_FILE, 'utf8'));
      console.log(`Indexing AnimeGG Database (${Object.keys(egg.by_slug || {}).length} items)...`);
      for (const s in egg.by_slug) {
        const item = egg.by_slug[s];
        if (item.anilist_id) {
          if (item.title) addIndex(item.title, item.anilist_id, item.mal_id);
          addIndex(item.slug.replace(/-/g, ' '), item.anilist_id, item.mal_id);
        }
      }
    } catch {}
  }

  if (fs.existsSync(ANIPM_FILE)) {
    try {
      const anipm = JSON.parse(fs.readFileSync(ANIPM_FILE, 'utf8'));
      console.log(`Indexing AniPM Beta Library (${anipm.length} items)...`);
      for (const a of anipm) {
        if (a.anilist_id) {
          if (a.title) addIndex(a.title, a.anilist_id, a.mal_id);
          if (a.english_title) addIndex(a.english_title, a.anilist_id, a.mal_id);
          if (a.japanese_title) addIndex(a.japanese_title, a.anilist_id, a.mal_id);
          if (Array.isArray(a.synonyms)) {
            for (const s of a.synonyms) addIndex(s, a.anilist_id, a.mal_id);
          }
        }
      }
    } catch {}
  }

  console.log(`Fast index built: ${lookup.size} exact keys, ${noSpaceLookup.size} no-space keys.`);

  let stage1Matched = 0;
  for (const s in anikoto.by_slug) {
    const item = anikoto.by_slug[s];
    if (item.anilist_id) continue;

    const cTitle = clean(item.title);
    const cJp = clean(item.jp_title);
    const cSlug = clean(item.slug.replace(/-/g, ' '));

    const nsTitle = cTitle.replace(/\s+/g, '');
    const nsJp = cJp.replace(/\s+/g, '');
    const nsSlug = cSlug.replace(/\s+/g, '');

    const match = lookup.get(cTitle) || lookup.get(cJp) || lookup.get(cSlug) ||
                  noSpaceLookup.get(nsTitle) || noSpaceLookup.get(nsJp) || noSpaceLookup.get(nsSlug);

    if (match) {
      item.anilist_id = match.id;
      item.mal_id = match.mal || item.mal_id || null;
      stage1Matched++;
    }
  }

  console.log(`[STAGE 1 DONE] Newly mapped from local master index: ${stage1Matched}`);
  let currentTotalMapped = Object.values(anikoto.by_slug).filter(a => a.anilist_id).length;
  console.log(`Total Mapped so far: ${currentTotalMapped} / ${totalSeries} (${(currentTotalMapped / totalSeries * 100).toFixed(1)}%)`);

  saveAnikotoDb(anikoto);

  // STAGE 2: Online AniList GraphQL Batch Search for Remaining
  console.log(`\n=== [STAGE 2] Online AniList GraphQL Batch Search ===`);
  const remainingUnmapped = Object.values(anikoto.by_slug).filter(a => !a.anilist_id);
  console.log(`Remaining unmapped items to search: ${remainingUnmapped.length}`);

  const seenDumpIds = new Set(dump.map(d => d.id));
  const BATCH_SIZE = 10;
  let stage2Matched = 0;

  for (let i = 0; i < remainingUnmapped.length; i += BATCH_SIZE) {
    const chunk = remainingUnmapped.slice(i, i + BATCH_SIZE);
    const subqueries = [];

    chunk.forEach((item, idx) => {
      let term = cleanForSearch(item.title);
      if (term.length < 2) term = cleanForSearch(item.jp_title);
      if (term.length < 2) term = cleanForSearch(item.slug.replace(/-/g, ' '));

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
      } catch (err) {
        retries--;
        await sleep(2000);
      }
    }

    if (data) {
      chunk.forEach((item, idx) => {
        const results = data[`q${idx}`]?.media || [];
        if (!results.length) return;

        const targetTitle = clean(item.title);
        const targetJp = clean(item.jp_title);
        const targetSlug = clean(item.slug.replace(/-/g, ' '));

        let bestItem = null;
        let bestScore = 0;

        for (const cand of results) {
          const candTitles = [cand.title?.romaji, cand.title?.english, cand.title?.native, ...(cand.synonyms || [])].filter(Boolean);
          for (const ct of candTitles) {
            const ctClean = clean(ct);
            const sim1 = stringSimilarity(targetTitle, ctClean);
            const sim2 = targetJp ? stringSimilarity(targetJp, ctClean) : 0;
            const sim3 = stringSimilarity(targetSlug, ctClean);

            const contains = (targetTitle.length >= 4 && ctClean.includes(targetTitle)) || (ctClean.length >= 4 && targetTitle.includes(ctClean));
            const score = contains ? Math.max(sim1, sim2, sim3, 0.75) : Math.max(sim1, sim2, sim3);

            if (score > bestScore) {
              bestScore = score;
              bestItem = cand;
            }
          }
        }

        if (bestItem && bestScore >= 0.65) {
          item.anilist_id = bestItem.id;
          item.mal_id = bestItem.idMal || null;
          stage2Matched++;

          if (!seenDumpIds.has(bestItem.id)) {
            seenDumpIds.add(bestItem.id);
            dump.push(bestItem);
          }
        }
      });
    }

    process.stdout.write(`\r[BATCH ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(remainingUnmapped.length / BATCH_SIZE)}] Stage 2 Matched: ${stage2Matched} (Total Mapped: ${Object.values(anikoto.by_slug).filter(a => a.anilist_id).length}/${totalSeries})`);

    if ((i / BATCH_SIZE) % 15 === 0) {
      saveAnikotoDb(anikoto);
      fs.writeFileSync(ANILIST_DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');
    }

    await sleep(750);
  }

  fs.writeFileSync(ANILIST_DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');

  // STAGE 3: Rebuild Clean Indexes
  console.log(`\n\n=== [STAGE 3] Rebuilding Clean AniList & MAL Indexes ===`);
  anikoto.by_anilist = {};
  anikoto.by_mal = {};

  for (const slug in anikoto.by_slug) {
    const item = anikoto.by_slug[slug];
    if (item.anilist_id) {
      const aid = String(item.anilist_id);
      const ex = anikoto.by_anilist[aid];
      const epCount = (item.episodes?.sub || 0) + (item.episodes?.dub || 0);
      const exCount = ex ? ((ex.episodes?.sub || 0) + (ex.episodes?.dub || 0)) : 0;

      if (!ex || epCount > exCount) {
        anikoto.by_anilist[aid] = item;
      }
    }

    if (item.mal_id) {
      const mid = String(item.mal_id);
      const exm = anikoto.by_mal[mid];
      const epCount = (item.episodes?.sub || 0) + (item.episodes?.dub || 0);
      const exmCount = exm ? ((exm.episodes?.sub || 0) + (exm.episodes?.dub || 0)) : 0;

      if (!exm || epCount > exmCount) {
        anikoto.by_mal[mid] = item;
      }
    }
  }

  saveAnikotoDb(anikoto);

  const finalMapped = Object.values(anikoto.by_slug).filter(a => a.anilist_id).length;
  const finalMal = Object.values(anikoto.by_slug).filter(a => a.mal_id).length;

  console.log(`\n=======================================================`);
  console.log(`🎉 [ANIKOTO FULL MAPPING COMPLETE]`);
  console.log(`  - Total Series in DB by_slug: ${totalSeries}`);
  console.log(`  - Total Mapped to AniList: ${finalMapped} (${(finalMapped / totalSeries * 100).toFixed(1)}%)`);
  console.log(`  - Total Mapped to MAL: ${finalMal} (${(finalMal / totalSeries * 100).toFixed(1)}%)`);
  console.log(`  - Unique AniList Index (by_anilist): ${Object.keys(anikoto.by_anilist).length}`);
  console.log(`  - Unique MAL Index (by_mal): ${Object.keys(anikoto.by_mal).length}`);
  console.log(`=======================================================`);
}

main().catch(console.error);
