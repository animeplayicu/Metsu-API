const UA = 'Mozilla/5.0';
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

async function decryptP() {
  const url = 'https://zokoanime.video/stream/mal/63045/4/sub';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://hianime.fm/' } });
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) { console.log('__P not found'); return; }

  const decrypted = deobfuscate(m[1]);
  console.log('🎉 DECRYPTED DATA:');
  console.log(JSON.stringify(decrypted, null, 2));
}

decryptP().catch(console.error);
