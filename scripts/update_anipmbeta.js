import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, '../data/anipmbeta_library.json');

const URL = 'https://beta.cno.to/library.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function update() {
  console.log(`[ANIPMBETA] Fetching fresh library from ${URL}...`);
  const t0 = Date.now();

  const res = await fetch(URL, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://beta.cno.to/',
      'x-anitv-peek': '1'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch library.json: HTTP ${res.status} ${res.statusText}`);
  }

  const rawText = await res.text();
  const fetchTime = Date.now() - t0;
  console.log(`[ANIPMBETA] Downloaded ${rawText.length} bytes in ${fetchTime}ms`);

  // Verify valid JSON
  const data = JSON.parse(rawText);
  const titlesCount = data.titles?.length || 0;
  if (!data.built || titlesCount === 0) {
    throw new Error('Downloaded JSON is missing built timestamp or titles array');
  }

  // Check previous version
  let prevCount = 'unknown';
  let prevSize = '0 KB';
  if (fs.existsSync(DATA_FILE)) {
    const prevStat = fs.statSync(DATA_FILE);
    prevSize = `${(prevStat.size / 1024 / 1024).toFixed(2)} MB`;
    try {
      const prevData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      prevCount = prevData.titles?.length || 'unknown';
    } catch {}
  }

  // Atomically save
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, rawText, 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);

  const newStat = fs.statSync(DATA_FILE);
  const newSize = `${(newStat.size / 1024 / 1024).toFixed(2)} MB`;

  console.log('\n✅ [ANIPMBETA] Database updated successfully!');
  console.log(`  - Built timestamp : ${data.built}`);
  console.log(`  - Total titles    : ${prevCount} -> ${titlesCount} (+${titlesCount - (typeof prevCount === 'number' ? prevCount : 0)} new titles)`);
  console.log(`  - File size       : ${prevSize} -> ${newSize}`);
  console.log(`  - File location   : ${DATA_FILE}`);
}

update().catch(err => {
  console.error('❌ [ANIPMBETA] Update failed:', err.message);
  process.exit(1);
});
