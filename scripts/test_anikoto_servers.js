const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function testShow(showId) {
  const url = `https://anikototv.bz/ajax/episode/list?id=${showId}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://anikototv.bz/' }
  });
  const data = await res.json();
  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*data-number="([^"]*)"[^>]*>/g;
  const eps = [];
  let m;
  while ((m = re.exec(data.result || '')) !== null) {
    eps.push({ id: m[1], num: m[2] });
  }
  console.log('Episodes found:', eps.length, 'Sample:', eps.slice(0, 3));

  if (eps.length > 0) {
    const ep1 = eps[0];
    const sUrl = `https://anikototv.bz/ajax/server/list?servers=${encodeURIComponent(ep1.id)}`;
    const sRes = await fetch(sUrl, {
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://anikototv.bz/' }
    });
    const sData = await sRes.json();
    console.log('Server list HTML:\n', sData.result);
  }
}

testShow(2405);
