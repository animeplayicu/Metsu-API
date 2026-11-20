import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '../data/animegg_database.json');
const CATALOG_FILE = path.join(__dirname, '../data/animegg_catalog.json');

async function clean() {
  console.log('=== [CLEAN & FILTER: EXCLUDE NON-ANILIST ITEMS] ===');

  // 1. Clean Catalog
  const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const beforeCatCount = rawCatalog.length;
  const cleanCatalog = rawCatalog.filter(a => a.anilist_id && typeof a.anilist_id === 'number');

  console.log(`Catalog: Before = ${beforeCatCount}, Removed (No AniList ID) = ${beforeCatCount - cleanCatalog.length}, Kept = ${cleanCatalog.length}`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(cleanCatalog, null, 2), 'utf8');

  // 2. Clean Database
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const beforeDbCount = Object.keys(db.by_slug || {}).length;

  const validCatalogMap = new Map();
  for (const c of cleanCatalog) {
    validCatalogMap.set(c.slug, c);
  }

  const cleanBySlug = {};
  const cleanByAnilist = {};
  const cleanByMal = {};

  for (const slug in db.by_slug) {
    const entry = db.by_slug[slug];
    const catItem = validCatalogMap.get(slug);

    const anilistId = entry.anilist_id || catItem?.anilist_id;
    const malId = entry.mal_id || catItem?.mal_id;

    // Discard any series that does not have an AniList ID
    if (!anilistId) continue;

    entry.anilist_id = anilistId;
    entry.mal_id = malId || entry.mal_id || null;

    cleanBySlug[slug] = entry;

    // Index by AniList
    const aid = String(anilistId);
    const existingAni = cleanByAnilist[aid];
    if (!existingAni || 
        (!entry.slug.includes('-dub') && existingAni.slug.includes('-dub')) || 
        ((entry.episode_list?.length || 0) > (existingAni.episode_list?.length || 0))) {
      cleanByAnilist[aid] = entry;
    }

    // Index by MAL
    if (entry.mal_id) {
      const mid = String(entry.mal_id);
      const existingMal = cleanByMal[mid];
      if (!existingMal || 
          (!entry.slug.includes('-dub') && existingMal.slug.includes('-dub')) || 
          ((entry.episode_list?.length || 0) > (existingMal.episode_list?.length || 0))) {
        cleanByMal[mid] = entry;
      }
    }
  }

  // Count total episodes and series with episodes
  let totalEpisodes = 0;
  let seriesWithEpisodes = 0;
  for (const slug in cleanBySlug) {
    const eps = cleanBySlug[slug].episode_list || [];
    if (eps.length > 0) seriesWithEpisodes++;
    totalEpisodes += eps.length;
  }

  const cleanDb = {
    updated_at: new Date().toISOString(),
    total_anime: Object.keys(cleanBySlug).length,
    by_slug: cleanBySlug,
    by_anilist: cleanByAnilist,
    by_mal: cleanByMal
  };

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cleanDb, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);

  console.log(`\n=======================================================`);
  console.log(`🎉 [CLEAN DATABASE READY: 100% VERIFIED ANILIST ANIME]`);
  console.log(`  - Pure Catalog Anime (All with AniList ID): ${cleanCatalog.length}`);
  console.log(`  - Pure Database Series (by_slug): ${Object.keys(cleanBySlug).length}`);
  console.log(`  - Unique AniList Mapped in DB: ${Object.keys(cleanByAnilist).length}`);
  console.log(`  - Unique MAL Mapped in DB: ${Object.keys(cleanByMal).length}`);
  console.log(`  - Series with Scraped Episodes: ${seriesWithEpisodes}`);
  console.log(`  - Total Indexed Episodes: ${totalEpisodes}`);
  console.log(`=======================================================`);
}

clean().catch(console.error);
