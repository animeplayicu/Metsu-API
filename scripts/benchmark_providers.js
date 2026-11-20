const PROD_BASE = 'https://api.animetsu.site';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://animetsu.site',
  'Referer': 'https://animetsu.site/'
};

const TEST_ANIME = [
  { id: 21, name: 'One Piece', ep: 1 },
  { id: 16498, name: 'Attack on Titan', ep: 1 },
  { id: 101922, name: 'Demon Slayer', ep: 1 }
];

const PROVIDERS = ['animegg', 'anikoto', 'anipmbeta', 'reanime'];

async function timedFetch(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: HEADERS });
    const elapsed = Math.round(performance.now() - t0);
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status, elapsed, data };
  } catch (err) {
    const elapsed = Math.round(performance.now() - t0);
    return { ok: false, status: 'ERR', elapsed, error: err.message };
  }
}

async function runBenchmark() {
  console.log(`========================================================================`);
  console.log(`⚡ SPEED TEST ON PRODUCTION API: ${PROD_BASE}`);
  console.log(`Testing Providers: ${PROVIDERS.join(', ')}`);
  console.log(`========================================================================\n`);

  for (const anime of TEST_ANIME) {
    console.log(`🎯 [ANIME] ${anime.name} (AniList ID: ${anime.id})`);
    console.log(`------------------------------------------------------------------------`);
    console.log(`Provider    | Endpoint      | Latency (ms) | Status | Details / Episodes`);
    console.log(`------------|---------------|--------------|--------|-------------------`);

    for (const prov of PROVIDERS) {
      // 1. Test Episodes Endpoint
      const epUrl = `${PROD_BASE}/episodes/${prov}/${anime.id}`;
      const epRes = await timedFetch(epUrl);
      let epDetail = '-';
      if (epRes.ok && epRes.data) {
        const subCount = epRes.data.episodes?.sub?.length || epRes.data.sub?.length || 0;
        const dubCount = epRes.data.episodes?.dub?.length || epRes.data.dub?.length || 0;
        epDetail = `${subCount} sub, ${dubCount} dub`;
      } else {
        epDetail = epRes.error || `HTTP ${epRes.status}`;
      }
      console.log(`${prov.padEnd(11)} | /episodes     | ${(epRes.elapsed + 'ms').padEnd(12)} | ${String(epRes.status).padEnd(6)} | ${epDetail}`);

      // 2. Test Watch Endpoint
      const watchUrl = `${PROD_BASE}/watch/${prov}/${anime.id}/sub/${prov}-${anime.ep}`;
      const watchRes = await timedFetch(watchUrl);
      let watchDetail = '-';
      if (watchRes.ok && watchRes.data) {
        const streams = watchRes.data.streams?.length || (watchRes.data.stream_url ? 1 : 0);
        const source = watchRes.data.source || 'live';
        watchDetail = `${streams} stream(s) [${source}]`;
      } else {
        watchDetail = watchRes.error || `HTTP ${watchRes.status}`;
      }
      console.log(`${prov.padEnd(11)} | /watch (ep ${anime.ep}) | ${(watchRes.elapsed + 'ms').padEnd(12)} | ${String(watchRes.status).padEnd(6)} | ${watchDetail}`);
      console.log(`- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -`);
    }
    console.log(`\n`);
  }
}

runBenchmark().catch(console.error);
