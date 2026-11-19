import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve(process.cwd(), 'data/anikoto_database.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

// Canonical popular anime manual override table for 100% precision
const CANONICAL_MAPPINGS = {
  'one-piece-odmau': { anilist_id: 21, mal_id: 21 },
  'naruto-m6kpo': { anilist_id: 20, mal_id: 20 },
  'naruto-shippuden-100': { anilist_id: 1735, mal_id: 1735 },
  'bleach-oep3k': { anilist_id: 269, mal_id: 269 },
  'death-note-133': { anilist_id: 1535, mal_id: 1535 },
  'hunter-x-hunter-2011-370': { anilist_id: 11061, mal_id: 11061 },
  'attack-on-titan-bgaoa': { anilist_id: 16498, mal_id: 16498 },
  'jujutsu-kaisen-3q7kw': { anilist_id: 113415, mal_id: 40748 },
  'demon-slayer-kimetsu-no-yaiba-7x1pk': { anilist_id: 101922, mal_id: 38000 },
  'black-clover-301': { anilist_id: 97940, mal_id: 34572 },
  'dragon-ball-z-789': { anilist_id: 223, mal_id: 223 },
  'dragon-ball-super-101': { anilist_id: 21175, mal_id: 30694 },
  'my-hero-academia-144': { anilist_id: 21459, mal_id: 31964 },
  'chainsaw-man-813k': { anilist_id: 127230, mal_id: 44511 },
  'solo-leveling-8803': { anilist_id: 151807, mal_id: 52299 },
  'fullmetal-alchemist-brotherhood-11': { anilist_id: 5114, mal_id: 5114 },
  'sword-art-online-105': { anilist_id: 11757, mal_id: 11757 },
  'tokyo-ghoul-112': { anilist_id: 20605, mal_id: 22319 },
  'cowboy-bebop-28': { anilist_id: 1, mal_id: 1 },
  'vinland-saga-109': { anilist_id: 101348, mal_id: 37521 }
};

// Also search by exact title for Naruto, Bleach, etc.
for (const item of Object.values(db.by_slug)) {
  const cleanTitle = (item.title || '').trim().toLowerCase();
  if (cleanTitle === 'one piece' && item.type === 'TV') {
    item.anilist_id = 21;
    item.mal_id = 21;
  } else if (cleanTitle === 'naruto' && item.type === 'TV') {
    item.anilist_id = 20;
    item.mal_id = 20;
  } else if (cleanTitle === 'naruto: shippuden' || cleanTitle === 'naruto shippuden') {
    item.anilist_id = 1735;
    item.mal_id = 1735;
  } else if (cleanTitle === 'bleach' && item.type === 'TV') {
    item.anilist_id = 269;
    item.mal_id = 269;
  } else if (cleanTitle === 'death note') {
    item.anilist_id = 1535;
    item.mal_id = 1535;
  } else if (cleanTitle === 'hunter x hunter (2011)' || cleanTitle === 'hunter x hunter') {
    item.anilist_id = 11061;
    item.mal_id = 11061;
  } else if (CANONICAL_MAPPINGS[item.slug]) {
    item.anilist_id = CANONICAL_MAPPINGS[item.slug].anilist_id;
    item.mal_id = CANONICAL_MAPPINGS[item.slug].mal_id;
  }
}

// Rebuild by_anilist and by_mal
db.by_anilist = {};
db.by_mal = {};

for (const item of Object.values(db.by_slug)) {
  if (item.anilist_id) {
    const key = String(item.anilist_id);
    const existing = db.by_anilist[key];
    if (!existing || (item.episodes.sub + item.episodes.dub > (existing.episodes?.sub || 0) + (existing.episodes?.dub || 0))) {
      db.by_anilist[key] = item;
    }
  }
  if (item.mal_id) {
    const key = String(item.mal_id);
    const existing = db.by_mal[key];
    if (!existing || (item.episodes.sub + item.episodes.dub > (existing.episodes?.sub || 0) + (existing.episodes?.dub || 0))) {
      db.by_mal[key] = item;
    }
  }
}

fs.writeFileSync(DB_PATH, JSON.stringify(db));
console.log('Anikoto Database enhanced!');
console.log('One Piece (21):', db.by_anilist['21'] ? db.by_anilist['21'].slug : 'not found');
console.log('Naruto (20):', db.by_anilist['20'] ? db.by_anilist['20'].slug : 'not found');
console.log('Bleach (269):', db.by_anilist['269'] ? db.by_anilist['269'].slug : 'not found');
console.log('Attack on Titan (16498):', db.by_anilist['16498'] ? db.by_anilist['16498'].slug : 'not found');
