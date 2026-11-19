import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve(process.cwd(), 'data/anikoto_database.json');
console.log('Loading database from:', DB_PATH);

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

let purgedFieldsCount = 0;
let cleanedAnimeCount = 0;

function cleanItem(item) {
  if (!item || typeof item !== 'object') return;
  let modified = false;

  // Purge top-level fake embed template fields
  if (item.embed_url && item.embed_url.includes('stream/ani/')) {
    delete item.embed_url;
    purgedFieldsCount++;
    modified = true;
  }
  if (item.embed_url_dub && item.embed_url_dub.includes('stream/ani/')) {
    delete item.embed_url_dub;
    purgedFieldsCount++;
    modified = true;
  }

  // Purge per-episode fake embed links if any
  if (item.episodes && typeof item.episodes === 'object' && !Array.isArray(item.episodes)) {
    for (const [epKey, epVal] of Object.entries(item.episodes)) {
      if (epVal && typeof epVal === 'object') {
        if (epVal.embed_sub && epVal.embed_sub.includes('stream/ani/')) {
          delete epVal.embed_sub;
          purgedFieldsCount++;
          modified = true;
        }
        if (epVal.embed_dub && epVal.embed_dub.includes('stream/ani/')) {
          delete epVal.embed_dub;
          purgedFieldsCount++;
          modified = true;
        }
      }
    }
  }

  // Also clean episodes_cache if any old fake URL got in
  if (item.episodes_cache && typeof item.episodes_cache === 'object') {
    for (const [epKey, cached] of Object.entries(item.episodes_cache)) {
      if (cached?.embed_url && cached.embed_url.includes('stream/ani/')) {
        delete item.episodes_cache[epKey];
        purgedFieldsCount++;
        modified = true;
      }
    }
  }

  if (modified) cleanedAnimeCount++;
}

// Clean across all collections
for (const item of Object.values(db.by_slug || {})) {
  cleanItem(item);
}
for (const item of Object.values(db.by_anilist || {})) {
  cleanItem(item);
}
for (const item of Object.values(db.by_show_id || {})) {
  cleanItem(item);
}
for (const item of Object.values(db.by_mal || {})) {
  cleanItem(item);
}

fs.writeFileSync(DB_PATH, JSON.stringify(db));
console.log(`Cleaned ${cleanedAnimeCount} anime items.`);
console.log(`Purged ${purgedFieldsCount} fake embed templates.`);
console.log('Database saved cleanly!');
