// The page's harness hooks (Engine/Platforms/Wasm/Build/Tools/web reads them). A classic script: its top-level names are shared
// with the page's other scripts, which index.html loads in order (wasm-harness, wasm-compat, wasm-play, wasm-loader).
// Markers: 'UE_RUN BOOT <phase> <ms>' for the phases the page owns (page,
// wasm_compiled, runtime_ready), ms since navigation start.

// Load timings: ms since navigation start, in window.__harness.timings (the harness's result.json) and as LOADTIME lines
window.__harness = window.__harness || {};
const timings = window.__harness.timings = {};
const BOOT_PHASES = { page: 'page', wasm_compiled: 'wasm_compiled', runtime: 'runtime_ready' };
// marked(name): a promise of a mark, resolved at once when it is already set (wasm-loader.js holds the desktop tier's
// prefetch until wasm_compiled)
const markWaiters = {};
const marked = (name) => (name in timings ? Promise.resolve(timings[name])
  : new Promise((resolve) => { (markWaiters[name] = markWaiters[name] || []).push(resolve); }));
const mark = (name) => {
  if (name in timings) return;
  timings[name] = Math.round(performance.now());
  for (const resolve of markWaiters[name] || []) resolve(timings[name]);
  delete markWaiters[name];
  console.log('LOADTIME ' + name + ' ' + timings[name]);
  if (BOOT_PHASES[name]) {
    console.log('UE_RUN BOOT ' + BOOT_PHASES[name] + ' ' + timings[name]);
  }
};

// The engine prints its boot markers against the page's clock: the loader appends these to the UE command line
// (wasm-loader.js: args.concat(window.__harness.ueArgs))
window.__harness.ueArgs = ['-UERunTimeOrigin=' + performance.timeOrigin.toFixed(3)];

// wasm_compiled: when the game's module (the first one over 1 MB) finishes compiling, whichever API Emscripten uses.
// window.__harness.memory: the linear memory the game's module was instantiated with (a threaded build imports it, another
// exports it), for diagnostics that read the heap (wasm-memory.js); a reference only, nothing reads it on a normal load
(() => {
  const big = (source) => source && (source.byteLength > (1 << 20) || source instanceof Response || source instanceof Promise);
  const isMemory = (v) => typeof WebAssembly.Memory === 'function' && v instanceof WebAssembly.Memory;
  const keepMemory = (imports, result) => {
    if (window.__harness.memory) return;
    try {
      for (const space of Object.values(imports || {})) {
        if (space && typeof space === 'object' && isMemory(space.memory)) { window.__harness.memory = space.memory; return; }
      }
      const instance = result && (result.instance || result);
      const exported = instance && instance.exports && instance.exports.memory;
      if (isMemory(exported)) window.__harness.memory = exported;
    } catch (e) { /* not the game's module */ }
  };
  for (const name of ['instantiateStreaming', 'compileStreaming', 'instantiate', 'compile']) {
    const original = WebAssembly[name];
    if (!original) continue;
    WebAssembly[name] = function (source, ...rest) {
      const result = original.call(this, source, ...rest);
      if (big(source) && result && result.then) result.then(() => mark('wasm_compiled'), () => {});
      if (name.startsWith('instantiate') && result && result.then) result.then((r) => keepMemory(rest[0], r), () => {});
      return result;
    };
  }
})();

// ?ue-session=1 (UAT's BuildCookRun -run, which the editor's Launch On runs): one request held open to the engine's web server
// for the page's lifetime; the server stops a few seconds after the last one closes (serve.py --exit-after-session), so the
// run ends with the tab. An EventSource needs no page timers, which browsers throttle in background tabs.
// The stream's first event names the server. Once the stream drops, the page reconnects naming that server
// (__ue/session?server=<id>), so a tab left open after its run ended is refused by the next run's server on the same port
// (204 ends an EventSource for good) instead of keeping that run alive after its own page closed.
if (query.get('ue-session') === '1' && window.EventSource) {
  let serverId = '';
  const open = (url) => {
    let source;
    try { source = new EventSource(url); } catch (e) { return; }
    window.__harness.session = source;
    source.addEventListener('ue-server', (event) => { if (!serverId) serverId = String(event.data || ''); });
    // The first stream reconnects without the id; once the server named itself, swap it for one that names it and let
    // that one reconnect on its own. A server that never names itself keeps the plain reconnect
    source.onerror = () => {
      if (serverId && source.readyState !== EventSource.CLOSED && !source.url.includes('?server=')) {
        source.close();
        open('__ue/session?server=' + encodeURIComponent(serverId));
      }
    };
  };
  open('__ue/session');
}
// The page's console lines go to the same server too (POST __ue/log, in order: every 250 ms, and at once on the game's end
// marker), which prints them as the run's client output (serve.py --game-run): UAT reads its -unattended test-exit line there,
// and the run ends with the game's exit code. A server without --game-run answers 404 and the page stops posting.
if (query.get('ue-session') === '1' && window.fetch) {
  // One console call is one line: a message's own line breaks continue it, indented, so no part of it reads as an end
  // marker. A batch (at most about 512 K characters; a line at most 64 K) is taken when its turn comes, so a failed one goes
  // back in front of later lines (three failures in a row: the server is gone). The header keeps another site's page from
  // posting here (it would need a CORS preflight)
  const queued = [];
  let sending = Promise.resolve(), stopped = false, timer = 0, failures = 0;
  const take = () => {
    let count = 0, size = 0;
    while (count < queued.length && (count === 0 || size + queued[count].length < (1 << 19))) size += queued[count++].length + 1;
    return queued.splice(0, count);
  };
  const send = () => {
    timer = 0;
    sending = sending.then(() => {
      const lines = stopped ? [] : take();
      if (!lines.length) return undefined;
      const failed = () => {
        queued.unshift(...lines);
        if (++failures >= 3) stopped = true;
        else if (!timer) timer = setTimeout(send, 250);
      };
      return fetch('__ue/log', { method: 'POST', headers: { 'X-UE-Log': '1' }, body: lines.join('\n') + '\n' }).then(
        (response) => {
          if (response.status === 404) { stopped = true; return; }
          if (!response.ok) { failed(); return; }
          failures = 0;
          if (queued.length) send();
        }, failed);
    });
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level];
    console[level] = function (...args) {
      original.apply(console, args);
      if (stopped) return;
      const line = args.map(String).join(' ').slice(0, 1 << 16).replace(/\r?\n/g, '\n\t');
      queued.push(line);
      if (/^(?:UE_RUN DONE|HARNESS EXIT|UE_RUN ERROR|HARNESS ABORT)\b/.test(line)) send();
      else if (!timer) timer = setTimeout(send, 250);
    };
  }
}
