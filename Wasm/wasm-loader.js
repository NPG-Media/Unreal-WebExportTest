// The loader: the manifest, the data cache, the command line, the game script. A classic script: its top-level names are shared
// with the page's other scripts, which index.html loads in order (wasm-harness, wasm-compat, wasm-play, wasm-loader).

// The service worker's URL: ?swranges=wait|net and the isolation fallback as its own query
function swUrl() {
  const p = new URLSearchParams();
  if (query.get('swranges')) p.set('ranges', query.get('swranges'));
  if (pageMeta('ue-sw-isolation') === '1') p.set('isolate', '1');
  if (pageMeta('ue-sw-late-fill') === 'early') p.set('late', 'early');
  if (pageMeta('ue-sw-waves') === '1') p.set('waves', '1');

  const q = p.toString();
  return q ? 'sw.js?' + q : 'sw.js';
}

// The pool's start-up load: Emscripten posts the compiled module to every pool Worker (PTHREAD_POOL_SIZE, 56 at 16 or more
// cores) and runs main once all have instantiated it; 56 instantiating at once took ~1.2 s each where 16 take ~0.3 s
// (Chrome, Lyra's 254 MB module), so the pool held the runtime ~1.7 s on a warm visit. The page sends the load message
// (cmd 1) at once to the last ue-pool-first pool Workers (Emscripten hands out the last one first), answers 'loaded' (cmd 3)
// for the others and sends theirs ue-pool-batch at a time once the first ones are in; a thread started on a held Worker
// (cmd 2) releases its load message first, so the Worker still sees load before run. ?poolfirst=0 (or the meta 0) turns it off
const POOL_FIRST = Number(query.get('poolfirst') || pageMeta('ue-pool-first', '16')) || 0;
const POOL_BATCH = Math.max(1, Number(pageMeta('ue-pool-batch', '8')) || 8);
// Every Worker the game creates, with its time since navigation, as WORKER lines. Emscripten's pthread pool is created before
// main; a thread past it waits for a new Worker to load (serial at start-up)
(() => {
  const Native = window.Worker;
  if (!Native) return;
  let count = 0;
  const pool = [];          // the pthread Workers, in creation order
  const held = new Map();   // Worker -> its held load message [message, transfer]
  const loading = new Set();
  let first = -1;           // Workers still loading of the first tranche (-1 before it starts)
  const nativePost = Native.prototype.postMessage;
  const release = (w) => {
    const m = held.get(w);
    if (!m) return;
    held.delete(w);
    loading.add(w);
    nativePost.call(w, ...m);
  };
  const nextBatch = () => {
    // the Workers Emscripten hands out next first: the end of its unused list, the latest created
    const batch = [...held.keys()].slice(-POOL_BATCH);
    for (const w of batch) release(w);
    if (!held.size) console.log('PAGE POOL all released ' + Math.round(performance.now()));
  };
  const loaded = (w) => {
    if (!loading.delete(w)) return;
    if (first > 0 && --first === 0) console.log('PAGE POOL first ' + POOL_FIRST + ' loaded ' + Math.round(performance.now()));
    if (first === 0 && !loading.size && held.size) nextBatch();
    if (first === 0 && !loading.size && !held.size) console.log('PAGE POOL all loaded ' + Math.round(performance.now()));
  };
  window.Worker = function (url, options) {
    count += 1;
    console.log('WORKER ' + count + ' ' + Math.round(performance.now()) + (timings.runtime !== undefined ? ' after-runtime' : ''));
    const worker = new Native(url, options);
    if (POOL_FIRST > 0 && options && /^em-pthread/.test(options.name || '')) {
      pool.push(worker);
      worker.addEventListener('message', (e) => { if (e.data && e.data.cmd === 3) loaded(worker); });
      worker.postMessage = function (message, ...transfer) {
        const load = message && message.cmd === 1 && message.wasmModule instanceof WebAssembly.Module;
        if (load && timings.runtime === undefined && pool.indexOf(worker) < pool.length - POOL_FIRST) {
          held.set(worker, [message, ...transfer]);
          // Emscripten's pool promise resolves on 'loaded'; the Worker's own 'loaded' comes later and is a no-op there
          Promise.resolve().then(() => worker.onmessage && worker.onmessage(new MessageEvent('message', { data: { cmd: 3 } })));
          return;
        }
        if (held.has(worker)) {
          console.log('PAGE POOL thread on a held Worker ' + Math.round(performance.now()));
          release(worker);
        }
        if (load) {
          loading.add(worker);
          if (first < 0) first = Math.min(POOL_FIRST, pool.length);
        }
        return nativePost.call(worker, message, ...transfer);
      };
    }
    return worker;
  };
  window.Worker.prototype = Native.prototype;
})();
console.log('LOADTIME origin ' + Math.round(performance.timeOrigin));

// What a link's ?args= may pass (<meta name="ue-query-args">, setting QueryArgs; UAT writes all in Development,
// safe in Test and Shipping). safe: a map under /Game/ and the page's own switches; the rest are dropped with a PAGE ARGS line
const SAFE_QUERY_ARGS = [/^\/Game\/[A-Za-z0-9_\/.-]+$/, /^-culture=[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/i,
  /^-WebQualityPreset=(?:Low|Medium|High|Epic|Cinematic)$/i, /^-WebScreenPercentage=\d{2,3}$/i];
function linkArgs(args) {
  const mode = pageMeta('ue-query-args', 'safe');
  if (mode === 'all' || !args.length) return args;
  const kept = mode === 'off' ? [] : args.filter((a) => SAFE_QUERY_ARGS.some((re) => re.test(a)));
  if (kept.length !== args.length) console.log('PAGE ARGS dropped ' + (args.length - kept.length) + ' of ' + args.length + ' link arguments (ue-query-args ' + mode + ')');
  return kept;
}
// A15 (EngineTest): arguments split as a shell splits them: whitespace outside double quotes separates, and the quotes are
// removed (`"-ExecCmds=a b"` and `-ExecCmds="a b"` both give the one argument -ExecCmds=a b). The engine's main
// (LaunchWasm.cpp) quotes an argument's value again when it holds a space, so UE's parser reads the whole value; a token
// that kept its quotes reached UE as `"-ExecCmds=a` and ran only the first command
function splitArgs(text) {
  const out = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of String(text || '')) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (started) out.push(current); current = ''; started = false; continue; }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}
// The host's kill switch for the data cache: wasm-cache.json is {"sw": "off"}
async function swKilled() {
  try { const list = await (await fetch('wasm-cache.json', { cache: 'no-cache' })).json(); return !!(list && !Array.isArray(list) && list.sw === 'off'); } catch (e) { return false; }
}

(async () => {
  mark('page');
  // A host without header control (ue-sw-isolation 1): the service worker adds the isolation headers, then the
  // page reloads once under it. A second load that is still not isolated goes on to the compat check's message
  if (pageMeta('ue-sw-isolation') === '1' && !window.crossOriginIsolated && 'serviceWorker' in navigator && query.get('sw') !== '0') {
    let tried = false;
    try { tried = sessionStorage.getItem('ue.isolation.reload') === '1'; } catch (e) { tried = true; }
    // a host that turned the worker off ({"sw":"off"}) gets no register-and-reload loop
    if (!tried && await swKilled()) { tried = true; console.log('PAGE ISOLATION skipped: the data cache is off for this site'); }
    if (!tried) {
      try {
        const registration = await navigator.serviceWorker.register(swUrl());
        // wait for the isolating worker itself (an older worker without isolate=1 makes 'ready' resolve at once,
        // and the reload would not be isolated)
        await new Promise((resolve) => {
          const isolating = () => registration.active && /[?&]isolate=1(?:&|$)/.test(registration.active.scriptURL) && registration.active.state === 'activated';
          if (isolating()) { resolve(); return; }
          const poll = setInterval(() => { if (isolating()) { clearInterval(poll); resolve(); } }, 50);
          setTimeout(() => { clearInterval(poll); resolve(); }, 5000);
        });
        sessionStorage.setItem('ue.isolation.reload', '1');
        console.log('PAGE ISOLATION reload under the service worker');
        location.reload();
        return;
      } catch (e) { console.log('PAGE ISOLATION fallback failed: ' + e); }
    }
  }
  try { sessionStorage.removeItem('ue.isolation.reload'); } catch (e) { /* private window */ }
  // Stop at a browser that cannot run the game; the GPU adapter is asked for while the manifest loads
  ueSteps.set('browser', 'active');
  const unsupported = window.ueCompat ? window.ueCompat.check() : null;
  if (unsupported || window.ueCompatOnly) {
    if (unsupported) { ueSteps.set('browser', 'warn', 'not supported'); fail(unsupported, 'browser'); }
    return;
  }
  // The steps on the loading screen (wasm-play.js), each with what it found
  const who = window.ueCompat && window.ueCompat.browser ? window.ueCompat.browser() : { name: 'browser', version: '' };
  const advice = window.ueCompat && window.ueCompat.advice ? window.ueCompat.advice() : null;
  ueSteps.set('browser', advice ? 'warn' : 'done', (who.name + ' ' + who.version).trim() + ', WebGPU on');
  // The advice line on the key hint's plate (index.html #notice.advice), and again on the playing page for 10 s (the toast),
  // where a player who missed the loading screen reads it
  if (advice) { notice(advice); $('notice').classList.add('advice'); if (!harness) toast(advice); }
  ueSteps.set('gpu', 'active');
  ueSteps.set('settings', 'active');
  const gpuProbe = window.ueCompat && window.ueCompat.probe ? window.ueCompat.probe() : Promise.resolve({ message: null });
  gpuProbe.then((gpu) => {
    const a = gpu.adapter;
    const name = a ? [a.vendor, a.architecture, a.device || a.description].filter(Boolean).join(' ') : '';
    ueSteps.set('gpu', gpu.message ? 'warn' : 'done', gpu.message ? 'none usable' : (name || 'the browser does not name it') + (a && a.integrated ? ', integrated' : ''));
  });
  // The start arguments the compat check picks (the renderer tier when the stage has two, and with the GPU check on, the
  // starting resolution); the check runs while the files download
  const startArgs = window.ueCompat && window.ueCompat.startArgs ? window.ueCompat.startArgs() : Promise.resolve([]);
  // The page's GPU device (wasm-prewarm.js) is requested once the check has picked the tier, while the files download
  if (window.uePrewarm) window.uePrewarm.start(startArgs);
  startArgs.then(async () => {
    const p = window.ueCompat && window.ueCompat.pick ? window.ueCompat.pick() : { source: 'none' };
    const renderer = (p.tier === 'desktop' ? 'desktop renderer' : p.tier === 'deferred' ? 'deferred renderer' : 'forward renderer') + (p.preset ? ', ' + p.preset : '');
    const sp = p.screen_percentage ? ', ' + p.screen_percentage + ' % resolution' : '';
    // The textures' format: the chosen texture set's features (UAT -WasmAddTextureSet; startArgs waited for the choice, so it is
    // in already, and a page that never chose one does not wait), else the stage's ue-texture-formats
    const set = window.ueCompat && window.ueCompat.hasTextureSets && window.ueCompat.hasTextureSets()
      ? await Promise.race([window.ueCompat.textureSet(), new Promise((resolve) => setTimeout(() => resolve(null), 0))]) : null;
    const formats = set ? set.features : pageMeta('ue-texture-formats', 'texture-compression-bc').split(',').map((s) => s.trim());
    const textures = formats.includes('texture-compression-astc') ? ', ASTC textures' : formats.includes('texture-compression-bc') ? ', BC textures' : '';
    const detail = p.source === 'measured' && p.bench && p.bench.ms
      ? `took ${p.bench.total_ms < 1000 ? p.bench.total_ms + ' ms' : (p.bench.total_ms / 1000).toFixed(1) + ' s'}, ${p.bench.ms} ms per test draw: ${renderer}${sp}`
      : p.source === 'stored' ? `from this browser's last check: ${renderer}${sp}`
        : p.source === 'forced' ? `set by the link${sp}` : p.tier ? renderer : 'the defaults';
    ueSteps.set('settings', 'done', detail + textures);
  }, () => ueSteps.set('settings', 'warn', 'the defaults'));
  // The later pak chunks' containers (sw.js isLate) load whole once the game is ready; sw.js releases them itself 20 s after
  // the boot containers are in when the page has not
  let latePosted = false;
  const postLate = () => {
    if (latePosted || !navigator.serviceWorker || !cached) return;   // an uncached load reads the late chunks directly
    // a page the worker does not control yet posts once it does
    if (!navigator.serviceWorker.controller) {
      console.log('LOADTIME late_waiting ' + Math.round(performance.now()));
      navigator.serviceWorker.addEventListener('controllerchange', postLate, { once: true });
      return;
    }
    latePosted = true;
    console.log('LOADTIME late_posted ' + Math.round(performance.now()));
    navigator.serviceWorker.controller.postMessage({ type: 'prefetch-late' });
  };
  // The engine's ready event (wasm-play.js lists the names); a Shipping log prints no ready line
  for (const name of ['ue-ready', 'ue-site-ready', 'ue-interactive']) {
    window.addEventListener(name, () => { console.log('LOADTIME site_ready ' + Math.round(performance.now())); postLate(); });
  }
  // The page's own defaults first (index.html <meta name=ue-args>), e.g. the thread caps Chrome's Worker limit needs
  const defaults = splitArgs(pageMeta('ue-args'));
  // Arguments for one browser only (<meta name="ue-args-firefox">, -chrome, -safari, -edge), e.g. a cheaper auto
  // exposure where pipelines compile one at a time: "-ini:Engine:[ConsoleVariables]:r.EyeAdaptation.MethodOverride=2"
  const browserName = (window.ueCompat && window.ueCompat.browser ? window.ueCompat.browser().name : '').toLowerCase();
  if (browserName) defaults.push(...splitArgs(pageMeta('ue-args-' + browserName)));
  // The device profile's arguments (wasm-profile.js: <meta name="ue-args-ios">, -android, -desktop) and its settings in the log.
  // They win over the page's and the browser's: UE reads a flag's first occurrence, so the profile's flags go first, and it applies
  // -ini: overrides in order (the last one wins; +Key adds to an array), so the profile's -ini: arguments go after every default
  const profile = window.ueProfile || null;
  const profileArgs = profile ? splitArgs(pageMeta('ue-args-' + profile.name)) : [];
  const profileIni = profileArgs.filter((a) => /^-ini:/i.test(a));
  defaults.unshift(...profileArgs.filter((a) => !/^-ini:/i.test(a)));
  // Threading and sound for this device class (wasm-compat.js threading(): the project settings' ue-threads-*, ue-sound-* and
  // ue-pool-* metas, ?threads= and ?sound=; the class is the device profile's). The defaults keep iOS single-threaded without
  // sound, Android and desktop threaded. The pool size goes to the game script's PTHREAD_POOL_SIZE expression
  // (window.ueProfile.poolSize, read before the pool is made); a device profile's pool=N, or a page script that set
  // ueProfile.poolSize itself, keeps it when it is a whole number from 1 to 128 (the expression's own test, WasmTargetRules.cs
  // PthreadPoolSize); any other value is dropped, so the threading settings' pool applies (a PAGE THREADS line names the refused
  // value). The choice is made once, here; no template script that runs later writes the pool, and a value a project's later
  // script writes is checked only by the expression, which falls back to the link's own rule. Single-threaded, the profile's
  // audio thread (wasm-profile.js: ?audiothread=1, <meta name="ue-audio-thread">) gives sound one pthread of its own
  // (-WebAudioThread) instead of the game thread's mixer, which crackles and stops in long frames; ueProfile.audioThread then
  // holds whether it runs, and the link's iOS pool expression adds one for it
  const threading = window.ueCompat && window.ueCompat.threading ? window.ueCompat.threading() : null;
  if (threading) {
    defaults.push(...threading.args);
    // (the page's object is read and written inside try: a value that cannot be read or converted counts as none)
    try {
      window.ueProfile = window.ueProfile || {};
      window.ueProfile.audioThread = threading.audioThread;
      const pagePool = window.ueProfile.poolSize;
      let n = NaN;
      try { n = Number(pagePool); } catch (e) { n = NaN; }   // (Number throws on a Symbol)
      const validPool = Number.isInteger(n) && n >= 1 && n <= 128 ? n : 0;
      if (pagePool != null && pagePool !== '' && !validPool) {
        let shown = '';
        try { shown = String(pagePool); } catch (e) { shown = typeof pagePool; }
        console.log('PAGE THREADS pool ' + shown + ' refused: not a whole number from 1 to 128');
      }
      if (validPool) threading.why.pool = 'profile';
      window.ueProfile.poolSize = validPool || threading.pool || null;
    } catch (e) {
      console.log("PAGE THREADS the page's pool could not be read, the link's rule applies: " + e);
    }
    let pool = null;
    try { pool = window.ueProfile.poolSize || null; } catch (e) { pool = null; }
    console.log('WEB_THREADS ' + JSON.stringify({ ...threading, pool }));
  } else if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) {
    // wasm-compat.js did not load (or has no threading()): keep the template's iOS defaults, single-threaded without sound,
    // which an iPhone or iPad tab needs to start at all
    defaults.push('-nothreading', '-nosound');
    console.log('WEB_THREADS {"class":"ios","threads":"single","sound":false,"why":"wasm-compat.js threading() unavailable"}');
  }
  // Cache priming: a game that can start from a pre-baked file instead of building that data on its first start (a cache it
  // writes later, data that takes many pipelines to make) names it here. On a priming load the page passes the game its switches
  // (<meta name="ue-prime-args">) and asks the data cache to load the file with the start-up files (<meta name="ue-prime-file">,
  // its URL as wasm-cache.json lists it), so the engine's read does not wait for it. <meta name="ue-prime-when">: first (the
  // default: a browser that has not reached the game's ready state on this page before), serial (a browser that builds its
  // pipelines one at a time, where building is slowest) or always. Nothing happens while both are empty
  const primeArgs = splitArgs(pageMeta('ue-prime-args'));
  const primeFile = pageMeta('ue-prime-file').trim();
  const primedKey = 'ue.' + (pageMeta('ue-project') || 'game') + '.primed';
  let primeWhy = '';
  if (primeArgs.length || primeFile) {
    const when = pageMeta('ue-prime-when', 'first');
    let seen = false;
    try { seen = localStorage.getItem(primedKey) === '1'; } catch (e) { seen = false; }
    const who = window.ueCompat && window.ueCompat.browser ? window.ueCompat.browser() : { name: '', os: '' };
    const serial = who.name === 'Firefox' || who.name === 'Safari' || who.os === 'iOS';
    primeWhy = when === 'always' ? 'always' : when === 'serial' ? (serial ? 'a browser that builds pipelines one at a time' : '') : (!seen ? 'a first visit' : '');
    if (primeWhy) {
      defaults.push(...primeArgs);
      console.log('PAGE PRIME ' + primeWhy + ': ' + (primeArgs.join(' ') || 'no arguments') + (primeFile ? ', ' + primeFile : ''));
    }
  }
  // the next load is no first visit once this one reached the game's ready state (the engine's ready event or line)
  const markPrimed = () => { if (primeArgs.length || primeFile) { try { localStorage.setItem(primedKey, '1'); } catch (e) { /* private window */ } } };
  window.addEventListener('ue-ready', markPrimed, { once: true });
  const project = pageMeta('ue-project');
  if (!project || project.includes('%')) {
    fail('This page names no project (<meta name="ue-project">): stage it with UAT (BuildCookRun -platform=Wasm), which fills it in.');
    return;
  }
  const status = $('status');
  const canvas = $('canvas');
  // The render target at most ue-max-dpr device pixels per CSS pixel (default 1)
  const dpr = Math.min(window.devicePixelRatio || 1, Number(pageMeta('ue-max-dpr')) || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  let manifest = [];
  let files = [];
  try {
    manifest = await (await fetch('wasm-manifest.json', { cache: 'no-cache' })).json();
    mark('manifest');
  } catch (e) {
    console.log('HARNESS ABORT no wasm-manifest.json: ' + e);
    fail('The game files are missing (wasm-manifest.json): ' + e);
    return;
  }
  let swOff = false;
  try {
    files = await (await fetch('wasm-cache.json', { cache: 'no-cache' })).json();
  } catch (e) {
    // a stage packaged before wasm-cache.json existed
  }
  if (!Array.isArray(files)) { swOff = !!(files && files.sw === 'off'); files = []; }   // {"sw": "off"}: the host's kill switch
  // A stage with two texture sets (wasm-compat.js textureSet): the files tagged with a set ("set": "bc", "set": "astc", the
  // added set's below Content/Paks/ASTC/) are that set's; only the chosen set's go to the engine and the data cache, so the
  // engine mounts one set's containers and the other set's are never fetched. An adapter that fits no set stops here, before
  // any game file is fetched
  // The manifest says whether the stage has texture sets too: without wasm-compat.js (it failed to load) the page cannot
  // choose a set, and it must not mount both
  const taggedSets = manifest.some((e) => e.set) || files.some((e) => e.set);
  const compatSets = !!(window.ueCompat && window.ueCompat.hasTextureSets && window.ueCompat.hasTextureSets());
  if (taggedSets && !(window.ueCompat && window.ueCompat.textureSet)) {
    console.log('HARNESS ABORT texture sets without wasm-compat.js');
    fail('The game could not start: its browser check (wasm-compat.js) did not load. Reload the page to try again.');
    return;
  }
  if (taggedSets || compatSets) {
    const set = await window.ueCompat.textureSet();
    if (!set) {
      const gpu = await gpuProbe;
      fail(gpu.message || 'This GPU has no texture format this game was cooked for.');
      return;
    }
    const inSet = (e) => !e.set || e.set === set.name;
    manifest = manifest.filter(inSet);
    files = files.filter(inSet);
    // the RHI asks for ASTC only on an adapter without BC unless told to (WebGPUDevice.cpp -WebGPUASTC)
    if (set.features.includes('texture-compression-astc')) defaults.push('-WebGPUASTC');
    console.log(`PAGE TEXTURE_SET ${set.name}: ${manifest.filter((e) => e.set).length} of the set's own files mounted, ${manifest.length} in all`);
  }
  // A file split into parts (a host's per-file limit) loads only through the data cache: without it the game would
  // stop on a missing file deep in the load
  const splitFiles = files.filter((f) => Array.isArray(f.parts) && f.parts.length);
  // The data cache (sw.js): Brotli whole-file loads and a second visit from Cache Storage. On by default; ?sw=0 runs without it
  // and removes a registered one
  let cached = false;
  let swScope = null;   // the data cache's scope: the module's URL in 'module-compiled' is resolved against it, as sw.js lists it
  if ('serviceWorker' in navigator) {
    if (query.get('sw') === '0' || swOff) {
      // a page the worker still controls would keep reading through it: reload once it is gone
      const controlled = !!navigator.serviceWorker.controller;
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      let reloaded = false;
      try { reloaded = sessionStorage.getItem('ue.sw.unregistered') === '1'; } catch (e) { reloaded = true; }
      if (controlled && !reloaded) {
        try { sessionStorage.setItem('ue.sw.unregistered', '1'); } catch (e) { /* private window */ }
        location.reload();
        return;
      }
    } else {
      try {
        // ?swranges=wait registers the worker that waits for the whole-file load instead of reading ranges from the network
        const registration = await navigator.serviceWorker.register(swUrl());
        swScope = registration.scope;
        // (A reload of a page whose worker was already active, and a hard reload, which the worker never controls,
        // waited here for ever at "Starting..."): a first install waits for the worker's claim (up to 15 s); an already active
        // worker that does not control the page gets a second for it, then this load runs uncached (the fetch backend reads the
        // network directly)
        // A hard reload is not controlled by the active worker: ask it to claim the page (sw.js 'claim'), so the reload reads
        // the cached files instead of downloading the game again
        if (!navigator.serviceWorker.controller) {
          const active = registration.active;
          await new Promise(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
            if (active) active.postMessage({ type: 'claim' });
            setTimeout(resolve, active ? 2000 : 15000);
          });
          if (active && navigator.serviceWorker.controller) console.log('PAGE SW_CLAIMED: the active worker took over this load (a hard reload)');
        }
        if (navigator.serviceWorker.controller) {
          cached = true;
          mark('sw');
          // First the list this page read, so the worker serves this page (and its Workers) that build's files
          // even after a deploy or a worker restart; then every game file's whole-file load (sw.js prefetch)
          navigator.serviceWorker.controller.postMessage({ type: 'bind', files });
          navigator.serviceWorker.controller.postMessage({ type: 'prefetch' });
          // a priming load's pre-baked file loads with the start-up files (above: ue-prime-file)
          if (primeWhy && primeFile) navigator.serviceWorker.controller.postMessage({ type: 'prefetch-file', url: primeFile });
          // the desktop or deferred tier's loose files that the engine reads at start (global shaders and the pipeline list, about
          // 44 MB on Lyra's desktop tier) load once the page has picked that tier and the game's wasm is compiled (sw.js
          // prefetchTier); the forward tier's files are in the containers, so a forward pick posts 'mobile', which loads only its
          // pipeline list; the rest load when the engine reads them. Loaded alongside the wasm download, Chrome failed the wasm read
          // (253 MB, Development) with net::ERR_BLOB_OUT_OF_MEMORY on most desktop loads; the wasm is the critical path, and
          // the engine reads none of these files before its runtime is up
          const controller = navigator.serviceWorker.controller;
          const codeIn = Promise.race([marked('wasm_compiled'), marked('runtime')]);
          // (the mobile tier's own start file, its pipeline list, loads the same way)
          Promise.all([startArgs, codeIn]).then(([args]) => {
            // a start without tier switches (?compat=1, a harness run without ?tier=) runs the project's tier (ueCompat.runningTier)
            const running = window.ueCompat && typeof window.ueCompat.runningTier === 'function' ? window.ueCompat.runningTier(args)
              : (args || []).includes('-WebGPUSM5') ? 'desktop' : (args || []).includes('-WebGPUMobileDeferred') ? 'deferred' : 'forward';
            const tier = running === 'forward' ? 'mobile' : running;
            if (tier !== 'mobile') console.log('LOADTIME tier_posted ' + Math.round(performance.now()));
            controller.postMessage({ type: 'prefetch-tier', tier });
          }, () => {});
        } else {
          console.log('service worker not controlling this load (a hard reload): uncached');
        }
      } catch (e) {
        console.log('service worker unavailable: ' + e);
      }
    }
  }
  try { sessionStorage.removeItem('ue.sw.unregistered'); } catch (e) { /* private window */ }
  // The game's module starts loading and compiling now, through the data cache, instead of when the game script runs:
  // before it the page measures the display's rate (up to 1 s of frames), reads the command line and the script, and
  // the module's 254 MB read and compile (or the load of its compiled code, which Chrome keeps for a cached response) waited
  // for all of it (EMA ttff-wasm-cache). Module.instantiateWasm instantiates the compiled module; ?wasmearly=0 leaves
  // Emscripten's own instantiateStreaming at the script's start. The compile goes through wasm-harness.js's wrapper, so
  // wasm_compiled marks this compile (the instantiate of the compiled module is not counted), and the desktop or deferred tier's
  // prefetch (held above until wasm_compiled) follows it, still after the module's download. The page's GPU device
  // (wasm-prewarm.js) is untouched: it is handed over in Module.preinitializedWebGPUDevice when the script has loaded
  const earlyGame = pageMeta('ue-game');
  const earlyName = new RegExp('^' + (earlyGame && !earlyGame.startsWith('%') ? earlyGame : project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-Wasm-[A-Za-z]+)?\\.wasm$');
  const earlyListed = files.find((f) => f.url.startsWith(project + '/Binaries/Wasm/') && earlyName.test(f.url.split('/').pop()));
  // A page the data cache controls first takes the browser's HTTP cache copy of the module when there is one (sw.js puts it
  // there once; only-if-cached: no request to the host and no revalidation, the URL carries the file's sha1) and compiles that
  // response untouched: the browser keeps the code it compiled beside an HTTP cache entry and loads it on the next visit, which
  // a response the data cache builds from its stored pieces does not get (that cache entry is cleared and rewritten on every
  // visit). Without an HTTP cache copy it reads the data cache's copy, as before
  // The HTTP cache is asked only when the worker has put this module (this sha1) there and seen the browser keep it (sw.js
  // fillHttpCache writes its record, __ue/http-copy, in the data cache): Chrome logs every only-if-cached miss as a red
  // "net::ERR_CACHE_MISS", caught or not, so asking on every load put one console error on each cold visit (UE-410985), and on
  // every visit for a module over the HTTP cache's per-entry limit (UE-410984)
  let earlyFrom = 'data cache';
  const earlyHeld = () => (swScope && typeof caches !== 'undefined'
    ? caches.match(new URL('__ue/http-copy', swScope).href).then((r) => (r ? r.json() : null))
      .then((record) => !!(record && record.held && record.held[earlyListed.sha1]), () => false)
    : Promise.resolve(false));
  const earlyResponse = () => {
    if (!cached || !earlyListed.sha1) return fetch(earlyListed.url, { credentials: 'same-origin' });
    return earlyHeld().then((held) => (!held ? fetch(earlyListed.url, { credentials: 'same-origin' })
      : fetch(earlyListed.url + '?v=' + earlyListed.sha1, { cache: 'only-if-cached', mode: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); earlyFrom = "browser's HTTP cache"; return r; })
        .catch(() => fetch(earlyListed.url, { credentials: 'same-origin' }))));
  };
  const earlyModule = earlyListed && query.get('wasmearly') !== '0' && WebAssembly.compileStreaming && (cached || !splitFiles.length)
    ? WebAssembly.compileStreaming(earlyResponse()).catch((e) => {
      console.log('PAGE WASM_EARLY compile failed, compiling from bytes: ' + e);
      return fetch(earlyListed.url, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()).then((bytes) => WebAssembly.compile(bytes));
    })
    : null;
  if (earlyModule) {
    console.log('LOADTIME wasm_early ' + Math.round(performance.now()) + ' ' + earlyListed.url);
    earlyModule.then(() => {
      console.log('PAGE WASM_EARLY compiled from the ' + earlyFrom);
      // The module exists now (the engine's instance and the pthread Workers use it; the browser keeps its own copy of the
      // bytes in it): the data cache detaches the downloaded chunks it handed this compile (sw.js moduleCompiled) instead of
      // waiting for its 15 s fallback. Nothing on this page keeps the response or its bytes
      const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (cached && controller) controller.postMessage({ type: 'module-compiled', url: new URL(earlyListed.url, swScope || location.href).href });
    }, () => {});
  }
  if (!cached && splitFiles.length) {
    fail('This site splits large game files into parts, which only the page\'s data cache (service worker) can join, and it is not running'
      + (query.get('sw') === '0' ? ' (?sw=0 turned it off)' : '') + '. Reload the page; if this repeats, the site needs to send the files whole. First: ' + splitFiles[0].url);
    return;
  }
  // Progress: sw.js reports each whole-file load; the total is the game's binaries and containers, counted as they travel: a
  // file's Brotli size ("br" in wasm-cache.json, 0 for one served as it is), so the page counts wire bytes, not unpacked
  // bytes. sw.js reports unpacked bytes, scaled here by each file's ratio. The later pak chunks' containers (sw.js isLate) load
  // after the game is ready, in the background, so the step and the bar count the start-up bytes only. The same files as sw.js
  // isLate, pakchunk99's .pak too (61 MB on Lyra): counted here, the total was reached only after ready on every cold visit
  const late = (url) => /\/pakchunk(?:[1-9][0-9]*[^/]*|[0-9]+optional[^/]*)\.ucas$/i.test(url) || /\/pakchunk99-[^/]*\.pak$/i.test(url);
  window.ueStageFiles = files.filter((f) => /\/Binaries\/Wasm\//.test(f.url)).map((f) => ({ url: f.url, sha1: f.sha1 }));   // for error reports
  const needed = files.filter(f => (/\/Binaries\/Wasm\/[^/]+\.(js|wasm)$/.test(f.url) || /\/Content\/Paks\//.test(f.url)) && !late(f.url));
  const wire = f => f.br || f.size;
  const total = needed.reduce((sum, f) => sum + wire(f), 0);
  const byUrl = new Map(needed.map(f => [new URL(f.url, location.href).href, f]));
  const loaded = new Map();
  let downloaded = false;
  ueSteps.set('download', 'active', total ? megabytes(total) + ' MB' : '');
  // The start-up download as counted here, for the pipeline hold (wasm-play.js pipelineHold): wire bytes in of the total, the
  // bytes that came over the network (not from this browser's cache) and when the last count arrived; none without the worker
  const boot = window.ueBootDownload = cached && total ? { total, bytes: 0, netBytes: 0, since: timings.sw || 0, at: 0 } : null;
  if (cached) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'log') { console.log(data.text); return; }
      // The worker could not keep the files (storage full) or was turned off by the host
      if (data.type === 'storage-low') { notice(T('This browser has no room to keep the game, so it downloads again on the next visit.')); return; }
      if (data.type === 'sw-off') { console.log('PAGE SW_OFF: the data cache is off for this site; this load runs uncached'); return; }
      if (data.type !== 'progress') return;
      const f = byUrl.get(data.url);
      if (!f) return;
      const before = loaded.get(data.url) || 0;
      loaded.set(data.url, f.size ? Math.min(data.loaded, f.size) * wire(f) / f.size : 0);
      const sum = [...loaded.values()].reduce((a, b) => a + b, 0);
      if (boot) { boot.bytes = sum; if (!data.cached) boot.netBytes += Math.max(0, loaded.get(data.url) - before); boot.at = performance.now(); }
      if (!total || downloaded) return;
      downloaded = sum >= 0.999 * total;
      progress(`Downloading ${megabytes(sum)} of ${megabytes(total)} MB` + (data.cached ? ' (from this browser)' : ''), 0.05 + 0.7 * sum / total, downloaded ? 'downloaded' : 'download');
      ueSteps.set('download', downloaded ? 'done' : 'active', `${megabytes(sum)} of ${megabytes(total)} MB` + (data.cached ? ', from this browser' : ''));
    });
  }
  progress(cached ? 'Downloading...' : 'Downloading the game...', 0.02, cached && total ? 'download' : undefined);
  // Frames capped at the display's rate, measured by index.html with requestAnimationFrame (t.MaxFPS; a non-Shipping -ini
  // override, so Shipping needs the RHI's own present pacing)
  if (window.ueDisplayHzReady) await Promise.race([window.ueDisplayHzReady, new Promise((r) => setTimeout(r, 1000))]);
  if (window.ueDisplayHz) defaults.push('-ini:Engine:[ConsoleVariables]:t.MaxFPS=' + window.ueDisplayHz);
  // A device profile's frame cap (wasm-profile.js fps=N, the lower of it and the display's rate) becomes a ceiling on the game's
  // frame rate: the page bridge holds t.MaxFPS at or below it (WasmPageBridge.cpp ApplyWebStartSettings), so the game's own
  // settings updates cannot lift it, where a t.MaxFPS value alone was undone during start-up. Shipping too
  if (profile && profile.fps) defaults.push('-WebFrameRateLimit=' + Math.min(profile.fps, window.ueDisplayHz || profile.fps));
  // The stage's UECommandLine.txt (UAT writes it: the map and the project's arguments), as a native game reads it. The query's
  // arguments go first: UE takes a map only from the first token and reads a flag's first occurrence, so ?args=/Game/Maps/X
  // opens that map and a query flag overrides a staged one or a default. -project= is left out for a game built for its
  // project; a Blueprint-only project runs the engine's UnrealGame, which has no project of its own and reads it from
  // -project= (the staged ../../../<Project>/<Project>.uproject, a path in the page's file system)
  const staged = await fetch('UECommandLine.txt', { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  const engineGame = pageMeta('ue-game') === 'UnrealGame';
  const stagedArgs = splitArgs(staged).filter((a) => engineGame || !/^-project=/i.test(a));
  const queryArgs = linkArgs(splitArgs(query.get('args') || ''));
  const isMap = (a) => a && !a.startsWith('-');
  const map = isMap(queryArgs[0]) ? queryArgs.shift() : isMap(stagedArgs[0]) ? stagedArgs.shift() : null;
  if (isMap(stagedArgs[0])) stagedArgs.shift();
  if (staged) console.log('LOADTIME staged_cmdline ' + Math.round(performance.now()) + ' ' + staged.trim());
  // window.ueExtraArgs: arguments a page script adds before the game starts (an intro shell, a bench)
  // The browser's language for the engine (navigator.language is not readable from the engine's pthreads), unless
  // the link or the stage names a culture. As a default the engine applies only when the player has no saved
  // culture (WasmPage: -WebBrowserLang); -culture= would override the player's choice on every visit
  if (![...queryArgs, ...stagedArgs, ...defaults].some((a) => /^-culture=/i.test(a)) && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(navigator.language || '')) defaults.push('-WebBrowserLang=' + navigator.language);
  // An intro shell sets window.ueExtraArgs; wait for its script (at most 3 s) so a cached load does not
  // build the command line before it ran
  if (window.ueShellReady) await Promise.race([window.ueShellReady, new Promise((r) => setTimeout(r, 3000))]);
  const args = (map ? [map] : []).concat(queryArgs, stagedArgs, window.ueExtraArgs || [], defaults, profileIni,
    // -ForceRes: the display metrics report r.SetRes' 1280x720, so without it the engine picked a smaller window (888x500);
    // the canvas is already at most ue-max-dpr device pixels per CSS pixel
    ['-resx=' + canvas.width, '-resy=' + canvas.height, '-windowed', '-ForceRes'],
    // the harness's own arguments (wasm-harness.js: the page's time origin for the engine's boot markers)
    (window.__harness && window.__harness.ueArgs) || []);
  window.Module = {
    arguments: args,
    // the module compiled since the page started it (above); Emscripten passes the imports and takes the instance
    ...(earlyModule ? { instantiateWasm: (imports, done) => {
      earlyModule.then((module) => WebAssembly.instantiate(module, imports).then((instance) => done(instance, module)))
        .catch((e) => { console.log('HARNESS ABORT wasm instantiate: ' + e); fail('The game could not start: ' + e); });
      return {};
    } } : {}),
    canvas: canvas,
    wasmManifest: manifest.map(e => ({ path: e.path, url: e.url, size: e.size, late: e.late })),   // late: the small-chunk fetch backend
    locateFile: (file) => project + '/Binaries/Wasm/' + file,
    print: t => {
      mark('first_print');
      rememberLine(t);   // the last engine lines for an error report
      if (!logPrinting) logPrinting = true;   // this build's log reaches the page, so the cover waits for the ready line
      const failure = classifyLine(t);
      if (failure) failKind(failure, t);
      // The ready line (wasm-play.js): 'UE_RUN READY' from the engine's page bridge; the older names for one release
      if (t.includes('UE_RUN HOLD') || t.includes('UE_RUN SETTLED')) pipelineHold.line(t);   // the pipeline hold (wasm-play.js)
      // the game's own ready signal (wasm-play.js readySignal, <meta name="ue-ready" content="game">)
      if (t.includes('UE_RUN GAME_READY_EXPECTED')) readySignal.expect();
      else if (t.includes('UE_RUN GAME_READY')) readySignal.signal();
      if (t.includes('UE_RUN READY') || t.includes('LOADING_READY'))
      {
        mark('ready_line');
        markPrimed();
        gameReady();
        // the game is up: the later pak chunks' containers load now (sw.js 'prefetch-late')
        postLate();
      }
      console.log(t);
    },
    printErr: t => { rememberLine(t); const failure = classifyLine(t); if (failure) failKind(failure, t); console.error(t); },
    onAbort: m => { console.log('HARNESS ABORT ' + m); fail(String(m || 'aborted')); },
    // Emscripten's exit (the engine called exit after RequestExit) ends the game like 'ue-exit'
    onExit: code => gameEnded(Number(code) || 0),
    setStatus: t => { status.textContent = t; },
    // The files are in and the runtime is up; the engine now starts and loads the startup level under the cover (siteStarted,
    // wasm-play.js). No page fallback for the late chunks here: sw.js releases them 20 s after the boot containers
    onRuntimeInitialized: () => {
      mark('runtime');
      if (!cached) ueSteps.set('download', 'done', total ? megabytes(total) + ' MB' : '');   // no worker, no byte counts
      ueSteps.set('engine', 'done', ueSteps.took('engine'));
      progress('Loading the level...', 0.8);
      siteStarted(/firefox/i.test(navigator.userAgent) ? 12 : 4);
    },
  };
  window.addEventListener('error', (event) => { if (event.message && /Aborted|RuntimeError/.test(event.message)) fail(event.message); });
  const gpu = await gpuProbe;
  if (gpu.message) {
    fail(gpu.message, window.ueBench ? undefined : (gpu.kind || 'gpu'));   // (a bench page's own message is no GPU stop)

    return;
  }
  for (const warning of window.ueCompat && window.ueCompat.warnings ? window.ueCompat.warnings(gpu.adapter) : []) console.log('WEB_COMPAT warning: ' + warning);
  const script = document.createElement('script');
  // The game's script: <Game>.js (Development) or <Game>-Wasm-<Config>.js, as wasm-cache.json lists it
  // (by name, not the first .js there, which could be a worklet or worker script). <Game> is the game
  // target's name (ue-game, e.g. LyraGame for project Lyra); a page staged without it uses the project's name
  const gameMeta = pageMeta('ue-game');
  const game = gameMeta && !gameMeta.startsWith('%') ? gameMeta : project;
  const scriptName = new RegExp('^' + game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-Wasm-[A-Za-z]+)?\\.js$');
  const listed = files.find(f => f.url.startsWith(project + '/Binaries/Wasm/') && scriptName.test(f.url.split('/').pop()));
  const scriptUrl = listed ? listed.url : project + '/Binaries/Wasm/' + game + '.js';
  // Fetch the game script once and hand the same Blob URL to every pthread Worker (Module.mainScriptUrlOrBlob): the pool
  // otherwise refetches it per Worker (56 x 273 KB on one game). ?blob=0 loads it by URL
  script.src = scriptUrl;
  let scriptText = null;   // the game script, where the page read it (a device profile's memory checks the glue takes it)
  if (query.get('blob') !== '0') {
    try {
      const response = await fetch(scriptUrl);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = scriptText = await response.text();
      // A script linked without mainScriptUrlOrBlob in INCOMING_MODULE_JS_API does not read it, and its ASSERTIONS build aborts
      // when the property is set (ignoredModuleProp("mainScriptUrlOrBlob")): use the Blob only for a script that reads it
      const readsBlob = /Module\[["']mainScriptUrlOrBlob["']\]|Module\.mainScriptUrlOrBlob\b/.test(text)
        && !/ignoredModuleProp\(["']mainScriptUrlOrBlob["']\)/.test(text);
      if (readsBlob) {
        script.src = window.Module.mainScriptUrlOrBlob = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      }
    } catch (e) {
      console.log('game script Blob unavailable, loading by URL: ' + e);
    }
  }
  script.onload = async () => {
    mark('script');
    ueSteps.set('engine', 'active');
    coverTo('engine');
    progress('Starting the engine...', 0.76);
    // a throw in the GPU check (or a bench script) starts the game with the defaults instead of stopping silently
    let picked = [];
    try { picked = await startArgs; } catch (e) { console.log('WEB_COMPAT start arguments failed, using the defaults: ' + e); }
    window.Module.arguments.push(...picked);
    if (window.ueBench && window.ueBench.args) window.Module.arguments.push(...window.ueBench.args);   // a staged wasm-bench.js
    // The device wasm-prewarm.js made during the download, for the engine's WebGPU RHI to take (it checks the device has what
    // it would request itself); not ready within 2 s, the RHI requests its own
    if (window.uePrewarm) {
      const device = await window.uePrewarm.device(2000);
      if (device) window.Module.preinitializedWebGPUDevice = device;
    }
    // A device profile's fixed memory (wasm-profile.js), only for a game script the page read that takes it: a glue linked with
    // wasmMemory in INCOMING_MODULE_JS_API reads it (wasmMemory = Module["wasmMemory"]); one linked without it ignores it (with
    // ASSERTIONS it aborts), so any other glue gets none and makes its own memory, as before
    // (only wasm-profile.js's own profile has these members; a profile object a page script made has neither)
    if (profile && Array.isArray(profile.memoryPages) && profile.memoryPages.length && typeof profile.applyMemory === 'function') {
      const takes = scriptText !== null && /\bwasmMemory\s*=\s*Module\s*(?:\[\s*["']wasmMemory["']\s*\]|\.wasmMemory\b)/.test(scriptText);
      if (!takes) console.log('PAGE PROFILE memory not applied: ' + (scriptText === null ? 'the page did not read the game script (?blob=0)' : 'this build does not take a page memory'));
      else profile.applyMemory(window.Module, { lowered: pageMeta('ue-memory64') === 'lowered' });
    }
    if (profile && (profile.configured || profile.forced) && typeof profile.describe === 'function') {
      try { console.log(profile.describe()); } catch (e) { console.log('PAGE PROFILE ' + profile.name + ': its settings could not be printed: ' + e); }
    }
    try { createUEModule(window.Module).catch(e => fail(String(e))); } catch (e) { fail(String(e)); }
  };
  script.onerror = () => fail('The game script could not be loaded: ' + script.src);
  document.body.appendChild(script);
})();
