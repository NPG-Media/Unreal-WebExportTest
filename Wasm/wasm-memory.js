// The page's memory recorder, for work on a web game's memory: loaded only with ?memory=1 (index.html), and inert in a Test or
// Shipping stage (one whose game script is <Game>-Wasm-Test.js or <Game>-Wasm-Shipping.js). Nothing here runs on a normal load.
//
// Wasm memory is never given back to the browser, so the footprint of the game's heap is its highest claimed byte, not what is in
// use: a heap whose in-use bytes stay flat can still grow, by fragmentation or by blocks that live only briefly. Every 10 s from
// 5 s after the page starts the recorder takes a sample: the linear memory's size and the allocator's top (emmalloc's first root
// region's end pointer, found once by its signature in the heap's first 64 MB, which the allocator has already touched), the
// Workers made and alive since it started, and the JS heap where the browser reports it. Every 20 s for the first 3 minutes,
// then every 60 s, it also walks the allocator's regions (a few tens of ms on the main thread for a heap of several hundred MB): in use, free,
// the largest free block, free space by block size (< 64 KB, < 1 MB, < 8 MB, larger: fragmentation shows as many small free
// blocks), and what the heap grew into since the last walk: the used blocks above its top by size (< 4 KB, < 64 KB, < 1 MB,
// larger), the 12 block sizes with the most bytes there and the 8 largest blocks there (64 KB and up), each with its offset and
// its first 16 bytes in hex, which often name what made it. A walk torn by another thread's allocation keeps only the top.
// A build linked with another allocator (WasmTargetRules Malloc) gets the sizes, the Workers and the JS heap only.
//
// Each sample is a PAGE MEMORY line in the console and is kept (90 samples: ten minutes at full rate, older ones thinned); the
// last one also goes to sessionStorage, so the next load in the tab (after the browser ended a page for its memory) reports it as
// previous. <meta name="ue-memory-report-url" content="..."> (an https or same-origin endpoint that takes a JSON POST; empty: no
// report) gets a report every 30 s and one when the page is hidden, so a page that dies leaves its last 30 s behind. A report
// holds samples of the game's heap, blocks' first bytes included: point it only at the project's own endpoint.
// window.ueMemory: sample(walk), report() and samples, for scripted reads.
(() => {
  if (window.ueMemory) return;
  const project = pageMeta('ue-project') || 'game';
  const lastKey = 'ue.' + project + '.memLast';
  const samples = [];
  const info = { root: 0, rootKind: '', walks: 0, walkMs: 0, lastTop: 0, lastWalk: null, made: 0, alive: 0, previous: null, off: '' };
  try { info.previous = JSON.parse(sessionStorage.getItem(lastKey) || 'null'); sessionStorage.removeItem(lastKey); } catch (e) { info.previous = null; }
  // The Workers made from here on, and those not yet terminated
  const Native = window.Worker;
  if (Native) {
    window.Worker = function (url, options) {
      const worker = new Native(url, options);
      info.made++;
      info.alive++;
      const terminate = worker.terminate ? worker.terminate.bind(worker) : null;
      let ended = false;
      worker.terminate = () => { if (!ended) { ended = true; info.alive--; } if (terminate) terminate(); };
      return worker;
    };
    window.Worker.prototype = Native.prototype;
  }
  // The game's linear memory: wasm-harness.js keeps the memory the game's module was instantiated with
  const memory = () => (window.__harness && window.__harness.memory) || null;
  const MB = 1048576;
  const mb = (bytes) => +(bytes / MB).toFixed(1);

  // emmalloc's first RootRegion: [size, next, endPtr, size] of one used region, as 64-bit words (a wasm64 build: 32-byte region)
  // or 32-bit words (a wasm32 build: 16-byte region); the first match whose regions walk consistently for 2000 steps
  function heapRoot(u32, length) {
    const limit = Math.min(length, 64 * MB) >>> 2;
    for (const kind of ['q', 'w']) {
      const size = kind === 'q' ? 32 : 16, last = kind === 'q' ? 6 : 3, step = kind === 'q' ? 2 : 1;
      for (let i = 0; i + 8 < limit; i += step) {
        if (u32[i] !== size || u32[i + last] !== size || (kind === 'q' && (u32[i + 1] || u32[i + 5] || u32[i + 7]))) continue;
        const at = i * 4, end = u32[i + (kind === 'q' ? 4 : 2)];
        if (end <= at + 1024 || end > length) continue;
        if (heapWalk(u32, kind, at, end, 2000, 0).ok) return { at, kind };
      }
    }
    return null;
  }
  // The regions from the root to the top: each starts with its size and ends with it again, the low bit set on a free one.
  // since: the previous walk's top (the blocks above it are what the heap grew into)
  function heapWalk(u32, kind, root, end, maxSteps, since) {
    const w = kind === 'q' ? 8 : 4;
    const out = { ok: true, used: 0, free: 0, largest: 0, regions: 0, freeBy: [0, 0, 0, 0], freeBytesBy: [0, 0, 0, 0], above: [],
      aboveBy: [0, 0, 0, 0], aboveBytesBy: [0, 0, 0, 0], sizes: new Map() };
    let r = root + 4 * w;
    while (r < end - 4 * w && (!maxSteps || out.regions < maxSteps)) {
      const s = u32[r >>> 2];
      if (!s || s & (w - 1) || r + s > end || (kind === 'q' && u32[(r >>> 2) + 1])) { out.ok = false; break; }
      const tag = u32[(r + s - w) >>> 2];
      if ((tag & ~1) !== s) { out.ok = false; break; }
      if (tag & 1) {
        out.free += s;
        if (s > out.largest) out.largest = s;
        const b = s < 65536 ? 0 : s < MB ? 1 : s < 8 * MB ? 2 : 3;
        out.freeBy[b]++; out.freeBytesBy[b] += s;
      } else {
        out.used += s;
        if (since && r + s > since) {
          if (s >= 65536) out.above.push([r, s]);
          const b = s < 4096 ? 0 : s < 65536 ? 1 : s < MB ? 2 : 3;
          out.aboveBy[b]++; out.aboveBytesBy[b] += s;
          const g = out.sizes.get(s);
          if (g) g[0]++; else out.sizes.set(s, [1, r]);
        }
      }
      out.regions++;
      r += s;
    }
    return out;
  }
  // a block's first 16 bytes (after its size word) as four little-endian 32-bit words in hex
  const hex = (u32, at) => { let t = ''; for (let i = 0; i < 4; i++) t += (u32[(at >>> 2) + i] >>> 0).toString(16).padStart(8, '0'); return t; };

  function sample(walk) {
    const s = { t_s: Math.round(performance.now() / 1000), cover: document.body && document.body.dataset ? document.body.dataset.cover || '' : '',
      workers: info.alive, workers_made: info.made };
    try {
      const mem = memory();
      const buffer = mem && mem.buffer;
      if (buffer && buffer.byteLength <= 4096 * MB) {
        const u32 = new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
        s.heap_mb = Math.round(buffer.byteLength / MB);
        if (!info.root) {
          const found = heapRoot(u32, buffer.byteLength);
          if (found) { info.root = found.at; info.rootKind = found.kind; }
        }
        if (info.root) {
          const end = u32[(info.root + (info.rootKind === 'q' ? 16 : 8)) >>> 2];
          s.top_mb = mb(end);
          if (walk || !info.walks) {
            const t0 = performance.now();
            const h = heapWalk(u32, info.rootKind, info.root, end, 0, info.lastTop);
            const ms = Math.round(performance.now() - t0);
            info.walks++;
            info.walkMs = Math.max(info.walkMs, ms);
            const first = (o) => hex(u32, o + (info.rootKind === 'q' ? 8 : 4));
            if (h.ok) {
              Object.assign(s, { used_mb: mb(h.used), free_mb: mb(h.free), largest_free_mb: mb(h.largest), regions: h.regions, walk_ms: ms,
                free_by: h.freeBy, free_mb_by: h.freeBytesBy.map(mb), above_by: h.aboveBy, above_mb_by: h.aboveBytesBy.map(mb),
                above_sizes: [...h.sizes].sort((x, y) => y[0] * y[1][0] - x[0] * x[1][0]).slice(0, 12).map(([n, [k, o]]) => [n, k, +(n * k / MB).toFixed(2), first(o)]),
                above: h.above.sort((x, y) => y[1] - x[1]).slice(0, 8).map(([o, n]) => [o, +(n / MB).toFixed(2), first(o)]) });
              info.lastTop = end;
              info.lastWalk = s;
            } else {
              s.walk = 'torn';
            }
          }
        }
      }
    } catch (e) { s.error = String(e).slice(0, 120); }
    try { if (performance.memory) s.js_mb = Math.round(performance.memory.usedJSHeapSize / MB); } catch (e) { /* not reported here */ }
    samples.push(s);
    if (samples.length > 90) samples.splice(30, 60, ...samples.slice(30, 90).filter((x, i) => i % 3 === 0));
    console.log('PAGE MEMORY ' + JSON.stringify(s));
    try {
      sessionStorage.setItem(lastKey, JSON.stringify(Object.assign({ at: new Date().toISOString() }, s,
        info.lastWalk && info.lastWalk !== s ? { walk_sample: info.lastWalk } : {})));
    } catch (e) { /* storage off */ }
    return s;
  }
  function report() {
    return { version: 1, page: location.pathname, at: new Date().toISOString(), t_ms: Math.round(performance.now()), samples: samples.slice(),
      heap_root: info.root, heap_root_kind: info.rootKind, walks: info.walks, walk_ms_max: info.walkMs, workers_made: info.made,
      workers_alive: info.alive, previous: info.previous, user_agent: navigator.userAgent };
  }
  const url = pageMeta('ue-memory-report-url');
  const target = url && (/^https:\/\//.test(url) || /^\/(?!\/)/.test(url)) ? url : '';
  function post(kind) {
    if (!target) return;
    const body = report();
    body.kind = kind;
    const hiding = document.visibilityState === 'hidden';
    let text = JSON.stringify(body);
    // a report sent as the page goes away travels with keepalive, which takes 64 KiB at most: the oldest samples go first
    while (hiding && text.length > 60000 && body.samples.length > 1) { body.samples.splice(0, Math.ceil(body.samples.length / 4)); text = JSON.stringify(body); }
    try {
      fetch(target, { method: 'POST', mode: 'cors', credentials: 'omit', keepalive: hiding && text.length <= 60000, headers: { 'Content-Type': 'application/json' }, body: text })
        .then((r) => console.log('PAGE MEMORY_REPORT ' + kind + ' ' + r.status), (e) => console.log('PAGE MEMORY_REPORT ' + kind + ' failed: ' + e));
    } catch (e) { console.log('PAGE MEMORY_REPORT ' + kind + ' failed: ' + e); }
  }
  window.ueMemory = { sample, report, samples };
  // Development and Debug stages only: the game script the stage lists names its configuration (wasm-loader.js ueStageFiles)
  const releaseStage = () => {
    const scripts = (window.ueStageFiles || []).map((f) => String(f.url)).filter((u) => /\/Binaries\/Wasm\/[^/]+\.js$/.test(u));
    return !scripts.length ? null : scripts.every((u) => /-Wasm-(?:Test|Shipping)\.js$/.test(u));
  };
  let count = 0;
  let timer = 0;
  const tick = () => {
    const release = releaseStage();
    if (release) {
      clearInterval(timer);
      console.log('PAGE MEMORY off: a Test or Shipping stage');
      return;
    }
    if (release === null && count > 2) {   // no game script listed after 25 s: the stage cannot be told, so nothing is recorded
      clearInterval(timer);
      console.log('PAGE MEMORY off: the stage lists no game script');
      return;
    }
    if (release === null) { count++; return; }
    sample(count % (count < 18 ? 2 : 6) === 0);
    if (count % 3 === 2) post('tick');
    count++;
  };
  setTimeout(() => { tick(); timer = setInterval(tick, 10000); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && samples.length) post('hidden'); });
  console.log('PAGE MEMORY recorder on' + (target ? ', reports to ' + target : '') + (info.previous ? ' (the last page in this tab left a sample)' : ''));
})();
