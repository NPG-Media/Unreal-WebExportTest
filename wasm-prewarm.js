// The page's WebGPU device and shader prewarm, made while the game downloads (wasm-loader.js hands the device to the engine).
//
// Chrome creates a WebGPU device, and later every shader module and pipeline, in its GPU process, which is idle while the
// game's files download. This script asks for the adapter and the device as soon as the compatibility check (wasm-compat.js)
// has picked the renderer tier, so the check's timed test draws never share the GPU with this work. It asks for the features
// and limits the engine's WebGPU RHI asks for on that tier (WebGPURHI, WebGPUDevice.cpp, FWebGPUDynamicRHI::Init: keep the two
// lists in step). The loader puts the device in Module.preinitializedWebGPUDevice before the engine starts. The RHI takes it
// when it has every feature and limit the RHI wants and otherwise requests its own device; either way it sends a
// 'ue-webgpu-device' event ({page: true|false, why}), and this script releases a device the engine did not take.
//
// The prewarm pack: one per shader format, so per tier (forward SF_WEBGPU_ES3_1, deferred SF_WEBGPU_ES3_1_DEFERRED, desktop
// SF_WEBGPU_SM5). When the stage has the tier's pack (<Project>/Content/WebGPUPrewarm-<shader format>.json, made by
// Build/Tools/web/prewarm_pack.py from captures and staged by UAT from the project's Build/Wasm/PipelinePrewarm folder), the
// page creates the pack's shader modules (a slice per frame: Chrome parses each on the thread that also presents the page),
// layouts and pipelines (asynchronously, those the RHI cannot wait for first, at most the pack's in-flight count until the
// engine takes the device, then the rest) on that device. The engine's identical creation calls get the objects already made;
// any other call goes to the browser unchanged. Objects are matched by their whole descriptor (shader text included), so a
// pack only ever saves work; a pack whose stamp (the game's code and the shader format) differs from the stage's is not used.
// A recook keeps its pack: the few shaders a recook changes simply miss.
//
// WebKit (every iOS browser, and Safari on the Mac) gets two more things, both page-side only (the fresh-module block below, and
// the compile farm in the replay): every pipeline takes a shader module of its own, so each one hits Metal's persistent shader
// cache on the next visit, and the pack's pipelines compile on worker devices first, in parallel.
//
// Query: ?prewarm=0 off; ?prewarm=device the device without the pack; ?prewarm=capture records the engine's creation calls on
// the device and writes OPFS logs/webgpu-capture.json ?prewarm_capture_s= seconds after the game is ready (default 8), for
// prewarm_pack.py. Firefox keeps it off until it has its own measurements (?prewarm=1 turns it on there).
// ?freshmodules=0|1 turns the fresh-module block off, or on in any browser; ?farm=0 turns the compile farm off, ?farm=N (1 to 8)
// sets its worker count and turns it on in any browser; ?farm_job_ms= how long a worker may take for one pipeline.
// A classic script that index.html loads before wasm-loader.js. It logs PREWARM and FRESHMODULES lines.

// ---- fresh shader modules on WebKit ----
// Shipping Safari (27.0.x) writes slightly different Metal code for each pipeline made from a shader module an earlier pipeline
// already used (one more bounds clamp per reuse; WebKit fixed it in 321998@main, after 27.0.1), so each such pipeline misses
// Metal's persistent shader cache and compiles again on every visit, about 0.2 s each on an iPhone (a return visit took 58.7 s
// with reused modules and about 2 s with a module per pipeline). The engine keeps one module per shader (WebGPUBindGroups.cpp
// ModuleFor) and shares one null fragment module across its depth-only pipelines, and the prewarm's replay makes the same reuses.
// Here a pipeline stage whose module an earlier pipeline used gets a fresh module made from the same descriptor (1 to 2 ms on a
// phone); the first pipeline keeps the original, and the caller's descriptor is left unchanged, so the prewarm's keys, its
// capture and its hits are the same. It wraps GPUDevice.prototype before the prewarm below reads it, so the replay's pipelines,
// the compile farm's and the engine's all go through it. It keeps a copy of each module's descriptor while the module lives (the
// shader text). On by default on WebKit; ?freshmodules=1 forces it on elsewhere, ?freshmodules=0 turns it off. Turn the default
// off once a shipping Safari has 321998@main. window.ueFreshModules counts pipelines and fresh modules.
(() => {
  'use strict';
  if (typeof GPUDevice === 'undefined') return;
  const asked = new URLSearchParams(location.search).get('freshmodules');
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const webkit = ios || (/AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua));
  if (asked === '0' || (asked !== '1' && !webkit)) return;
  const proto = GPUDevice.prototype;
  const createModule = proto.createShaderModule;
  if (typeof createModule !== 'function') return;
  const sources = new WeakMap();   // module -> a copy of the descriptor it was made from
  const used = new WeakSet();      // modules a pipeline has taken
  const counts = { pipelines: 0, fresh: 0, unknown: 0 };
  proto.createShaderModule = function (desc) {
    const module = createModule.call(this, desc);
    if (module && desc && typeof desc.code === 'string') sources.set(module, Object.assign({}, desc));
    return module;
  };
  // The stage itself when its module is new to pipelines, else a copy of the stage with a fresh module
  const stageFor = (device, stage) => {
    if (!stage || typeof stage !== 'object' || !stage.module) return stage;
    if (!used.has(stage.module)) { used.add(stage.module); return stage; }
    const desc = sources.get(stage.module);
    if (!desc) { counts.unknown++; return stage; }
    const fresh = createModule.call(device, desc);
    sources.set(fresh, desc);
    used.add(fresh);
    counts.fresh++;
    return Object.assign({}, stage, { module: fresh });
  };
  const wrap = (name, stages) => {
    const fn = proto[name];
    if (typeof fn !== 'function') return;
    proto[name] = function (desc) {
      if (!desc || typeof desc !== 'object') return fn.call(this, desc);
      counts.pipelines++;
      let out = desc;
      for (const key of stages) {
        const stage = stageFor(this, desc[key]);
        if (stage !== desc[key]) { if (out === desc) out = Object.assign({}, desc); out[key] = stage; }
      }
      return fn.call(this, out);
    };
  };
  wrap('createRenderPipeline', ['vertex', 'fragment']);
  wrap('createRenderPipelineAsync', ['vertex', 'fragment']);
  wrap('createComputePipeline', ['compute']);
  wrap('createComputePipelineAsync', ['compute']);
  window.ueFreshModules = counts;
  console.log('FRESHMODULES on ' + JSON.stringify({ webkit, asked: asked || '' }));
})();

(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const asked = query.get('prewarm') || '';
  const firefox = /firefox/i.test(navigator.userAgent);
  const now = () => Math.round(performance.now());
  const say = (what, data) => console.log('PREWARM ' + what + (data === undefined ? '' : ' ' + JSON.stringify(data)));
  const off = (why) => {
    say('off', { why });
    window.uePrewarm = { mode: 'off', start: () => {}, device: () => Promise.resolve(null) };
  };
  if (asked === '0' || asked === 'off') return off('asked');
  if (firefox && !asked) return off('firefox');
  if (!navigator.gpu || typeof GPUAdapter === 'undefined' || typeof GPUDevice === 'undefined') return off('no WebGPU');
  const mode = asked === 'capture' ? 'capture' : asked === 'device' ? 'device' : 'replay';

  // The optional features the RHI asks for when the adapter has them: on every tier, then those only the desktop tier asks for
  // (the deferred tier is an ES3_1 feature level: it asks for the forward tier's)
  // (WebGPUDevice.cpp: a device that lacks one the adapter has is declined and the RHI requests its own). ASTC is asked for on
  // every adapter that has it: the RHI asks for it where the adapter has no BC or the start arguments carry -WebGPUASTC, which
  // the loader adds for a stage's ASTC texture set after this device is made; a device with more features than the RHI asks
  // for is still taken
  const FEATURES = ['float32-filterable', 'float32-blendable', 'texture-formats-tier1', 'unorm16-texture-formats',
    'texture-compression-bc', 'texture-compression-bc-sliced-3d', 'texture-compression-astc', 'depth32float-stencil8',
    'rg11b10ufloat-renderable', 'depth-clip-control', 'indirect-first-instance', 'primitive-index', 'bgra8unorm-storage',
    'timestamp-query'];
  const DESKTOP_FEATURES = ['subgroups', 'clip-distances', 'texture-formats-tier2', 'dual-source-blending'];
  // The limits the RHI raises to the adapter's values: on every tier, then the desktop tier's
  const LIMITS = ['maxSampledTexturesPerShaderStage', 'maxStorageBuffersPerShaderStage', 'maxColorAttachments', 'maxBufferSize',
    'maxStorageBufferBindingSize', 'maxTextureDimension2D', 'maxTextureDimension1D', 'maxTextureArrayLayers',
    'maxUniformBuffersPerShaderStage', 'maxSamplersPerShaderStage', 'maxVertexAttributes', 'maxInterStageShaderVariables',
    'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
    'maxComputeWorkgroupSizeZ', 'maxBindingsPerBindGroup', 'maxColorAttachmentBytesPerSample'];
  const DESKTOP_LIMITS = ['maxStorageTexturesPerShaderStage'];
  // At least this many dynamic uniform buffers per pipeline layout (the RHI asks for max(adapter, 8))
  const MIN_DYNAMIC_UNIFORM_BUFFERS = 8;
  // The page's tier ids (wasm-compat.js pickTier): forward (once mobile), deferred, desktop
  const FORMAT = { desktop: 'SF_WEBGPU_SM5', forward: 'SF_WEBGPU_ES3_1', deferred: 'SF_WEBGPU_ES3_1_DEFERRED' };
  const PLATFORM = { desktop: 'SP_WEBGPU_SM5', forward: 'SP_WEBGPU_ES3_1', deferred: 'SP_WEBGPU_ES3_1_DEFERRED' };

  const marks = { script: now() };
  let device = null;
  let handed = false;           // the loader gave the device to the engine's script
  let taken = false;            // the engine's RHI took it: the in-flight cap goes
  let released = false;
  let dropped = false;          // the maps are cleared: every call goes to the browser
  let kickTaken = null;
  const takenKick = new Promise((resolve) => { kickTaken = resolve; });

  // The tier from the start arguments the compat check picked, or from the link's own ?args= (wasm-compat.js tierArgs: a deferred
  // start passes -WebGPUMobileDeferred -WebGPUNoSM5, a forward one -WebGPUNoMobileDeferred -WebGPUNoSM5, so -WebGPUNoSM5 alone
  // leaves the deferred tier open and says nothing); unknown asks for every tier's features and limits (the RHI takes a device
  // with more than it wants) and uses no pack
  const tierOf = (args) => {
    const all = (args || []).concat((query.get('args') || '').split(' '));
    return all.includes('-WebGPUSM5') ? 'desktop' : all.includes('-WebGPUMobileDeferred') ? 'deferred'
      : all.includes('-WebGPUNoMobileDeferred') ? 'forward' : 'both';
  };

  // ---- the pack: its listing entry and its stamp ----
  // The listing (sw.js's list, which the loader reads too) names the staged packs and gives every file's sha1
  const listing = fetch('wasm-cache.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : []), () => []).catch(() => [])
    .then((l) => (Array.isArray(l) ? l : []));
  const packEntry = (entries, tier) => entries.find((e) => e && typeof e.url === 'string' && e.url.endsWith('/Content/WebGPUPrewarm-' + FORMAT[tier] + '.json'));
  // The stamp prewarm_pack.py writes: sha1 over sorted lines. With the game binary's code hash in the listing ("code": the
  // binary's sections other than its data, which holds the build time, so two builds of one source agree), the lines are the
  // shader format and that hash: the code decides every descriptor the page reproduces, and descriptor matching absorbs the
  // shaders a recook changes. A listing without it (an older stage) falls back to the files' sha1: the game binaries and the
  // tier's shader libraries and global shader map, plus the containers' tables of contents for a tier whose libraries are
  // inside the containers
  const isShaderFile = (url, tier) => (/\/ShaderArchive-[^/]+\.ushaderbytecode$/.test(url) && url.includes('-' + FORMAT[tier] + '-'))
    || url.endsWith('GlobalShaderCache-' + PLATFORM[tier] + '.bin');
  const stampFiles = (entries, tier) => {
    const binaries = entries.filter((e) => e && typeof e.url === 'string' && /\/Binaries\/Wasm\/[^/]+\.wasm$/.test(e.url));
    if (binaries.length && binaries.every((e) => typeof e.code === 'string' && e.code)) {
      return ['format ' + FORMAT[tier]].concat(binaries.map((e) => 'code ' + e.code)).sort();
    }
    const listed = entries.filter((e) => e && typeof e.url === 'string' && e.sha1);
    const looseLibraries = listed.some((e) => /\/ShaderArchive-[^/]+\.ushaderbytecode$/.test(e.url) && e.url.includes('-' + FORMAT[tier] + '-'));
    return listed.filter((e) => /\/Binaries\/Wasm\/[^/]+\.wasm$/.test(e.url) || isShaderFile(e.url, tier)
      || (!looseLibraries && /\/Content\/Paks\/[^/]+\.utoc$/.test(e.url)))
      .map((e) => e.url + ' ' + e.sha1).sort();
  };
  async function stampOf(entries, tier) {
    const text = stampFiles(entries, tier).join('\n');
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const packFetches = new Map();
  const fetchPack = (tier, entries) => {
    if (!packFetches.has(tier)) {
      const entry = packEntry(entries, tier);
      packFetches.set(tier, entry ? { url: entry.url, response: fetch(entry.url).catch(() => null) } : { url: '', response: Promise.resolve(null) });
    }
    return packFetches.get(tier);
  };
  // Fetching does not disturb the compat check's timed draws (only creating would): a stage with one pack, or a link that
  // names the tier, starts its pack's fetch at once
  if (mode === 'replay') {
    listing.then((entries) => {
      const tiers = ['desktop', 'deferred', 'forward'].filter((t) => packEntry(entries, t));
      const asked = query.get('tier') === 'mobile' ? 'forward' : query.get('tier');
      const linked = tierOf([]);
      const named = FORMAT[asked] ? asked : linked !== 'both' ? linked : '';
      const early = tiers.length === 1 ? tiers[0] : (named && tiers.includes(named) ? named : '');
      if (early) { marks.pack_early = early; fetchPack(early, entries); }
    });
  }

  // ---- canonical descriptors: GPU objects become {"$": id}, labels and undefined fields drop, keys sort ----
  const ids = new WeakMap();
  let unknown = 0;
  const isGpuObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.constructor && /^GPU/.test(v.constructor.name || '');
  function ser(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ids.has(v)) return { $: ids.get(v) };
    if (Array.isArray(v)) return v.map(ser);
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (isGpuObject(v)) { const id = 'u' + (++unknown); ids.set(v, id); return { $: id }; }
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'label' || v[k] === undefined || typeof v[k] === 'function') continue;
      out[k] = ser(v[k]);
    }
    return out;
  }
  const keyOf = (desc) => JSON.stringify(ser(desc || {}));
  // The creation calls: [method, kind, async]
  const KINDS = [['createShaderModule', 'module', false], ['createBindGroupLayout', 'bgl', false], ['createPipelineLayout', 'layout', false],
    ['createRenderPipeline', 'render', false], ['createRenderPipelineAsync', 'render', true], ['createComputePipeline', 'compute', false],
    ['createComputePipelineAsync', 'compute', true]];
  const PREFIX = { module: 'm', bgl: 'b', layout: 'l', render: 'r', compute: 'c' };
  const proto = GPUDevice.prototype;

  // ---- the device ----
  const ADAPTER_OPTIONS = { powerPreference: 'high-performance' };
  let deviceAsk = null;         // what the device was asked for ({ features, limits }): the compile farm's workers ask the same
  async function createDevice(tier) {
    const adapter = await navigator.gpu.requestAdapter(ADAPTER_OPTIONS);
    if (!adapter) { say('no_adapter'); return null; }
    const desktop = tier === 'desktop' || tier === 'both';
    const requiredFeatures = FEATURES.concat(desktop ? DESKTOP_FEATURES : []).filter((f) => adapter.features.has(f));
    const requiredLimits = {};
    for (const k of LIMITS.concat(desktop ? DESKTOP_LIMITS : [])) {
      if (typeof adapter.limits[k] === 'number') requiredLimits[k] = adapter.limits[k];
    }
    const dynamic = adapter.limits.maxDynamicUniformBuffersPerPipelineLayout;
    if (typeof dynamic === 'number') requiredLimits.maxDynamicUniformBuffersPerPipelineLayout = Math.max(dynamic, MIN_DYNAMIC_UNIFORM_BUFFERS);
    const made = await adapter.requestDevice({ label: 'UnrealEngine', requiredFeatures, requiredLimits });
    deviceAsk = { features: requiredFeatures, limits: requiredLimits };
    marks.device = now();
    say('device', { tier, t: marks.device, after_pick_ms: marks.device - marks.pick, features: requiredFeatures.length });
    return made;
  }

  // ================================ capture ================================
  const capture = { calls: [], keys: new Map(), counts: {} };
  function captureOn(dev) {
    for (const [method, kind, isAsync] of KINDS) {
      const fn = proto[method];
      if (typeof fn !== 'function') continue;
      dev[method] = function (desc) {
        const t = now();
        const result = fn.call(this, desc);
        const key = keyOf(desc);
        const seen = capture.keys.get(kind + key);
        const id = seen || PREFIX[kind] + capture.keys.size;
        if (!seen) capture.keys.set(kind + key, id);
        capture.counts[kind] = (capture.counts[kind] || 0) + 1;
        const call = { t, kind, id, async: isAsync };
        if (seen) call.dup = true; else call.desc = JSON.parse(key);
        if (desc && desc.label) call.label = String(desc.label);
        capture.calls.push(call);
        const keep = (obj) => { if (obj && typeof obj === 'object' && !ids.has(obj)) ids.set(obj, id); return obj; };
        if (isAsync) return result.then((obj) => { call.done = now(); return keep(obj); }, (e) => { call.error = String(e && e.message || e); throw e; });
        return keep(result);
      };
    }
    let written = false;
    async function write(why) {
      if (written) return;
      written = true;
      const out = { version: 1, why, href: location.href, ua: navigator.userAgent, at: new Date().toISOString(), marks,
        tier: marks.tier, format: FORMAT[marks.tier] || '', stamp: marks.stamp || '', canvas_format: navigator.gpu.getPreferredCanvasFormat(),
        counts: capture.counts, calls: capture.calls };
      const text = JSON.stringify(out);
      say('capture', { why, calls: out.calls.length, counts: out.counts, bytes: text.length, engine_took_device: !!marks.engine_page });
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('logs', { create: true });
        const file = await dir.getFileHandle('webgpu-capture.json', { create: true });
        const w = await file.createWritable();
        await w.write(text);
        await w.close();
        say('capture_written', { path: 'logs/webgpu-capture.json' });
      } catch (e) {
        say('capture_write_failed', { error: String(e && e.message || e) });
      }
    }
    const delay = Math.max(1, Number(query.get('prewarm_capture_s')) || 8) * 1000;
    window.addEventListener('ue-ready', () => { marks.ready = now(); setTimeout(() => write('ready'), delay); }, { once: true });
    setTimeout(() => write('timeout 120 s'), 120000);
  }

  // ================================ replay ================================
  const stats = { module: [0, 0, 0], bgl: [0, 0, 0], layout: [0, 0, 0], render: [0, 0, 0], compute: [0, 0, 0] };   // hits, misses, late
  const misses = [];
  const kept = { module: new Map(), bgl: new Map(), layout: new Map(), render: new Map(), compute: new Map() };
  const byId = new Map();
  const failures = [];
  const progress = { modules: 0, module_kb: 0, layouts: 0, pipelines: 0, pipelines_ready: 0, pipeline_errors: 0, twins: 0 };
  const resolveRef = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(resolveRef);
    if (typeof v.$ === 'string' && Object.keys(v).length === 1) {
      const o = byId.get(v.$);
      if (!o) throw new Error('unknown ref ' + v.$);
      return o;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = resolveRef(v[k]);
    return out;
  };
  // The next animation frame, or 16 ms in a hidden tab (whose frames stop)
  const nextFrame = () => new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });

  function make(dev, kind, entry) {
    dev.pushErrorScope('validation');
    let obj = null;
    try { obj = proto[KINDS.find((k) => k[1] === kind)[0]].call(dev, resolveRef(entry.desc)); } catch (e) { failures.push({ id: entry.id, error: String(e && e.message || e) }); }
    dev.popErrorScope().then((err) => { if (err) failures.push({ id: entry.id, error: err.message }); }, () => {});
    if (!obj) return null;
    ids.set(obj, entry.id);
    byId.set(entry.id, obj);
    kept[kind].set(JSON.stringify(entry.desc), { obj, ready: true });
    return obj;
  }

  // A pipeline recorded against the capture's canvas format also gets a twin for this browser's canvas format when the two
  // differ (bgra8unorm on Windows and macOS, rgba8unorm on Linux and Android), since the back buffer takes the canvas format
  function twinOf(desc, from, to) {
    const targets = desc && desc.fragment && desc.fragment.targets;
    if (!from || !to || from === to || !Array.isArray(targets) || !targets.some((t) => t && t.format === from)) return null;
    const twin = JSON.parse(JSON.stringify(desc));
    for (const t of twin.fragment.targets) { if (t && t.format === from) t.format = to; }
    return twin;
  }

  // A pipeline the RHI cannot wait for while it compiles (prewarm_pack.py urgent: keep the two in step): compute (a dispatch is
  // never skipped), or render that writes depth or stencil (made synchronously at its draw)
  function urgent(p) {
    if (p.kind === 'compute') return true;
    const ds = (p.desc && p.desc.depthStencil) || {};
    if (ds.depthWriteEnabled) return true;
    const writeMask = ds.stencilWriteMask === undefined ? 0xFFFFFFFF : ds.stencilWriteMask;
    return writeMask !== 0 && ['stencilFront', 'stencilBack'].some((face) => {
      const ops = ds[face] || {};
      return ['failOp', 'depthFailOp', 'passOp'].some((k) => (ops[k] || 'keep') !== 'keep');
    });
  }

  // Return visits: once a load with this pack reached ready, the browser's caches hold most of its work. Each shader module
  // then comes from the cache unparsed, so a pipeline the cache misses parses its WGSL again inside its compile, and many such
  // compiles at once cost the browser's GPU process about twice the CPU each; a return visit keeps the in-flight cap after the
  // engine takes the device instead of releasing everything at once. ?prewarm_return=full|urgent|none picks what it replays
  const visitKey = (pack) => 'ue-prewarm:' + pack.format + ':' + pack.stamp;
  function visitOf(pack) {
    const asked = query.get('prewarm_return');
    let seen = false;
    try { seen = !!localStorage.getItem(visitKey(pack)); } catch (e) { seen = false; }
    return { seen, replay: ['full', 'urgent', 'none'].includes(asked) ? asked : 'full' };
  }

  // ---- the compile farm (WebKit): the pack's pipelines compile on worker devices first ----
  // Shipping Safari (27.0.x to 27.2) compiles each pipeline synchronously on the GPU-process thread of the navigator.gpu that
  // made its device (one RemoteGPU per navigator.gpu, each with its own work queue), so every pipeline the replay and the engine
  // make on the page's device compiles after the one before, and the device's queue waits meanwhile (0.3 to 0.6 s per pipeline
  // on an iPhone). A dedicated worker has a navigator.gpu of its own, and Metal's shader cache serves the whole GPU process. So
  // on WebKit 4 workers each get a device like the page's (the same adapter options, features and limits) and the pack's
  // layouts; the replay deals them the pack's pipelines in its order, 2 in flight each, and once a worker has made one the
  // replay makes it on the page's device: a Metal cache hit (about 1.5 ms), which the engine then finds ready as before. The
  // engine's asynchronous create of a pipeline not dealt yet moves it to the front. Measured on an iPhone (Safari 27.0.1, cold):
  // 24 pipelines 8.3 s on one device against 3.8 s on 4 workers, 96 pipelines 33.6 s against 15.1 s (2.2x); 3 workers 1.8x, 5
  // or 6 no faster than 4, and the page device's queue answered in 0.7 ms while the workers compiled (452 ms without them).
  // Each worker makes a fresh module for every pipeline stage, as the fresh-module block above does on the page's device, so
  // both write the same Metal and the second is a cache hit; each job brings its own shader source, so a worker's memory stays
  // flat. Nothing is worse than without the farm: a worker that fails or has no device in 5 s, a pipeline a worker cannot make
  // (or has not made in ?farm_job_ms=, 45 s), and everything once no worker is left go to the page's device as before. After
  // the maps drop the farm keeps compiling, until 60 s after the game is ready, without making anything on the page's device:
  // its compiles fill Metal's cache for the engine's own later creates. Chrome has no cache across devices, so there it would
  // compile everything twice: on by default on WebKit only; ?farm=N (1 to 8) sets the count and turns it on in any browser,
  // ?farm=0 turns it off. Turn the default off once a shipping Safari compiles in parallel on one device (WebKit 321042@main,
  // not in 27.2). window.uePrewarm.farm() has its counts; PREWARM farm_up, farm_off and farm lines log it.
  const farmUa = navigator.userAgent || '';
  const farmWebkit = /iPhone|iPad|iPod/.test(farmUa) || (/Macintosh/.test(farmUa) && navigator.maxTouchPoints > 1)
    || (/AppleWebKit\//.test(farmUa) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(farmUa));
  const farmAsked = query.get('farm');
  const farmCount = typeof Worker === 'undefined' ? 0
    : farmAsked !== null && farmAsked !== '' ? Math.max(0, Math.min(8, Math.floor(Number(farmAsked)) || 0)) : farmWebkit ? 4 : 0;
  const FARM_PER_WORKER = 2;   // in flight per worker: the next pipeline waits in the worker's queue, so no worker idles on a round trip
  const FARM_INIT_MS = 5000;   // a worker without a device and the layouts by then is left out
  const FARM_JOB_MS = Math.max(1000, Number(query.get('farm_job_ms')) || 45000);   // a pipeline a worker has not made by then
  const FARM_AFTER_READY_MS = 60000;   // the farm stops this long after the game is ready
  const farmStats = { asked: farmAsked === null ? '' : farmAsked, workers: farmCount, up: 0, failed: 0, lost: 0, dealt: 0, done: 0,
    errors: 0, timeouts: 0, fallback: 0, requeued: 0, bumped: 0, skipped: 0, worker_ms: 0, t_start: 0, t_up: 0, t_end: 0, why: [] };
  const farmLanes = [];      // workers with a device: { i, worker, alive, inflight: Map(job number -> job), timeouts }
  const farmQueue = [];      // jobs not dealt yet, in order
  const farmAskedQ = [];     // jobs the engine has asked for before a worker had them, in the engine's order: dealt first
  const farmBack = [];       // jobs the page's device makes itself
  const farmModules = new Map();   // module id -> its descriptor (the pack's)
  let farmDevice = null;
  let farmCap = 16;          // the pack's in-flight count: the page's own compiles before the engine takes the device
  let farmSeen = false;      // a return visit keeps that cap afterwards too (visitOf)
  let farmOpen = 0;          // jobs not settled
  let farmBackOpen = 0;
  let farmJobs = 0;
  let farmStopped = '';
  let farmDone = null;
  let farmWatchTimer = 0;
  let farmNone = false;      // no worker came up
  const farmWhy = (why) => { if (farmStats.why.length < 12) farmStats.why.push(String(why).slice(0, 240)); };
  const farmSummary = () => Object.assign({}, farmStats, { lanes: farmLanes.length, alive: farmLanes.filter((l) => l.alive).length,
    queued: farmQueue.length + farmAskedQ.length, open: farmOpen, stopped: farmStopped, why: farmStats.why.slice() });

  // The worker's whole script: it runs from a blob URL, so it uses nothing from outside this function
  function farmWorkerMain() {
    let device = null;
    const objects = new Map();   // bind group layout and pipeline layout id -> object
    // A pack descriptor with its {"$": id} references made real; every module reference gets a fresh module from the job's
    // own copy of its source (a job brings its modules and the worker keeps none)
    const real = (v, mods) => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map((x) => real(x, mods));
      if (typeof v.$ === 'string' && Object.keys(v).length === 1) {
        const desc = mods && mods.get(v.$);
        if (desc) return device.createShaderModule(desc);
        const o = objects.get(v.$);
        if (!o) throw new Error('unknown ref ' + v.$);
        return o;
      }
      const out = {};
      for (const k of Object.keys(v)) out[k] = real(v[k], mods);
      return out;
    };
    const text = (e) => String((e && e.message) || e);
    self.onmessage = async (event) => {
      const m = event.data || {};
      if (m.type === 'init') {
        const t0 = performance.now();
        try {
          if (!navigator.gpu) throw new Error('no navigator.gpu in a worker');
          const adapter = await navigator.gpu.requestAdapter(m.adapterOptions || {});
          if (!adapter) throw new Error('no adapter');
          const missing = (m.features || []).filter((f) => !adapter.features.has(f));
          if (missing.length) throw new Error('the adapter lacks ' + missing.join(', '));
          device = await adapter.requestDevice({ requiredFeatures: m.features || [], requiredLimits: m.limits || {} });
          device.lost.then((info) => self.postMessage({ type: 'lost', why: String((info && (info.message || info.reason)) || 'lost') }));
          // A layout that fails here fails on the page's device too, and the pipelines that use it then fail on both
          device.pushErrorScope('validation');
          for (const b of m.bgls || []) objects.set(b.id, device.createBindGroupLayout(real(b.desc)));
          for (const l of m.layouts || []) objects.set(l.id, device.createPipelineLayout(real(l.desc)));
          const error = await device.popErrorScope();
          self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0), warn: error ? 'layouts: ' + error.message : '' });
        } catch (e) {
          self.postMessage({ type: 'failed', error: text(e) });
        }
      } else if (m.type === 'job') {
        const t0 = performance.now();
        let made = null;
        let thrown = null;
        device.pushErrorScope('validation');
        try {
          const desc = real(m.desc, new Map(m.modules || []));
          made = m.kind === 'compute' ? device.createComputePipelineAsync(desc) : device.createRenderPipelineAsync(desc);
        } catch (e) { thrown = e; }
        const scope = device.popErrorScope();
        try {
          if (thrown) throw thrown;
          await made;
          const error = await scope;
          if (error) throw new Error(error.message);
          self.postMessage({ type: 'done', i: m.i, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          self.postMessage({ type: 'error', i: m.i, error: text(e) });
        }
      } else if (m.type === 'stop') {
        try { if (device) device.destroy(); } catch (e) { /* gone already */ }
        self.close();
      }
    };
  }

  // Starts the workers. Resolves true once the first has its device and the layouts, false when none does
  function farmStart(pack, ask) {
    let url = '';
    try { url = URL.createObjectURL(new Blob(['(' + farmWorkerMain.toString() + ')();'], { type: 'text/javascript' })); } catch (e) {
      farmWhy('blob: ' + (e && e.message || e));
      return Promise.resolve(false);
    }
    farmStats.t_start = now();
    for (const m of pack.modules || []) farmModules.set(m.id, m.desc);
    const init = { type: 'init', adapterOptions: ADAPTER_OPTIONS, features: ask.features, limits: ask.limits,
      bgls: pack.bgls || [], layouts: pack.layouts || [] };
    return new Promise((resolve) => {
      let starting = farmCount;
      const started = () => {
        if (--starting > 0) return;
        try { URL.revokeObjectURL(url); } catch (e) { /* kept */ }
        if (!farmLanes.some((l) => l.alive)) resolve(false);
      };
      for (let i = 0; i < farmCount; i++) {
        let worker;
        try { worker = new Worker(url); } catch (e) { farmStats.failed++; farmWhy('worker: ' + (e && e.message || e)); started(); continue; }
        const lane = { i, worker, alive: false, starting: true, inflight: new Map(), timeouts: 0 };
        let timer = 0;
        const fail = (why) => {
          lane.starting = false;
          clearTimeout(timer);
          farmStats.failed++;
          farmWhy('worker ' + i + ': ' + why);
          try { worker.terminate(); } catch (e) { /* gone */ }
          started();
        };
        // A main thread that was busy past the deadline may still have the worker's answer queued: a late check waits 0.5 s more
        // (at most 20 times) before it gives up on the worker
        let due = now() + FARM_INIT_MS;
        let grace = 20;
        const check = () => {
          if (!lane.starting) return;
          if (now() - due > 250 && grace-- > 0) { due = now() + 500; timer = setTimeout(check, 500); return; }
          fail('no device in ' + FARM_INIT_MS + ' ms');
        };
        timer = setTimeout(check, FARM_INIT_MS);
        worker.onmessage = (event) => {
          const m = event.data || {};
          if (lane.starting) {
            if (m.type === 'failed') { fail(m.error); return; }
            if (m.type !== 'ready') return;
            lane.starting = false;
            clearTimeout(timer);
            if (farmStopped) { try { worker.terminate(); } catch (e) { /* gone */ } started(); return; }
            lane.alive = true;
            farmLanes.push(lane);
            farmStats.up++;
            if (m.warn) farmWhy('worker ' + i + ' ' + m.warn);
            if (!farmStats.t_up) { farmStats.t_up = now(); say('farm_up', { workers: farmCount, t: farmStats.t_up, ms: m.ms }); }
            started();
            resolve(true);
            farmDeal();
            return;
          }
          if (lane.alive) farmMessage(lane, m);
        };
        worker.onerror = (event) => {
          const why = 'error ' + String((event && event.message) || 'in the worker');
          if (event && event.preventDefault) event.preventDefault();
          if (lane.starting) fail(why); else farmLaneDown(lane, 'worker ' + i + ' ' + why);
        };
        try { worker.postMessage(init); } catch (e) { fail('post: ' + (e && e.message || e)); }
      }
    });
  }

  // Every module a pack descriptor names
  const farmModuleIds = (v, out = []) => {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) { for (const x of v) farmModuleIds(x, out); } else if (typeof v.$ === 'string' && Object.keys(v).length === 1) {
        if (farmModules.has(v.$) && !out.includes(v.$)) out.push(v.$);
      } else { for (const k of Object.keys(v)) farmModuleIds(v[k], out); }
    }
    return out;
  };

  // The pack's pipelines through the farm: each gets its kept entry now (so the engine's asynchronous create of one still in a
  // worker waits for it, and moves it to the front if it is not dealt yet); resolves once every one has settled or the farm stopped
  function farmRun(dev, list, visit) {
    farmDevice = dev;
    farmSeen = visit.seen;
    return new Promise((resolve) => {
      if (farmStopped) { resolve(); return; }
      farmDone = resolve;
      for (const p of list) {
        const kind = p.kind === 'compute' ? 'compute' : 'render';
        const entry = { obj: null, ready: false, failed: false, promise: null };
        entry.promise = new Promise((res, rej) => { entry.resolve = res; entry.reject = rej; });
        entry.promise.catch(() => {});
        const job = { i: farmJobs++, p, kind, entry, state: 'queued', t: 0, mods: farmModuleIds(p.desc) };
        entry.bump = () => {
          if (job.state !== 'queued' || job.asked) return;
          job.asked = true;
          const at = farmQueue.indexOf(job);
          if (at >= 0) { farmQueue.splice(at, 1); farmAskedQ.push(job); farmStats.bumped++; }
        };
        kept[kind].set(JSON.stringify(p.desc), entry);
        progress.pipelines++;
        farmQueue.push(job);
        farmOpen++;
      }
      if (!farmOpen) { farmFinish('empty'); return; }
      farmWatchTimer = setInterval(farmWatch, 1000);
      takenKick.then(farmPump);
      if (farmNone) farmNoWorkers(); else farmDeal();
    });
  }

  // No worker came up: the page's device makes every pipeline itself, as without the farm
  function farmNoWorkers() {
    if (!farmNone) { farmNone = true; farmWhy("no worker came up: the page's device makes them"); }
    while (farmAskedQ.length) farmToPage(farmAskedQ.shift());
    while (farmQueue.length) farmToPage(farmQueue.shift());
  }

  function farmDeal() {
    if (farmStopped) return;
    for (const lane of farmLanes) {
      while (lane.alive && lane.inflight.size < FARM_PER_WORKER && (farmAskedQ.length || farmQueue.length)) {
        farmSend(lane, farmAskedQ.length ? farmAskedQ.shift() : farmQueue.shift());
      }
    }
  }

  function farmSend(lane, job) {
    const modules = job.mods.map((id) => [id, farmModules.get(id)]);
    job.state = 'sent';
    job.t = now();
    lane.inflight.set(job.i, job);
    farmStats.dealt++;
    try { lane.worker.postMessage({ type: 'job', i: job.i, kind: job.kind, desc: job.p.desc, modules }); } catch (e) {
      farmLaneDown(lane, 'worker ' + lane.i + ' post: ' + (e && e.message || e));
    }
  }

  function farmMessage(lane, m) {
    if (m.type === 'done' || m.type === 'error') {
      const job = lane.inflight.get(m.i);
      if (!job) return;   // timed out before, and made on the page's device already
      lane.inflight.delete(m.i);
      if (m.type === 'done') {
        farmStats.done++;
        farmStats.worker_ms += m.ms || 0;
        farmMain(job, null);
      } else {
        farmStats.errors++;
        farmWhy('pipeline ' + job.p.id + ': ' + m.error);
        farmToPage(job);
      }
      farmDeal();
    } else if (m.type === 'lost') {
      farmLaneDown(lane, 'worker ' + lane.i + ' device lost: ' + m.why);
    }
  }

  // A worker that failed: its pipelines go back to the front of the queue, and to the page's device once no worker is left
  function farmLaneDown(lane, why) {
    if (!lane.alive) return;
    lane.alive = false;
    farmStats.lost++;
    farmWhy(why);
    try { lane.worker.terminate(); } catch (e) { /* gone */ }
    const back = [...lane.inflight.values()];
    lane.inflight.clear();
    for (let k = back.length - 1; k >= 0; k--) { back[k].state = 'queued'; back[k].asked = true; farmAskedQ.unshift(back[k]); farmStats.requeued++; }
    if (farmLanes.some((l) => l.alive)) { farmDeal(); return; }
    while (farmAskedQ.length) farmToPage(farmAskedQ.shift());
    while (farmQueue.length) farmToPage(farmQueue.shift());
  }

  // A pipeline in a worker for longer than FARM_JOB_MS goes to the page's device; a worker that does that twice is let go
  function farmWatch() {
    const t = now();
    for (const lane of farmLanes) {
      if (!lane.alive) continue;
      for (const job of [...lane.inflight.values()]) {
        if (t - job.t < FARM_JOB_MS) continue;
        lane.inflight.delete(job.i);
        farmStats.timeouts++;
        farmWhy('pipeline ' + job.p.id + ': not made in worker ' + lane.i + ' in ' + FARM_JOB_MS + ' ms');
        farmToPage(job);
        if (++lane.timeouts >= 2) farmLaneDown(lane, 'worker ' + lane.i + ': 2 timeouts');
      }
    }
    farmDeal();
  }

  // The page's device makes a pipeline itself, at most the pack's in-flight count at once until the engine takes the device (as
  // the replay without the farm)
  function farmToPage(job) {
    job.state = 'page';
    farmStats.fallback++;
    farmBack.push(job);
    farmPump();
  }
  function farmPump() {
    const limit = taken && !farmSeen ? Infinity : farmCap;
    while (farmBack.length && farmBackOpen < limit) {
      farmBackOpen++;
      farmMain(farmBack.shift(), () => { farmBackOpen--; farmPump(); });
    }
  }

  // The pipeline on the page's device: a cache hit after a worker made it, its own compile otherwise. After the maps drop it is
  // left to the engine (an asynchronous create waiting on it makes its own, now from the cache)
  function farmMain(job, after) {
    const entry = job.entry;
    const finish = () => { farmSettle(job); if (after) after(); };
    if (dropped || farmStopped) {
      farmStats.skipped++;
      entry.failed = true;
      entry.reject(new Error('the replay dropped its maps'));
      finish();
      return;
    }
    let desc;
    try { desc = resolveRef(job.p.desc); } catch (e) {
      entry.failed = true;
      failures.push({ id: job.p.id, error: String(e && e.message || e) });
      entry.reject(e);
      finish();
      return;
    }
    const fn = job.kind === 'compute' ? proto.createComputePipelineAsync : proto.createRenderPipelineAsync;
    Promise.resolve().then(() => fn.call(farmDevice, desc)).then((obj) => {
      entry.obj = obj; entry.ready = true; ids.set(obj, job.p.id); if (!dropped) byId.set(job.p.id, obj); progress.pipelines_ready++;
      entry.resolve(obj);
    }, (e) => {
      entry.failed = true; progress.pipeline_errors++; failures.push({ id: job.p.id, error: String(e && e.message || e) });
      entry.reject(e);
    }).then(finish);
  }

  function farmSettle(job) {
    if (job.state === 'settled') return;
    job.state = 'settled';
    if (--farmOpen === 0) farmFinish('done');
  }

  // The workers stop: every pipeline settled, or the time after ready ran out (what is left is the engine's own)
  function farmFinish(why) {
    if (farmStopped) return;
    farmStopped = why;
    farmStats.t_end = now();
    clearInterval(farmWatchTimer);
    const left = farmAskedQ.splice(0).concat(farmQueue.splice(0), farmBack.splice(0));
    for (const lane of farmLanes) {
      for (const job of lane.inflight.values()) left.push(job);
      lane.inflight.clear();
      if (!lane.alive) continue;
      lane.alive = false;
      try { lane.worker.postMessage({ type: 'stop' }); } catch (e) { /* gone */ }
      setTimeout(() => { try { lane.worker.terminate(); } catch (e) { /* gone */ } }, 2000);
    }
    for (const job of left) {
      if (job.state === 'settled') continue;
      job.state = 'settled';
      farmOpen--;
      farmStats.skipped++;
      job.entry.failed = true;
      job.entry.reject(new Error('farm stopped: ' + why));
    }
    say('farm', farmSummary());
    if (farmDone) farmDone();
  }

  async function replay(pack, dev, visit) {
    // The pipelines to make, in the pack's order, each followed by its canvas-format twin
    const canvas = navigator.gpu.getPreferredCanvasFormat();
    const queue = [];
    for (const p of pack.pipelines || []) {
      if (visit.replay === 'none' || (visit.replay === 'urgent' && !urgent(p))) continue;
      queue.push({ id: p.id, kind: p.kind, desc: p.desc });
      const twin = twinOf(p.desc, pack.canvas_format, canvas);
      if (twin) { queue.push({ id: p.id + 't', kind: p.kind, desc: twin }); progress.twins++; }
    }
    // The compile farm (above): its workers start while this device makes the modules and layouts
    farmCap = pack.in_flight || 16;
    const farmUp = farmCount > 0 && queue.length && deviceAsk ? farmStart(pack, deviceAsk) : null;
    if (farmUp) farmUp.then((up) => { if (!up) { say('farm_off', farmSummary()); farmNoWorkers(); } });
    const budget = (pack.module_kb_per_frame || 128) * 1024;
    let spent = 0;
    for (const m of pack.modules || []) {
      if (dropped) break;
      const bytes = (m.desc && typeof m.desc.code === 'string') ? m.desc.code.length : 0;
      if (spent && spent + bytes > budget) { await nextFrame(); spent = 0; }
      if (make(dev, 'module', m)) { progress.modules++; progress.module_kb += Math.round(bytes / 1024); }
      spent += bytes;
    }
    if (dropped) {
      if (farmUp) farmFinish('dropped');
      return;
    }
    marks.modules = now();
    for (const b of pack.bgls || []) { if (make(dev, 'bgl', b)) progress.layouts++; }
    for (const l of pack.layouts || []) { if (make(dev, 'layout', l)) progress.layouts++; }
    marks.layouts = now();
    say('modules', { modules: progress.modules, kb: progress.module_kb, layouts: progress.layouts, t: marks.modules });
    if (farmUp) {
      await farmRun(dev, queue, visit);
      marks.pipelines = now();
      say('pipelines', { made: progress.pipelines, ready: progress.pipelines_ready, errors: progress.pipeline_errors, twins: progress.twins,
        t: marks.pipelines, failures: failures.slice(0, 10), farm: farmSummary() });
      return;
    }
    const inFlight = new Set();
    const cap = pack.in_flight || 16;
    while ((queue.length || inFlight.size) && !dropped) {
      while (queue.length && inFlight.size < (taken && !visit.seen ? Infinity : cap) && !dropped) {
        const p = queue.shift();
        const kind = p.kind === 'compute' ? 'compute' : 'render';
        let desc;
        try { desc = resolveRef(p.desc); } catch (e) { failures.push({ id: p.id, error: String(e.message) }); continue; }
        const entry = { obj: null, ready: false, failed: false, promise: null };
        const fn = kind === 'compute' ? proto.createComputePipelineAsync : proto.createRenderPipelineAsync;
        entry.promise = fn.call(dev, desc).then((obj) => {
          entry.obj = obj; entry.ready = true; ids.set(obj, p.id); byId.set(p.id, obj); progress.pipelines_ready++;
          return obj;
        }, (e) => { entry.failed = true; progress.pipeline_errors++; failures.push({ id: p.id, error: String(e && e.message || e) }); throw e; });
        entry.promise.catch(() => {});
        kept[kind].set(JSON.stringify(p.desc), entry);
        progress.pipelines++;
        const done = entry.promise.then(() => {}, () => {}).then(() => inFlight.delete(done));
        inFlight.add(done);
      }
      if (!inFlight.size) break;
      await (taken ? Promise.race(inFlight) : Promise.race([...inFlight, takenKick]));
    }
    marks.pipelines = now();
    say('pipelines', { made: progress.pipelines, ready: progress.pipelines_ready, errors: progress.pipeline_errors, twins: progress.twins,
      t: marks.pipelines, failures: failures.slice(0, 10) });
  }

  // The engine's creation calls on the page's device: the kept object when the pack made the same one
  function lookupOn(dev) {
    const label = (desc) => (desc && desc.label ? String(desc.label).slice(0, 80) : '');
    for (const [method, kind, isAsync] of KINDS) {
      const fn = proto[method];
      if (typeof fn !== 'function') continue;
      dev[method] = function (desc) {
        if (dropped) return fn.call(this, desc);
        const key = keyOf(desc);
        const k = kept[kind].get(key);
        if (k && !k.failed && (isAsync || k.ready)) {
          stats[kind][0]++;
          if (isAsync) {
            if (!k.ready && k.bump) k.bump();   // the compile farm deals a pipeline the engine waits for first
            return k.ready ? Promise.resolve(k.obj) : k.promise.catch(() => fn.call(this, desc));
          }
          return k.obj;
        }
        stats[kind][1]++;
        if (k) stats[kind][2]++;   // a synchronous call for a pipeline the pack is still compiling: late, not absent
        if (misses.length < 10) misses.push({ kind, label: label(desc), pending: !!k, key: key.length > 300 ? key.slice(0, 300) + '...' : key });
        const result = fn.call(this, desc);
        const keep = (obj) => { if (obj && typeof obj === 'object' && !ids.has(obj)) ids.set(obj, 'g' + (++unknown)); return obj; };
        return isAsync ? result.then(keep) : keep(result);
      };
    }
  }
  const summary = (why) => ({ why, t: now(), marks,
    hits: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { hit: v[0], miss: v[1], late: v[2] }])),
    made: progress, failures: failures.length, misses, farm: farmCount ? farmSummary() : null });
  function drop(why) {
    if (dropped) return;
    say('drop', summary(why));
    dropped = true;
    for (const m of Object.values(kept)) m.clear();
    byId.clear();
  }

  // ---- start (wasm-loader.js, as soon as it has the compat check's start-argument promise) ----
  let creating = null;
  async function begin(startArgs) {
    let args = [];
    try { args = (await startArgs) || []; } catch (e) { args = []; }
    marks.pick = now();
    const tier = tierOf(args);
    marks.tier = tier;
    let pack = null;
    if (mode === 'replay' && tier !== 'both') {
      const entries = await listing;
      const { url, response: pending } = fetchPack(tier, entries);
      const response = await pending;
      if (!url) say('no_pack', { tier });
      else if (!response || !response.ok) say('no_pack', { tier, url, status: response ? response.status : 'fetch failed' });
      else {
        try { pack = await response.json(); } catch (e) { say('pack_unreadable', { url, error: String(e && e.message || e) }); }
        marks.pack = now();
        const stamp = await stampOf(entries, tier).catch(() => '');   // no crypto.subtle outside a secure context: no pack
        if (pack && pack.format !== FORMAT[tier]) { say('pack_refused', { why: 'format', pack: pack.format, tier }); pack = null; }
        else if (pack && pack.stamp !== stamp) { say('pack_refused', { why: 'another build', pack: pack.stamp, stage: stamp }); pack = null; }
      }
    } else if (mode === 'capture' && tier !== 'both') {
      marks.stamp = await stampOf(await listing, tier).catch(() => '');
    }
    const dev = await createDevice(tier);
    if (!dev) return null;
    if (mode === 'capture') captureOn(dev);
    if (pack) {
      lookupOn(dev);
      const visit = visitOf(pack);
      say('replay', { tier, modules: (pack.modules || []).length, pipelines: (pack.pipelines || []).length, in_flight: pack.in_flight || 16,
        return_visit: visit.seen, replay: visit.replay });
      replay(pack, dev, visit).catch((e) => say('replay_failed', { error: String(e && e.message || e) }));   // not awaited: the engine may take the device first
      window.addEventListener('ue-ready', () => {
        marks.ready = now();
        say('ready', summary('ready'));
        try { localStorage.setItem(visitKey(pack), String(Date.now())); } catch (e) { /* a private window: every visit replays it all */ }
        // 10 s after ready the maps go: later creations go to the browser unchanged
        setTimeout(() => drop('ready + 10 s'), 10000);
        // The compile farm fills Metal's cache for the engine's own creates until 60 s after ready
        if (farmStats.t_start) setTimeout(() => farmFinish('cutoff ' + FARM_AFTER_READY_MS / 1000 + ' s after ready'), FARM_AFTER_READY_MS);
      }, { once: true });
    }
    return dev;
  }
  function start(startArgs) {
    if (creating) return;
    creating = begin(startArgs).then((d) => {
      device = d;
      if (d && released) { d.destroy(); device = null; }
      return device;
    }, (e) => { say('device_failed', { error: String(e && e.message || e) }); return null; });
  }

  // ---- hand-off (wasm-loader.js, before the engine starts): the device when it is ready within ms, else null (the engine
  // requests its own, and a device that arrives later is released) ----
  function handOff(ms) {
    if (!creating) return Promise.resolve(null);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
    return Promise.race([creating, timeout]).then((d) => {
      if (d) {
        handed = true;
        marks.handoff = now();
        say('handoff', { t: marks.handoff, modules: progress.modules, pipelines: progress.pipelines, pipelines_ready: progress.pipelines_ready });
        return d;
      }
      released = true;
      drop('no hand-off');
      if (device) { device.destroy(); device = null; }
      say('handoff_skipped', { why: 'not ready in ' + ms + ' ms' });
      return null;
    });
  }

  // The RHI's answer: a device it did not take is released
  window.addEventListener('ue-webgpu-device', (event) => {
    const detail = (event && event.detail) || {};
    marks.engine = now();
    marks.engine_page = !!detail.page;
    say('engine_device', { page: !!detail.page, why: detail.why || '', t: marks.engine });
    if (detail.page) { taken = true; kickTaken(); }
    else if (handed && device) { released = true; drop('engine device'); device.destroy(); device = null; }
  });

  window.uePrewarm = { mode, start, device: handOff, marks, summary: () => summary('asked'), farm: farmSummary };
  say('armed', { mode });
})();
