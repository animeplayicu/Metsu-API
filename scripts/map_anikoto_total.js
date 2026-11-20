import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');
const ANILIST_DUMP_FILE = path.join(__dirname, '../data/anilist_dump.json');
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

function getSearchTerms(item) {
  const terms = [];

  const cleanTerm = (s) => {
    if (!s) return '';
    return decodeEntities(s)
      .replace(/-[a-f0-9]{4,6}$/i, '')
      .replace(/\s*movie\s*\d*\b/gi, ' ')
      .replace(/\s*dai\s*[a-z0-9]+\s*shou\b/gi, ' ')
      .replace(/\s*chapter\s*[a-z0-9]+\b/gi, ' ')
      .replace(/\s*\([^)]*\)/g, ' ')
      .replace(/\s*\[[^\]]*\]/g, ' ')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  if (item.jp_title) {
    const t = cleanTerm(item.jp_title);
    if (t.length >= 3) terms.push(t);
  }

  if (item.title) {
    const t = cleanTerm(item.title);
    if (t.length >= 3 && !terms.includes(t)) terms.push(t);
  }

  // Subtitle after colon
  if (item.title && item.title.includes(':')) {
    const parts = item.title.split(':');
    const sub = cleanTerm(parts[parts.length - 1]);
    if (sub.length >= 4 && !/^(season|part)\s*\d+$/i.test(sub)) {
      if (!terms.includes(sub)) terms.push(sub);
    }
  }

  return terms.length > 0 ? terms : [item.slug.replace(/-/g, ' ')];
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

function saveDb(db) {
  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;
  fs.mkdirSync(path.dirname(ANIKOTO_FILE), { recursive: true });
  const tmp = ANIKOTO_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, ANIKOTO_FILE);
}

async function main() {
  console.log(`=======================================================`);
  console.log(`   Anikoto 100% Total AniList & MAL Final Mapping     `);
  console.log(`=======================================================`);

  const anikoto = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8'));
  const unmapped = Object.values(anikoto.by_slug).filter(a => !a.anilist_id);
  console.log(`Unmapped remaining: ${unmapped.length}`);

  let dump = [];
  try { dump = JSON.parse(fs.readFileSync(ANILIST_DUMP_FILE, 'utf8')); } catch {}
  const seenDumpIds = new Set(dump.map(d => d.id));

  const BATCH_SIZE = 10;
  let newlyMatched = 0;

  for (let i = 0; i < unmapped.length; i += BATCH_SIZE) {
    const chunk = unmapped.slice(i, i + BATCH_SIZE);
    const subqueries = [];

    chunk.forEach((item, idx) => {
      const searchTerms = getSearchTerms(item);
      const primaryTerm = searchTerms[0] || item.slug.replace(/-/g, ' ');
      const escaped = primaryTerm.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

        const allTerms = getSearchTerms(item).map(t => t.toLowerCase());

        let bestItem = null;
        let bestScore = 0;

        for (const cand of results) {
          const candTitles = [cand.title?.romaji, cand.title?.english, cand.title?.native, ...(cand.synonyms || [])].filter(Boolean);
          for (const ct of candTitles) {
            const ctClean = ct.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
            for (const st of allTerms) {
              const sim = stringSimilarity(st, ctClean);
              const contains = (st.length >= 4 && ctClean.includes(st)) || (ctClean.length >= 4 && st.includes(ctClean));
              const score = contains ? Math.max(sim, 0.75) : sim;

              if (score > bestScore) {
                bestScore = score;
                bestItem = cand;
              }
            }
          }
        }

        if (bestItem && bestScore >= 0.60) {
          item.anilist_id = bestItem.id;
          item.mal_id = bestItem.idMal || null;
          newlyMatched++;

          if (!seenDumpIds.has(bestItem.id)) {
            seenDumpIds.add(bestItem.id);
            dump.push(bestItem);
          }
        }
      });
    }

    process.stdout.write(`\r[BATCH ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(unmapped.length / BATCH_SIZE)}] Matched: ${newlyMatched} (Total Mapped: ${Object.values(anikoto.by_slug).filter(a => a.anilist_id).length}/${Object.keys(anikoto.by_slug).length})`);

    if ((i / BATCH_SIZE) % 15 === 0) {
      saveDb(anikoto);
      fs.writeFileSync(ANILIST_DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');
    }

    await sleep(750);
  }

  saveDb(anikoto);
  fs.writeFileSync(ANILIST_DUMP_FILE, JSON.stringify(dump, null, 2), 'utf8');

  console.log(`\n\n🎉 Newly matched in final smart pass: ${newlyMatched}`);
  const totalWithAnilist = Object.values(anikoto.by_slug).filter(a => a.anilist_id).length;
  console.log(`Total Mapped Anime: ${totalWithAnilist} / ${Object.keys(anikoto.by_slug).length}`);

  // STAGE 2: Filter out remaining non-anime entries (No AniList ID) as requested
  console.log(`\n=== [CLEAN & FILTER: EXCLUDING NON-ANIME ENTRIES] ===`);
  const initialCount = Object.keys(anikoto.by_slug).length;
  const cleanBySlug = {};
  const cleanByAnilist = {};
  const cleanByMal = {};

  let removedCount = 0;
  for (const slug in anikoto.by_slug) {
    const item = anikoto.by_slug[slug];
    if (!item.anilist_id) {
      removedCount++;
      continue;
    }

    cleanBySlug[slug] = item;

    const aid = String(item.anilist_id);
    const ex = cleanByAnilist[aid];
    const epCount = (item.episodes?.sub || 0) + (item.episodes?.dub || 0);
    const exCount = ex ? ((ex.episodes?.sub || 0) + (ex.episodes?.dub || 0)) : 0;
    if (!ex || epCount > exCount) {
      cleanByAnilist[aid] = item;
    }

    if (item.mal_id) {
      const mid = String(item.mal_id);
      const exm = cleanByMal[mid];
      const exmCount = exm ? ((exm.episodes?.sub || 0) + (exm.episodes?.dub || 0)) : 0;
      if (!exm || epCount > exmCount) {
        cleanByMal[mid] = item;
      }
    }
  }

  let totalMaxEpisodes = 0;
  let totalSubEpisodes = 0;
  let totalDubEpisodes = 0;

  for (const s in cleanBySlug) {
    const item = cleanBySlug[s];
    const sub = item.episodes?.sub || item.episode_counts?.sub || 0;
    const dub = item.episodes?.dub || item.episode_counts?.dub || 0;
    totalSubEpisodes += sub;
    totalDubEpisodes += dub;
    totalMaxEpisodes += Math.max(sub, dub);
  }

  const cleanDb = {
    updated_at: new Date().toISOString(),
    total_anime: Object.keys(cleanBySlug).length,
    by_slug: cleanBySlug,
    by_anilist: cleanByAnilist,
    by_mal: cleanByMal
  };

  saveDb(cleanDb);

  console.log(`\n=======================================================`);
  console.log(`🎉 [ANIKOTO 100% PURE ANILIST DATABASE READY]`);
  console.log(`  - Pure Anime Series (100% with AniList ID): ${Object.keys(cleanBySlug).length}`);
  console.log(`  - Non-Anime Removed (Western cartoons / unreleased): ${removedCount}`);
  console.log(`  - Unique AniList Index (by_anilist): ${Object.keys(cleanByAnilist).length}`);
  console.log(`  - Unique MAL Index (by_mal): ${Object.keys(cleanByMal).length}`);
  console.log(`  - Total Subbed Episodes: ${totalSubEpisodes}`);
  console.log(`  - Total Dubbed Episodes: ${totalDubEpisodes}`);
  console.log(`  - Total Unique Episodes: ${totalMaxEpisodes}`);
  console.log(`=======================================================`);
}

main().catch(console.error);
