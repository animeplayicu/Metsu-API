const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function checkSite() {
  const res = await fetch('https://aniclover.cc', { headers: { 'User-Agent': UA } });
  console.log('Status:', res.status);
  const html = await res.text();
  console.log('HTML size:', html.length);
  const scripts = [...html.matchAll(/src=["']([^"']+\.js[^"']*)["']/g)].map(m => m[1]);
  console.log('Scripts:', scripts.slice(0, 10));

  // Let's also test an anime watch page on aniclover.cc
  const watchRes = await fetch('https://aniclover.cc/watch/16498?ep=1', { headers: { 'User-Agent': UA } });
  console.log('Watch page status:', watchRes.status);
  const watchHtml = await watchRes.text();
  console.log('Watch HTML length:', watchHtml.length);
  
  // Find script tags on watch
  const watchScripts = [...watchHtml.matchAll(/src=["']([^"']+\.js[^"']*)["']/g)].map(m => m[1]);
  console.log('Watch Scripts:', watchScripts);

  // Check if watch HTML has server or provider names
  const matches = watchHtml.match(/(?:hianime|megacloud|gogoanime|vidstream|zoro|consumet)/gi);
  console.log('Source mentions in watch HTML:', matches ? [...new Set(matches)] : 'none');
}

checkSite().catch(console.error);
