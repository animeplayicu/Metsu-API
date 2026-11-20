import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAL_TO_ANIMEGG, ANILIST_TO_ANIMEGG } from '../mappings/animegg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');
const ANIKOTO_FILE = path.join(__dirname, '../data/anikoto_database.json');
const ANIPM_FILE = path.join(__dirname, '../data/anipmbeta_library.json');

const ANILIST_URL = 'https://graphql.anilist.co';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanTitle(t) {
  if (!t) return '';
  return t
    .replace(/\s*-\s*movie\b/gi, '')
    .replace(/\s*\((tv|movie|ova|ona|special|dub|sub)\)/gi, '')
    .replace(/\s*\[(tv|movie|ova|ona|special|dub|sub)\]/gi, '')
    .replace(/\s*\b(dubbed|subbed|dub|sub)\b/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSlug(s) {
  if (!s) return '';
  return s
    .replace(/-(movie|tv|ova|ona|special|specials|dub|sub)$/gi, '')
    .replace(/-season-\d+$/gi, '')
    .replace(/-2nd-season$/gi, '')
    .replace(/-3rd-season$/gi, '')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
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

async function searchAniListGraphQL(queryStr) {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        idMal
        title {
          romaji
          english
        }
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables: { search: queryStr } })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.Media || null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`====================================================`);
  console.log(`  Master AniList & MAL ID Mapper (Local + GraphQL)  `);
  console.log(`====================================================`);

  // 1. Load All Databases
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

  let anikoto = { by_anilist: {}, by_mal: {} };
  if (fs.existsSync(ANIKOTO_FILE)) {
    try { anikoto = JSON.parse(fs.readFileSync(ANIKOTO_FILE, 'utf8')); } catch {}
  }

  let anipm = { titles: {} };
  if (fs.existsSync(ANIPM_FILE)) {
    try { anipm = JSON.parse(fs.readFileSync(ANIPM_FILE, 'utf8')); } catch {}
  }

  console.log(`[DATA] Catalog: ${catalog.length} anime.`);
  console.log(`[DATA] Database: ${Object.keys(db.by_slug || {}).length} anime.`);
  console.log(`[DATA] Anikoto Library: ${Object.keys(anikoto.by_anilist || {}).length} anime.`);
  console.log(`[DATA] AniPM Library: ${Object.keys(anipm.titles || {}).length} anime.`);

  // 2. Build In-Memory Fast Lookup Index
  const lookup = new Map();
  const byFirstLetter = new Map();

  function addIndex(t, id, mal) {
    const c = cleanTitle(t);
    if (!c || c.length < 2) return;
    if (!lookup.has(c)) lookup.set(c, { id, mal });

    const fl = c[0];
    if (!byFirstLetter.has(fl)) byFirstLetter.set(fl, []);
    byFirstLetter.get(fl).push({ title: c, id, mal });
  }

  // Load static maps
  const malToSlug = MAL_TO_ANIMEGG || {};
  const slugToMal = {};
  for (const [malId, slug] of Object.entries(malToSlug)) {
    slugToMal[slug] = parseInt(malId, 10);
  }

  const anilistToSlug = ANILIST_TO_ANIMEGG || {};
  const slugToAnilist = {};
  for (const [alId, slug] of Object.entries(anilistToSlug)) {
    slugToAnilist[slug] = parseInt(alId, 10);
  }

  // Index AniPM Library
  for (const entry of Object.values(anipm.titles || {})) {
    if (entry.id) {
      if (entry.title) addIndex(entry.title, entry.id, entry.mal || null);
      if (entry.native) addIndex(entry.native, entry.id, entry.mal || null);
    }
  }

  // Index Anikoto DB
  for (const anime of Object.values(anikoto.by_anilist || {})) {
    if (anime.anilist_id) {
      if (anime.title) addIndex(anime.title, anime.anilist_id, anime.mal_id || null);
      if (anime.jp_title) addIndex(anime.jp_title, anime.anilist_id, anime.mal_id || null);
    }
  }

  console.log(`[INDEX] Fast lookup index built with ${lookup.size} unique cleaned titles.`);

  // 3. PASS 1: High-Speed Local Matching
  console.log(`\n=== PASS 1: Local Exact, Slug & Fuzzy Matching ===`);
  let localMatches = 0;

  for (const anime of catalog) {
    if (anime.anilist_id) continue;

    // Check static maps
    if (slugToMal[anime.slug]) {
      anime.mal_id = slugToMal[anime.slug];
      const match = anikoto.by_mal?.[String(anime.mal_id)];
      if (match?.anilist_id) anime.anilist_id = match.anilist_id;
    }
    if (slugToAnilist[anime.slug]) {
      anime.anilist_id = slugToAnilist[anime.slug];
    }

    if (anime.anilist_id) {
      localMatches++;
      continue;
    }

    const tClean = cleanTitle(anime.title);
    const sClean = cleanSlug(anime.slug);

    // Exact Cleaned Title or Slug
    let match = lookup.get(tClean) || lookup.get(sClean);
    if (match) {
      anime.anilist_id = match.id;
      anime.mal_id = match.mal || anime.mal_id || null;
      localMatches++;
      continue;
    }

    // Partitioned Fuzzy Match
    const fl = tClean[0];
    const candidates = byFirstLetter.get(fl) || [];
    let bestScore = 0;
    let bestMatch = null;

    for (const cand of candidates) {
      const sim = stringSimilarity(tClean, cand.title);
      if (sim > bestScore && sim >= 0.82) {
        bestScore = sim;
        bestMatch = cand;
      }
    }

    if (bestMatch) {
      anime.anilist_id = bestMatch.id;
      anime.mal_id = bestMatch.mal || anime.mal_id || null;
      localMatches++;
    }
  }

  console.log(`[PASS 1] Successfully mapped ${localMatches} new anime locally!`);

  // Build catalog slug map for fast sync
  const catalogMap = new Map();
  for (const a of catalog) {
    catalogMap.set(a.slug, a);
  }

  // Sync to database entries
  for (const [slug, entry] of Object.entries(db.by_slug || {})) {
    const catItem = catalogMap.get(slug);
    if (catItem?.anilist_id && !entry.anilist_id) {
      entry.anilist_id = catItem.anilist_id;
      entry.mal_id = catItem.mal_id || entry.mal_id || null;
    }
  }

  // 4. PASS 2: GraphQL Fallback for Remaining Unmapped in Database
  const unmappedInDb = Object.values(db.by_slug || {}).filter(a => !a.anilist_id);
  console.log(`\n=== PASS 2: AniList GraphQL Fallback (${unmappedInDb.length} unmapped in DB) ===`);

  let gqlMatches = 0;
  let count = 0;

  for (const anime of unmappedInDb) {
    count++;
    const queryTerm = anime.title || anime.slug.replace(/-/g, ' ');
    process.stdout.write(`[${count}/${unmappedInDb.length}] GraphQL query "${queryTerm}"... `);

    const gqlResult = await searchAniListGraphQL(queryTerm);
    if (gqlResult?.id) {
      anime.anilist_id = gqlResult.id;
      anime.mal_id = gqlResult.idMal || anime.mal_id || null;
      gqlMatches++;
      console.log(`MATCHED -> AniList: ${gqlResult.id} (MAL: ${gqlResult.idMal})`);

      // Update in catalog as well
      const catItem = catalogMap.get(anime.slug);
      if (catItem) {
        catItem.anilist_id = gqlResult.id;
        catItem.mal_id = gqlResult.idMal || catItem.mal_id || null;
      }
    } else {
      console.log(`NO MATCH`);
    }

    await sleep(400); // Respect AniList rate limit (~90-120 reqs/min)
  }

  console.log(`[PASS 2] GraphQL matched: ${gqlMatches} anime.`);

  // 5. Populate and Re-index by_anilist and by_mal in Database
  console.log(`\n=== PASS 3: Re-indexing by_anilist & by_mal in Database ===`);
  db.by_anilist = {};
  db.by_mal = {};

  for (const [slug, entry] of Object.entries(db.by_slug || {})) {
    if (entry.anilist_id) {
      db.by_anilist[String(entry.anilist_id)] = entry;
    }
    if (entry.mal_id) {
      db.by_mal[String(entry.mal_id)] = entry;
    }
  }

  db.updated_at = new Date().toISOString();
  db.total_anime = Object.keys(db.by_slug || {}).length;

  // 6. Save Files Atomically
  fs.writeFileSync(CATALOG_FILE + '.tmp', JSON.stringify(catalog, null, 2), 'utf8');
  fs.renameSync(CATALOG_FILE + '.tmp', CATALOG_FILE);

  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);

  console.log(`\n🎉 [COMPLETE] Master Mapping Finished!`);
  console.log(`  - Total in Catalog: ${catalog.length}`);
  console.log(`  - Total Mapped in Catalog: ${catalog.filter(a => a.anilist_id).length}`);
  console.log(`  - Total in Database: ${Object.keys(db.by_slug).length}`);
  console.log(`  - Total AniList Mapped in DB: ${Object.keys(db.by_anilist).length}`);
  console.log(`  - Total MAL Mapped in DB: ${Object.keys(db.by_mal).length}`);
}

main().catch(console.error);
