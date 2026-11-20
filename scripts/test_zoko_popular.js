const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const OBF_KEY = 'otaku-embed-v1';

function xor(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

function deobfuscate(blob) {
  return JSON.parse(decodeURIComponent(escape(xor(Buffer.from(blob, 'base64').toString('binary')))));
}

async function testMal(malId, ep) {
  const url = `https://zokoanime.video/stream/mal/${malId}/${ep}/sub`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://hianime.fm/' } });
  const msFetch = Math.round(performance.now() - t0);
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) {
    console.log(`MAL ${malId} (Ep ${ep}): Not found or no __P (HTTP ${res.status}) in ${msFetch}ms`);
    return;
  }
  const data = deobfuscate(m[1]);
  const totalMs = Math.round(performance.now() - t0);
  console.log(`MAL ${malId} (Ep ${ep}): ⚡ SUCCESS in ${totalMs}ms!`);
  console.log(`  m3u8: ${data.src}`);
  console.log(`  subs: ${data.subtitles?.length || 0} tracks`);
  console.log(`  intro/outro:`, data.skip);
}

async function run() {
  console.log('--- TESTING POPULAR ANIME ON ZOKOANIME ---');
  await testMal(16498, 1);  // Attack on Titan
  await testMal(21, 1);     // One Piece
  await testMal(5114, 1);   // Fullmetal Alchemist: Brotherhood
  await testMal(40748, 1);  // Jujutsu Kaisen
}

run().catch(console.error);
