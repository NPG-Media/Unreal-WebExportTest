// The cover: progress, the start-up steps, errors, the log download. A classic script: its top-level names are shared with the
// page's other scripts, which index.html loads in order (wasm-harness, wasm-compat, wasm-play, wasm-loader).
// The game starts by itself and the cover lifts when the engine says the game is ready. The loader reports each step (ueSteps),
// the bar never moves back, and the last step (the engine loading the startup level) eases towards the end until the ready
// signal. Sound waits for the first click or key; the key hint (ue-hint) stays at the top left while playing.
//
// The ready signal: the engine's page bridge (WasmPage module) dispatches 'ue-ready' and prints
// 'UE_RUN READY'. Older names count too, for one release: the events 'ue-site-ready' and 'ue-interactive', and the log lines
// 'LOADING_READY' (wasm-loader.js print). A build whose log reaches the page lifts the cover on the line
// (an event sent from the game thread can run ahead of the frame that shows the level); one that prints nothing lifts it on the
// event.

const harness = query.get('harness') === '1';
const cover = $('cover');
const hint = $('hint');
const startOnClick = pageMeta('ue-start', 'auto') === 'click' && !harness;
if (harness) cover.hidden = true;
let failed = false;
// The cover's state, forward only, on every load path (cached, uncached, reload, hard reload):
//   loading (page, browser check, download) -> engine (script and runtime) -> level (the startup level, warm-up)
//   -> ready (the engine's ready signal) -> [click (ue-start=click)] -> lifted;   failed and ended (the end card) from any state.
// Each change is a 'PAGE COVER <state> <ms>' line and body[data-cover], so harnesses and tests read one sequence
const coverStates = ['loading', 'engine', 'level', 'ready', 'click', 'lifted'];
let coverState = 'loading';
let engineRan = false;   // the cover got past 'loading' (failed aside): the engine started, so it wrote a log, in OPFS or in memory
function coverTo(state) {
  if (coverState === 'failed' || coverState === 'ended') return;
  const terminal = state === 'failed' || state === 'ended';
  if (!terminal && coverStates.indexOf(state) <= coverStates.indexOf(coverState)) return;   // never back
  coverState = state;
  if (state !== 'loading' && state !== 'failed') engineRan = true;
  document.body.dataset.cover = state;
  console.log('PAGE COVER ' + state + ' ' + Math.round(performance.now()));
}
let shown = 0;
let lifted = false;
let ready = false;
// The start-up download (wasm-loader.js: stage 'download' for each byte count from the data cache, 'downloaded' for the last)
// runs while the engine script loads and the engine module compiles. Until the engine is up (siteStarted) or the bytes are in,
// the bar and the line follow the download, and a later stage's report waits: its line shows then, its value is dropped (the
// level eases on from where the download left the bar; kept when no count came at all). After that a count moves the bar only. The engine's first report
// (0.76) came 2 s into a cold load, the bar kept that maximum for the whole download, and the line switched between the byte
// count and the level's seconds (UE-410987)
let download = 'none';   // 'active' while the counts hold the line, then 'over'
let counted = false;
let waiting = null;
function progress(text, fraction, stage) {
  if (lifted || ready) return;   // the game is ready; later reports (a late file) leave the cover's last line alone
  if (stage === 'download' || stage === 'downloaded') {
    if (download === 'over') { progressBar(fraction); return; }
    download = 'active';
    counted = counted || stage === 'downloaded' || fraction > 0.05;
    progressShow(text, fraction);
    if (stage === 'downloaded') downloadOver();
    return;
  }
  if (download === 'active') { waiting = { text, fraction }; return; }
  progressShow(text, fraction);
}
function progressShow(text, fraction) {
  $('progress-text').textContent = T(text);
  progressBar(fraction);
}
function progressBar(fraction) {
  if (fraction === undefined) return;
  shown = Math.max(shown, Math.min(1, fraction));
  $('bar').style.width = (shown * 100).toFixed(1) + '%';
  const pb = $('progressbar'); if (pb && pb.setAttribute) pb.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
}
function downloadOver() {
  if (download === 'active' && waiting) progressShow(waiting.text, counted ? undefined : waiting.fraction);
  download = 'over';
  waiting = null;
}
// A stop that is this browser, GPU, device or site rather than a fault of the game (stop: 'browser', 'gpu', 'device' or 'site'; the compat
// check's stops pass one): the card takes the cover's middle under a plain headline with the reason in large type, so a player
// does not read it as the game breaking. No cross-origin isolation is the site's stop (the host's setup, in any browser and on
// any device: UE-411132). A browser the advice line would send to Chrome (not on iOS, where every browser is
// WebKit, and not when the project turned the advice off) also gets a button that copies the page's link and a link to Chrome
const unsupportedTitles = {
  browser: "%s can't run in this browser",
  gpu: "%s can't run on this GPU",
  device: "%s can't run on this device",
  site: "%s can't run on this site",
};
function showUnsupported(stop) {
  cover.classList.add('unsupported');
  const title = $('cover-title');
  const error = $('error');
  if (title && error && typeof title.after === 'function') title.after(error);
  const who = window.ueCompat && window.ueCompat.browser ? window.ueCompat.browser() : { name: '', os: '' };
  const game = document.title && !document.title.includes('%') ? document.title : 'The game';
  // (on iOS the fix is the device or its system, never another browser)
  const kind = stop === 'browser' && who.os === 'iOS' ? 'device' : stop;
  $('error-title').textContent = T(unsupportedTitles[kind]).replace('%s', game);
  console.log('PAGE UNSUPPORTED ' + kind + ' ' + (who.name || '?') + ' ' + (who.version || '') + ' ' + (who.os || ''));
  const policy = (window.ueCompat && window.ueCompat.policy) || {};
  if (who.name === 'Chrome' || who.os === 'iOS' || policy.browserAdvice || stop === 'site') return;
  const copy = $('error-copy');
  copy.addEventListener('click', async () => {
    const link = location.href;
    try { await navigator.clipboard.writeText(link); copy.textContent = T('Copied: paste it into Chrome'); } catch (e) { copy.textContent = link; }
  });
  $('error-fix').hidden = false;
}
function fail(message, stop) {
  if (failed || recovering) return;
  const kind = classifyLine(String(message));
  if (kind) { failKind(kind, String(message)); return; }
  // no cross-origin isolation (the compat check's test) is the site's to fix, on every browser and device
  if (stop === 'browser' && window.ueCompat && window.ueCompat.failed && window.ueCompat.failed() === 'cross_origin_isolated') stop = 'site';
  // on iOS the fix is the device or its system, never another browser: a browser stop there is a device stop in the
  // UE_RUN ERROR line and the report as well as on the card
  if (stop === 'browser' && window.ueCompat && window.ueCompat.browser && window.ueCompat.browser().os === 'iOS') stop = 'device';
  const detail = { kind: 'page', message: String(message), ...(unsupportedTitles[stop] ? { stop } : {}) };
  console.log('UE_RUN ERROR ' + JSON.stringify(detail));
  window.dispatchEvent(new CustomEvent('ue-error', { detail }));
  if (unsupportedTitles[stop]) showUnsupported(stop);
  failQuiet(message);
  // wasm traps, Emscripten aborts and script errors are the commonest crash: they reach the report too
  crashReport(/\b(Aborted|abort|RuntimeError|unreachable|trap)\b/i.test(String(message)) ? 'abort' : 'page', String(message));
}
function failQuiet(message) {
  if (failed || recovering) return;
  failed = true;
  coverTo('failed');
  cover.hidden = false;
  cover.classList.remove('lifting', 'click');
  hint.hidden = true;
  ueSteps.stop();
  $('error').style.display = 'block';
  $('error-text').textContent = message;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (document.pointerLockElement) document.exitPointerLock();
}
// What a player reads when the game stops, by kind. The engine raises 'ue-error' {kind, message}; the loader also
// recognises the engine's own lines (wasm-loader.js print/printErr) and Emscripten's abort text
const errorCards = {
  'device-lost': 'The graphics device stopped (the GPU driver reset or the browser took the GPU back). Reload the page to play on.',
  'out-of-memory': 'The game ran out of memory in this tab. Close other tabs or programs and reload; a computer with more memory helps.',
  'abort': 'The game stopped with an error.',
};
function failKind(kind, detail) {
  if (failed || recovering) return;
  const text = T(errorCards[kind] || errorCards.abort);
  console.log('UE_RUN ERROR ' + JSON.stringify({ kind, message: String(detail || '') }));
  failQuiet(text + (detail ? '\n\n' + detail : ''));
  crashReport(kind, String(detail || ''));
}

// An error report to the project's endpoint (<meta name="ue-crash-url">, setting CrashReportUrl), off by default.
// ue-crash-consent: "ask" (the default: the error card offers "Send a report"; nothing leaves before the click) or "always".
// The report: kind, message, the last engine lines, browser and GPU, the page path without its query, the build's files'
// sha1s; no cookies, no storage contents, no query string. One report per page load
// A report carries no command line and no query string. The engine's 'LogInit: Command Line:' (and any line that
// echoes the arguments) holds ?args= and the tokens a portal adds, so it is dropped; in other lines URL queries, key=value
// secrets and long token-like runs are masked
const engineLines = [];
function redactLine(t) {
  const s = String(t);
  if (/Command ?Line\s*:|UE_RUN CONFIG|staged_cmdline/i.test(s)) return '[command line removed]';
  return s
    .replace(/\?[^\s"'<>]*=[^\s"'<>]*/g, '?[query removed]')
    .replace(/(-?\b(?:auth\w*|token|password|passwd|secret|key|code|ticket|session\w*|epicapp\w*|exchangecode)\s*[=:]\s*)("[^"]*"|\S+)/gi, '$1[removed]')
    .replace(/[A-Za-z0-9+/_\-]{32,}={0,2}/g, '[token removed]');
}
function rememberLine(t) { engineLines.push(redactLine(t).slice(0, 300)); if (engineLines.length > 60) engineLines.shift(); }
let crashSent = false;
function crashReport(kind, message) {
  const url = pageMeta('ue-crash-url');
  if (!url || !/^https:\/\//.test(url) || crashSent) return;
  const send = async () => {
    if (crashSent) return;
    crashSent = true;
    let compat = null;
    try { compat = window.ueCompat ? { browser: window.ueCompat.browser(), adapter: (await window.ueCompat.probe()).adapter } : null; } catch (e) { compat = null; }
    const report = { version: 1, project: pageMeta('ue-project'), title: document.title, kind, message: redactLine(message).slice(0, 4000),
      page: location.pathname, time: new Date().toISOString(), uptime_ms: Math.round(performance.now()), lines: engineLines.slice(),
      browser: compat && compat.browser, adapter: compat && compat.adapter, files: (window.ueStageFiles || []).slice(0, 20) };
    try {
      await fetch(url, { method: 'POST', mode: 'cors', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      console.log('PAGE CRASH_REPORT sent');
      const b = $('report'); if (b) { b.disabled = true; b.textContent = 'Report sent'; }
    } catch (e) { console.log('PAGE CRASH_REPORT failed: ' + e); }
  };
  if (pageMeta('ue-crash-consent', 'ask') === 'always') { send(); return; }
  const b = $('report');
  if (b) { b.hidden = false; b.onclick = send; }
}
// The end card. The engine says it is ending ('ue-exit' {code}, WasmPage at engine exit: QuitGame, the console's
// exit, -UERunExitAfterReady); the page shows the card over the last frame: "Play again" reloads, and a project link
// (<meta name="ue-end-link" content="https://..."> with ue-end-link-text) is offered as a plain link the player clicks (a page
// cannot open a tab without a click). Code 0 is a normal end; any other code is an error card
function gameEnded(code, doneLogged) {
  if (failed || coverState === 'ended') return;
  if (code) { failKind('abort', 'The game ended with code ' + code + '.'); return; }
  coverTo('ended');
  if (!doneLogged) console.log('UE_RUN DONE 0');   // the engine printed it already under -UERunExitAfterReady
  if (harness) return;
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  hint.hidden = true;
  const card = $('ended');
  const link = pageMeta('ue-end-link');
  const a = $('ended-link');
  if (link && /^https:\/\//.test(link)) { a.href = link; a.textContent = pageMeta('ue-end-link-text') || link; a.hidden = false; }
  card.hidden = false;
  cover.hidden = false;
  cover.classList.remove('lifting', 'click');
  $('art').hidden = true;
  $('steps').hidden = true;
}
window.addEventListener('ue-exit', (event) => gameEnded(Number((event.detail || {}).code) || 0, !!(event.detail || {}).done));

// The engine opened a link (FPlatformProcess::LaunchURL) and the browser blocked the new tab: the page offers the
// link for the player to click (a click is a gesture, so that tab opens). Only http(s) links
window.addEventListener('ue-open-url', (event) => {
  const d = event.detail || {};
  const url = String(d.url || '');
  if (!d.blocked || !/^https?:\/\//i.test(url)) return;
  let bar = $('openurl');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'openurl';
    bar.className = 'openurl';
    if (bar.setAttribute) bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
  }
  bar.textContent = '';
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = T('Open the link') + ': ' + url;
  a.addEventListener('click', () => { bar.hidden = true; });
  bar.appendChild(a);
  bar.hidden = false;
  console.log('PAGE OPEN_URL offered');
});

// The engine's events ('page' is the page's own, sent by fail())
window.addEventListener('ue-error', (event) => {
  const d = event.detail || {};
  if (d.kind && d.kind !== 'page') failKind(d.kind, d.message);
});
// Lines that name a failure the player should hear about
function classifyLine(t) {
  if (/WEBGPU ERROR device lost|WebGPU device lost/.test(t)) return 'device-lost';
  if (/Ran out of memory|Out of memory|Cannot enlarge memory|OOM\b/.test(t)) return 'out-of-memory';
  return null;
}

// A line under the bar that stays while loading (browser advice, a compat warning)
function notice(text) {
  const n = $('notice');
  n.textContent = n.hidden ? text : n.textContent + ' ' + text;
  n.hidden = false;
}
// A note for the playing page (a line under the bar is gone once the cover lifts): shown when the cover lifts, under the key hint,
// for 10 s or until its x is clicked; on a harness run (no cover) when the game is ready, so its captures show it. One at a
// time: a later note replaces one not shown yet
let toastText = '';
function toast(text) {
  toastText = String(text || '');
  if (lifted) showToast();
}
function showToast() {
  const box = $('toast');
  if (!toastText || failed || !box) return;
  $('toast-text').textContent = toastText;
  console.log('PAGE TOAST ' + toastText);
  toastText = '';
  box.style.top = hint.hidden || !hint.getBoundingClientRect ? '' : Math.round(hint.getBoundingClientRect().bottom + 8) + 'px';
  box.hidden = false;
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    box.classList.add('leaving');
    setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); }, 400);
  };
  timer = setTimeout(close, 10000);
  $('toast-close').onclick = close;
}
// GPU failures the page recovers from (Build/Template's part of the web RHI's hooks, WebGPUPipelines.cpp and WebGPUDevice.cpp):
// - a pipeline whose creation failed validation (a GPU short of a limit or a storage format a shader needs), or that the RHI did
//   not create because the shader exceeds the device's workgroup limits: the RHI skips it and calls ueOnWebGPUPipelineFailed
//   (kind, entry, message, fallback, limit): fallback is true on the deferred and desktop renderers, where a compute or
//   frame-critical failure reloads the page once on the forward renderer for this tab's session (sessionStorage: a saved menu
//   choice stands), except a compute failure with limit set (the shader exceeds the device's workgroup limits) on the deferred
//   renderer (tier, the RHI's sixth argument), unless the kernel is frame-critical: deferred runs the mobile renderer's kernels, so
//   forward fails the same way, and it is only logged. On the forward renderer a frame-critical failure
//   stops the game with a message instead of drawing broken frames; any other failure is logged (PAGE PIPELINE_FAILED) and the
//   game goes on. <meta name="ue-pipeline-fallback">: mobile (the default: the reload on the forward renderer; forward is the
//   same) or off (log only). A harness run reloads only with ?pipelinefallback=1
// - a lost device: the RHI calls ueOnWebGPUDeviceLost before its fatal error. <meta name="ue-device-lost">: stop (the default:
//   the error card; after a deferred or desktop start it also keeps this tab on the forward renderer, so the player's reload
//   starts forward) or reload (the page reloads, on the forward renderer after a deferred or desktop start; a
//   second loss within a minute, a harness run, or a page that cannot keep the marker stops on the card)
// The next load says what happened in a toast after the cover lifts
const gpuFallbackKey = 'ue.' + (pageMeta('ue-project') || 'game') + '.gpuFallback';
const gpuRestartKey = 'ue.' + (pageMeta('ue-project') || 'game') + '.gpuRestart';
var recovering = false;   // a reload is under way: later errors are this failure's echo, not a new stop (var: fail() reads it)
(() => {
  let restart = null;
  try { restart = sessionStorage.getItem(gpuRestartKey); sessionStorage.removeItem(gpuRestartKey); } catch (e) { restart = null; }
  if (!restart) return;
  console.log('PAGE RESTART ' + restart);
  if (restart === 'pipeline' || restart === 'pipeline-desktop') toast("Switched to the forward renderer: this GPU couldn't run the desktop one.");
  else if (restart === 'pipeline-deferred') toast("Switched to the forward renderer: this GPU couldn't run the deferred one.");
  else if (restart === 'device-lost-mobile' || restart === 'device-lost-forward') toast('The graphics device was lost, so the game restarted on the forward renderer.');
  else if (restart === 'device-lost') toast('The graphics device was lost, so the game restarted.');
})();
function restartPage(marker, fallback, line) {
  try {
    if (fallback) sessionStorage.setItem(gpuFallbackKey, JSON.stringify(fallback));
    sessionStorage.setItem(gpuRestartKey, marker);
  } catch (e) { return false; }   // storage off: the next load could not tell (a loop), so no reload
  recovering = true;
  console.log(line);
  if (siteTimer) clearInterval(siteTimer);
  lifted = true;
  cover.hidden = false;
  cover.classList.remove('lifting', 'click');
  hint.hidden = true;
  $('progress-text').textContent = T(fallback ? 'Switching to the forward renderer...' : 'Restarting...');
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => location.reload(), 1500);
  return true;
}
const fellBack = () => { try { return !!sessionStorage.getItem(gpuFallbackKey); } catch (e) { return true; } };
// The renderer this start runs, from the switches the page passed (wasm-compat.js tierArgs): desktop, deferred or forward
const runningTier = () => {
  const a = (window.Module && window.Module.arguments) || [];
  // wasm-compat.js knows the stage's tiers, so a start without tier switches (the project's own tier) is not taken for forward
  if (window.ueCompat && typeof window.ueCompat.runningTier === 'function') return window.ueCompat.runningTier(a);
  return a.includes('-WebGPUSM5') ? 'desktop' : a.includes('-WebGPUMobileDeferred') ? 'deferred' : 'forward';
};
// The kernels whose loss leaves no usable frame: without instance culling the forward scene is garbled, without it or the light
// grid the deferred or desktop frame is black. A render pipeline loses one material; three, the frame
const frameCritical = [
  { kind: 'compute', entry: /^(InstanceCull|GPUScene)/, what: 'GPU scene culling' },
  { kind: 'compute', entry: /^LightGrid/, what: 'the light grid' },
  { kind: 'render', entry: /^/, count: 3, what: 'the base pass' },
];
const pipelineFailures = { render: 0, compute: 0 };
const appleShaderFixes = 27;   // the Safari and iOS version with the shader validation fixes named below
window.ueOnWebGPUPipelineFailed = (kind, entry, message, fallback, limit, rhiTier) => {
  const test = /TestFailPipeline/.test((window.Module && window.Module.arguments || []).join(' '));   // the RHI's repro switch
  pipelineFailures[kind] = (pipelineFailures[kind] || 0) + 1;
  // fallback: the RHI runs the deferred or the desktop renderer (the switches say which; with neither, the engine started its
  // desktop tier by itself, as a true fourth argument meant before the deferred tier)
  const tier = rhiTier || (fallback ? (runningTier() === 'deferred' ? 'deferred' : 'desktop') : 'forward');
  console.log('PAGE PIPELINE_FAILED ' + kind + ' ' + (entry || '-') + ' ' + tier + (test ? ' (test)' : '') + (limit ? ' (device limit)' : '') + ': ' + String(message || '').slice(0, 300));
  if (pageMeta('ue-pipeline-fallback', 'mobile') === 'off' || failed || recovering) return;
  const critical = frameCritical.find((c) => c.kind === kind && c.entry.test(entry || '') && pipelineFailures[kind] >= (c.count || 1));
  // A device limit on deferred is one forward has too (the same mobile renderer kernels), so only a frame-critical kernel is
  // worth the reload; from desktop the kernel may not exist on forward, so it still reloads
  if (fallback && (critical || (kind === 'compute' && !(limit && tier === 'deferred'))) && !fellBack() && (!harness || query.get('pipelinefallback') === '1')) {
    if (restartPage('pipeline-' + tier, { why: 'pipeline', from: tier, kind, entry: entry || kind, at: Date.now() }, 'PAGE PIPELINE_FALLBACK forward from ' + tier + ' (' + (entry || kind) + ')')) return;
  }
  if (critical && !fallback) {
    const game = document.title && !document.title.includes('%') ? document.title : 'the game';
    // Safari and iOS before 27 reject some valid web shaders (WebKit 176473479 binary arithmetic, 177008615 identifiers,
    // 177012957 short-circuit && and ||, fixed in 27.0), so there the likely cause is the system, not the GPU: the stop names the
    // update (a browser stop, which fail() shows as a device stop on iOS); a Mac can also play now in another browser
    // An iOS browser other than Safari (Chrome's CriOS, ...) names no version (webkit 0): every iOS browser is WebKit, so the
    // system is still the likely cause; the stop names the update for a system older than 27 without guessing this one's version
    const who = window.ueCompat && window.ueCompat.browser ? window.ueCompat.browser() : {};
    // (an iPad in desktop mode whose user agent names a Safari version below 26 is not telling the system's: it runs WebGPU)
    const iosUnknown = who.os === 'iOS' && (!(who.webkit > 0) || (/Macintosh/.test(who.ua || '') && who.webkit < 26));
    if ((who.os === 'iOS' || (who.name === 'Safari' && who.os === 'macOS')) && ((who.webkit > 0 && who.webkit < appleShaderFixes) || iosUnknown)) {
      const ios = who.os === 'iOS';
      const what = ios ? (who.device === 'tablet' ? 'iPadOS' : 'iOS') : 'Safari';
      const where = ios ? 'Settings > General > Software Update' : 'System Settings > General > Software Update';
      const device = who.device === 'tablet' ? 'iPad' : 'iPhone';
      fail(iosUnknown
        ? `This ${device} could not build ${critical.what} (${entry || kind}). ${what} ${appleShaderFixes} fixed shader bugs that can cause this: `
          + `if this ${device} has an older version, update it in ${where}.` + (test ? ' [test]' : '')
        : `${what} ${Math.floor(who.webkit)} could not build ${critical.what} (${entry || kind}). ${what} ${appleShaderFixes} fixed shader bugs that `
          + `can cause this: update it in ${where}` + (ios ? '.' : ', or play it now in Chrome.') + (test ? ' [test]' : ''), 'browser');
      return;
    }
    fail("This GPU can't run " + game + ': it could not build ' + critical.what + ' (' + (entry || kind) + ').' + (test ? ' [test]' : ''), 'gpu');
  }
};
window.ueOnWebGPUDeviceLost = (reason, message) => {
  const why = String(reason || 'unknown') + ': ' + String(message || '');
  console.log('PAGE DEVICE_LOST ' + why.slice(0, 300));
  // a lost device on the deferred or desktop renderer: this tab's next start takes the forward renderer, whether the page
  // reloads by itself (ue-device-lost reload) or the player reloads after the stop card (the default), so a reload does not
  // start the failing renderer again. A loss on forward records nothing, as before
  const from = runningTier();
  const upper = from !== 'forward' && !fellBack();
  // The stop path's record needs an explicit upper-tier argument: a start without one runs whatever the RHI picks. This hook gets
  // no tier from the RHI: the RHI's tier line is printed on the game thread and never passes through print. The reload path
  // deliberately keeps runningTier(), the highest cooked tier
  const args = (window.Module && window.Module.arguments) || [];
  // (the RHI's precedence: -WebGPUSM5 wins over -WebGPUNoSM5, -WebGPUNoMobileDeferred over -WebGPUMobileDeferred)
  const upperArg = args.includes('-WebGPUSM5')
    || (args.includes('-WebGPUMobileDeferred') && !args.includes('-WebGPUNoMobileDeferred'));
  if (upper && upperArg && !harness && !recovering && !failed && coverState !== 'ended') {
    // the restart marker too, so the next start in the tab says it runs forward because the device was lost (a toast)
    try { sessionStorage.setItem(gpuFallbackKey, JSON.stringify({ why: 'device-lost', from, at: Date.now() })); sessionStorage.setItem(gpuRestartKey, 'device-lost-forward'); } catch (e) { /* storage off */ }
  }
  if (pageMeta('ue-device-lost', 'stop') !== 'reload' || harness || failed || recovering || coverState === 'ended') return false;
  const lastKey = 'ue.' + (pageMeta('ue-project') || 'game') + '.deviceLostAt';
  let last = 0;
  try { last = Number(sessionStorage.getItem(lastKey)) || 0; sessionStorage.setItem(lastKey, String(Date.now())); } catch (e) { return false; }
  if (Date.now() - last < 60000) return false;   // twice in a minute: the card
  return restartPage(upper ? 'device-lost-forward' : 'device-lost', upper ? { why: 'device-lost', from, at: Date.now() } : null,
    'PAGE DEVICE_LOST reload' + (upper ? ' on the forward renderer (from ' + from + ')' : ''));
};

// The start-up steps, in order; the loader sets each one's state ('active', 'done', 'warn') and a detail line
const ueSteps = (() => {
  const order = [
    ['browser', 'Checking the browser'],
    ['gpu', 'Finding the graphics card'],
    ['settings', 'Picking the settings'],
    ['download', 'Downloading the game'],
    ['engine', 'Starting the engine'],
    ['site', 'Loading the level'],
  ];
  const list = $('steps');
  const rows = new Map();
  const started = new Map();
  for (const [id, label] of order) {
    const li = document.createElement('li');
    li.className = 'pending';
    li.innerHTML = '<span><span class="label"></span> <span class="detail"></span></span>';
    li.querySelector('.label').textContent = T(label);
    list.appendChild(li);
    rows.set(id, li);
  }
  function set(id, state, detail) {
    const li = rows.get(id);
    if (!li || (state === 'active' && failed)) return;   // after a stop no step spins again (a late byte count)
    if (state === 'active' && !started.has(id)) started.set(id, performance.now());
    li.className = state;
    if (detail !== undefined) li.querySelector('.detail').textContent = detail ? '(' + detail + ')' : '';
    if (state !== 'active') console.log('LOADSTEP ' + id + ' ' + state + ' ' + Math.round(performance.now()) + (detail ? ' ' + detail : ''));
  }
  // Seconds since the step went active, for its detail line ("0.3 s")
  const took = (id) => started.has(id) ? ((performance.now() - started.get(id)) / 1000).toFixed(1) + ' s' : '';
  // A step still active when the game is ready (no byte count reached its total) ends as done
  const finish = (id) => { const li = rows.get(id); if (li && li.className === 'active') set(id, 'done'); };
  // A stop (fail()): a step still active stops its spinner under the card and goes back to pending
  const stop = () => { for (const [id, li] of rows) if (li.className === 'active') set(id, 'pending'); };
  return { set, took, finish, stop };
})();

// The last stretch: the engine is up and loads the startup level (pipelines, textures). The page counts what the engine
// reports ('ue-progress' {fraction}, 'ue-warmup' {pso, textures}); without reports the bar eases from where it is towards 99 %
// (time constant tau s) until the ready signal
let siteTimer = null;
let warm = null;
window.addEventListener('ue-warmup', (event) => {
  const d = event.detail || {};
  if (!warm) warm = { most: 0, pso: 0, textures: 0 };
  warm.most = Math.max(warm.most, d.pso || 0);
  warm.pso = d.pso || 0;
  warm.textures = d.textures || 0;
});
let levelFraction = null;
window.addEventListener('ue-progress', (event) => {
  const d = event.detail || {};
  if (typeof d.fraction === 'number') levelFraction = Math.max(levelFraction || 0, Math.min(1, d.fraction));
});
// The level takes the line from the start-up download (progress above) and eases on from where the download left the bar.
// The engine streams the level's files while the download runs on, so on a slow network the level waits for bytes: the easing's
// time constant is a quarter of the download's remaining time at its rate so far, at least tau (Lyra, mobile tier: the engine
// was up at 7 s and ready at 19 s at 50 Mbit with half the start-up bytes in; at 10 Mbit up at 28 s, ready at 89 s, where tau
// alone left the bar at 98 % for the last 45 s). The level's line counts seconds or percent, whichever it started with: an
// engine's first 'ue-progress' (0 %) after seconds had been counted read as a step back
function siteStarted(tau) {
  coverTo('level');
  downloadOver();
  const from = shown, t0 = performance.now();
  const boot = window.ueBootDownload;
  if (boot && boot.at > boot.since && boot.total > boot.bytes) tau = Math.max(tau, (boot.total - boot.bytes) * (boot.at - boot.since) / boot.bytes / 4000);
  let unit = null;
  ueSteps.set('site', 'active');
  siteTimer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const eased = from + (0.99 - from) * (1 - Math.exp(-t / tau));
    if (warm && warm.most > 0 && warm.pso > 0) {
      const compiled = warm.most - warm.pso;
      progress(`Preparing shaders ${compiled} / ${warm.most}`, Math.max(eased * 0.5, from + (0.99 - from) * compiled / warm.most));
      ueSteps.set('site', 'active', `${compiled} / ${warm.most}`);
    } else if (warm && warm.textures > 0) {
      progress(`Loading textures (${warm.textures} left)`, eased);
      ueSteps.set('site', 'active', `${warm.textures} textures left`);
    } else {
      if (!unit) unit = levelFraction ? 'percent' : 'seconds';
      const counted = levelFraction !== null ? from + (0.99 - from) * levelFraction : 0;
      if (unit === 'percent') progress(`Loading the level... ${Math.round(levelFraction * 100)} %`, Math.max(eased * 0.5, counted));
      else progress('Loading the level... ' + t.toFixed(0) + ' s', Math.max(eased, counted));
    }
  }, 250);
  // A build that never sends the ready signal still gets the page back after two minutes
  setTimeout(gameReady, 120000);
}
// The pipeline hold (web.ReadyHoldPipelines, WasmPageBridge.cpp): the engine can keep the cover up after the ready signal while draws
// are still skipped for pipelines that compile (r.WebGPU.AsyncPipelines). It announces the hold with 'UE_RUN HOLD <cap ms>'
// before 'UE_RUN READY' and ends it with 'UE_RUN SETTLED <held ms> <settled|cap>' (main-thread lines, as the ready line; a
// build whose log does not reach the page sends the events 'ue-hold' {capMs} and 'ue-settled' {heldMs, reason}). The page
// only waits when the engine announced a hold, and at most the engine's cap plus 1 s. The engine's game-thread log (the
// 'Wasm pipelines: N draws skipped' reports) does not pass through Module.print, so the page cannot decide this itself.
// The hold pays only when the start-up download is in by ready: at 50 Mbit the boot containers were still
// arriving, the engine's sky light recapture waited on textures over the link, the hold reached its cap every time and the
// front end came 1.6-2.4 s later than with the cover lifted at ready. So the page follows the engine only when every start-up
// byte is in (wasm-loader.js ueBootDownload), or the rest arrives within 0.5 s at the rate measured so far, and otherwise
// lifts at ready; a load without byte counts (no service worker) follows the engine.
// <meta name="ue-pipeline-hold">: engine (follow the engine once the download is in, the default), always (follow the engine
// whatever the download) or off (lift at ready); ?hold= overrides it
const pipelineHold = (() => {
  const mode = String(query.get('hold') ?? pageMeta('ue-pipeline-hold', 'engine')).trim();
  let capMs = null, settled = null, proceed = null, readyAt = 0, timer = 0;
  // Why the start-up download rules the hold out ('' when it does not), and a PAGE HOLD download line
  function downloadPending() {
    const d = window.ueBootDownload;
    if (!d || !d.total) { console.log('PAGE HOLD download: no byte counts'); return ''; }
    const left = Math.max(0, d.total - d.bytes);
    const seconds = (d.at - d.since) / 1000;
    const rate = d.netBytes > 0 && seconds > 0 ? d.netBytes / seconds : 0;
    const eta = left <= 0.001 * d.total ? 0 : rate ? left / rate : Infinity;
    const text = `${megabytes(d.bytes)} of ${megabytes(d.total)} MB in at ready, ${megabytes(d.netBytes)} MB from the network`
      + (rate ? ` at ${(rate * 8 / 1e6).toFixed(0)} Mbit/s` : '') + (eta > 0 ? `, ${eta === Infinity ? 'no rate' : eta.toFixed(1) + ' s'} to go` : '');
    console.log('PAGE HOLD download: ' + text);
    return eta > 0.5 ? text : '';
  }
  function release(why) {
    if (!proceed) return;
    const next = proceed;
    proceed = null;
    clearTimeout(timer);
    console.log(`PAGE HOLD released ${why} ${Math.round(performance.now() - readyAt)} ms after ready`);
    next();
  }
  function announce(ms) {
    if (proceed || readyAt) return;   // announced after ready: too late to hold
    capMs = Math.max(0, Number(ms) || 0);
  }
  function settle(text) {
    settled = text || 'settled';
    release(settled);
  }
  window.addEventListener('ue-hold', (e) => announce(e.detail && e.detail.capMs));
  window.addEventListener('ue-settled', (e) => settle(e.detail && e.detail.reason));
  return {
    // 'UE_RUN HOLD <cap ms>' and 'UE_RUN SETTLED <held ms> <reason>' (wasm-loader.js print)
    line(t) {
      const hold = /UE_RUN HOLD (\d+)/.exec(t);
      if (hold) announce(hold[1]);
      const done = /UE_RUN SETTLED (\d+) (\w+)/.exec(t);
      if (done) settle(done[2]);
    },
    begin(next) {
      readyAt = performance.now();
      if (mode === 'off' || mode === '0' || capMs === null || capMs === 0 || settled) { next(); return; }
      const pending = mode === 'always' ? '' : downloadPending();
      if (pending) { console.log('PAGE HOLD skipped: the download is not in (' + pending + ')'); next(); return; }
      proceed = next;
      console.log(`PAGE HOLD start: the engine holds up to ${capMs} ms`);
      if (!harness) $('progress-text').textContent = T('Ready: preparing shaders...');
      timer = setTimeout(() => release('page cap'), capMs + 1000);
    },
  };
})();
// The game's own ready signal. By default (<meta name="ue-ready" content="engine">) the engine's ready marker lifts the cover. A
// game whose first playable moment comes later (its own loading screen, a streamed level, a menu that builds after the first
// frame) sets "game": the engine's marker then starts a wait of at most ue-ready-wait seconds (default 60) for the game's signal,
// and the cover lifts on the signal, or on the engine's marker when the wait runs out (a PAGE READY fallback line). A game can
// also ask for the wait itself before the engine's marker: window.ue.expectGameReady(), or the log line UE_RUN GAME_READY_EXPECTED.
// The signal: window.ue.gameReady() on the page's main thread (from the engine: MAIN_THREAD_ASYNC_EM_ASM), the event
// 'ue-game-ready', or the log line UE_RUN GAME_READY (wasm-loader.js print). ?ready=engine|game overrides the meta
const readySignal = (() => {
  const mode = String(query.get('ready') ?? pageMeta('ue-ready', 'engine')).trim();
  const waitMs = Math.max(0, Number(pageMeta('ue-ready-wait', '60')) || 60) * 1000;
  let expected = mode === 'game';
  let engineAt = 0, timer = 0, signalled = false;
  return {
    expect() {
      if (expected || ready || engineAt) return;
      expected = true;
      console.log('PAGE READY the game will signal it is ready');
    },
    // the engine's marker: true when the page should go on to the ready state now
    engine() {
      if (!expected || signalled) return true;
      if (!engineAt) {
        engineAt = performance.now();
        console.log(`PAGE READY engine marker: waiting for the game's signal (at most ${waitMs / 1000} s)`);
        timer = setTimeout(() => {
          console.log(`PAGE READY fallback: no game signal ${waitMs / 1000} s after the engine marker`);
          readyNow();
        }, waitMs);
      }
      return false;
    },
    signal() {
      if (signalled || ready || failed) return;
      if (!expected) {
        // ue-ready engine (the default), and no expectGameReady(): the engine's marker alone lifts the cover, as before
        console.log('PAGE READY game signal ignored: the page waits for the engine marker (ue-ready engine)');
        return;
      }
      signalled = true;
      clearTimeout(timer);
      console.log('PAGE READY game signal ' + (engineAt ? Math.round(performance.now() - engineAt) + ' ms after the engine marker' : 'before the engine marker'));
      readyNow();
    },
  };
})();
// The game is ready (the engine's marker; with ue-ready=game, the game's signal): the last line, then the cover lifts (at once, or
// on the player's click with ue-start=click), after the engine's pipeline hold when it announced one
function gameReady() {
  if (ready || failed) return;
  if (!readySignal.engine()) return;
  readyNow();
}
function readyNow() {
  if (ready || failed) return;
  ready = true;
  coverTo('ready');
  if (siteTimer) clearInterval(siteTimer);
  ueSteps.set('site', 'done', ueSteps.took('site'));
  ueSteps.finish('download');
  $('progress-text').textContent = T(startOnClick ? 'Ready: click to play' : 'Ready');
  if (cover.setAttribute) cover.setAttribute('aria-busy', 'false');
  progressBar(1);
  document.body.dataset.ready = '1';
  pipelineHold.begin(readyProceed);
}
function readyProceed() {
  if (failed || coverState === 'ended') return;   // a hold that ends after the game did must not hide the end card
  if (harness) { lifted = true; showToast(); return; }
  $('progress-text').textContent = T(startOnClick ? 'Ready: click to play' : 'Ready');
  if (startOnClick) {
    coverTo('click');
    cover.classList.add('click');
    const start = () => {
      resumeAudio();
      if (window.Module && Module.ueWebPage) Module.ueWebPage.lock();
      liftCover();
    };
    cover.addEventListener('click', start, { once: true });
    // The keyboard starts it too (the cover takes the focus; Enter or Space)
    if (cover.setAttribute) cover.setAttribute('tabindex', '0');
    if (cover.focus) cover.focus();
    cover.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); start(); } });
    return;
  }
  liftCover();
}
// The intro-shell slot. A project script (index.html <meta name="ue-shell" content="shell.js">, staged through the
// project's Build/Wasm/Template) plays something of its own while the engine boots and hands over when the game is ready:
//   ue.shell.register({ show(container) { ... }, handoff() { return a Promise }, hideLoader: true });
// show() gets the cover's #shell element (the default art is hidden); hideLoader hides the steps and the bar; at ready the
// page calls handoff() and lifts the cover when it resolves (at most 3 s later). Arguments for the engine go in
// window.ueExtraArgs before the game starts. The shell's events are PAGE SHELL lines
const ueShell = (() => {
  let shell = null;
  let handedOff = false;
  return {
    register(s) {
      if (shell || lifted || failed || !s) return false;
      shell = s;
      console.log('PAGE SHELL registered ' + Math.round(performance.now()));
      try {
        // only the default art (background, title) goes; #art also holds the bar and the notices, which stay
        // unless the shell asks (hideLoader)
        $('art').classList.add('shell');
        if (s.hideLoader) { $('steps').hidden = true; $('loader').hidden = true; }
        if (s.show) s.show($('shell'));
      } catch (e) { console.log('PAGE SHELL show failed: ' + e); }
      return true;
    },
    get active() { return !!shell; },
    get handedOff() { return handedOff; },
    async handoff() {
      if (!shell || handedOff) return;
      handedOff = true;
      const t0 = performance.now();
      try {
        if (shell.handoff) await Promise.race([Promise.resolve(shell.handoff()), new Promise((r) => setTimeout(r, 3000))]);
      } catch (e) { console.log('PAGE SHELL handoff failed: ' + e); }
      console.log('PAGE SHELL handoff ' + Math.round(performance.now() - t0) + ' ms');
    },
  };
})();
window.ue = window.ue || {};
window.ue.shell = ueShell;
window.ue.gameReady = () => readySignal.signal();
window.ue.expectGameReady = () => readySignal.expect();
window.addEventListener('ue-game-ready', () => readySignal.signal());

// (The cover lifted onto an empty canvas for 0.3-0.7 s; frame 1 presents before anything drew): the
// WebGPU RHI fires ue-first-canvas-frame on the first frame it copies to the canvas, and the cover waits for it, at most 3 s past
// the ready signal, so a build without the event still lifts
let canvasFrame = false, liftWaiting = false;
window.addEventListener('ue-first-canvas-frame', () => {
  canvasFrame = true;
  console.log('LOADTIME first_canvas_frame ' + Math.round(performance.now()));
  if (liftWaiting) liftCover(true);
});
function liftCover(force) {
  if (lifted || failed) return;
  if (!canvasFrame && force !== true) {
    if (!liftWaiting) { liftWaiting = true; setTimeout(() => liftCover(true), 3000); }
    return;
  }
  if (ueShell.active && !ueShell.handedOff) { ueShell.handoff().then(() => liftCover(true)); return; }
  lifted = true;
  coverTo('lifted');
  cover.classList.remove('click');
  cover.classList.add('lifting');
  setTimeout(() => { if (!failed) cover.hidden = true; }, 600);
  if (hintKeys.length) {
    hint.hidden = false;
    hint.classList.add('fresh');   // a few pulses so the player sees the keys
  }
  showToast();
  $('canvas').focus();
}
// Old name of gameReady() (scripts written for the previous page call it)
const coverReady = gameReady;
let logPrinting = false;   // wasm-loader.js sets it at the first printed line
const readyEvent = () => {
  if (!logPrinting) gameReady();
  else setTimeout(gameReady, 65000);   // the ready line should follow; the longest a cover waited for it was 60 s (Firefox)
};
for (const name of ['ue-ready', 'ue-site-ready', 'ue-interactive']) window.addEventListener(name, readyEvent);

// Sound: an AudioContext made before a gesture starts suspended (the autoplay rules). The first click, key or touch anywhere
// resumes it; the hint says so while it waits. A return visit that the browser trusts plays at once
function audioContext() { return window.Module && Module.ueAudioContext; }
function resumeAudio() {
  const context = audioContext();
  if (context && context.state !== 'running') context.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, resumeAudio, { capture: true });

// The key hint from <meta name="ue-hint" content="Esc=Menu;Tab=Controls"> (none by default). A game that installs
// Module.ueWebPage and sets wanted=false (its menu is open) shows only the first key's entry ("Back to the game" for Esc)
const hintKeys = pageMeta('ue-hint').split(';').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf('='); return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s, '']; });
(() => {
  const keys = $('hint-keys');
  for (const [key, label] of hintKeys) {
    const span = document.createElement('span');
    span.className = 'key';
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    span.appendChild(kbd);
    span.appendChild(document.createTextNode(label));
    keys.appendChild(span);
  }
})();
setInterval(() => {
  // no key hints (ue-hint empty, the template default): the plate shows only the sound prompt, while the game plays
  const context = audioContext();
  const suspended = !!(context && context.state === 'suspended');
  if (!hintKeys.length) hint.hidden = !(suspended && lifted && !failed && !recovering && coverState !== 'ended');
  if (hint.hidden) return;
  const page = window.Module && Module.ueWebPage;
  const inMenu = !!(page && !page.wanted);
  const spans = $('hint-keys').children;
  for (let i = 0; i < spans.length; i++) {
    spans[i].hidden = inMenu && i > 0;
    if (i === 0 && spans[i].lastChild) spans[i].lastChild.textContent = inMenu ? 'Back to the game' : hintKeys[0][1];
  }
  $('hint-sound').hidden = !suspended;
}, 150);   // 150 ms: at 500 ms the text lagged the game's menu by 0.4-0.9 s

// Tab reaches the game: without a fullscreen keyboard lock the browser's default for Tab moves the focus off the canvas. While
// the game plays, the page cancels that default; the key still reaches the game's listeners. ?tab=browser leaves Tab alone
window.addEventListener('keydown', (event) => {
  if (query.get('tab') === 'browser') return;
  if (lifted && !failed && event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) event.preventDefault();
}, { capture: true });

// The gesture a player's first click gives, for scripted checks (Runtime.evaluate with userGesture)
window.uePage = {
  gesture() {
    resumeAudio();
    $('canvas').focus();
    if (window.Module && Module.ueWebPage) Module.ueWebPage.lock();
    return true;
  },
};

$('reload').addEventListener('click', () => location.reload());
$('again').addEventListener('click', () => location.reload());
$('log').addEventListener('click', async () => {
  // UE's log lives in OPFS (Saved/Logs/<Project>.log, lowercased by the icase backend), unless Saved is in memory. A page that stopped before the game ran
  // (an unsupported browser) has none: the file is then the card's message and the page's own log (index.html pageLog), with a
  // line that says so instead of the storage error. The page's address goes without its query (it can carry ?args= and tokens).
  // The engine names its file in globalThis.ueLogFile: <Project>_2.log when another tab of this site holds <Project>.log
  const name = (window.ueLogFile || (pageMeta('ue-project') || 'game') + '.log').toLowerCase();
  let game = '';
  let why = '';
  try {
    const root = await navigator.storage.getDirectory();
    const logs = await (await root.getDirectoryHandle('logs')).getFileHandle(name);
    game = await (await logs.getFile()).text();
  } catch (e) {
    // No OPFS log: the game never started, or it did and keeps Saved in memory (?saved=memory, iOS), out of the page's reach
    why = e && e.name === 'NotFoundError'
      ? (engineRan ? 'The game\'s log is kept in memory in this browser (Saved is in memory: iOS, or ?saved=memory), so the page cannot read it.'
        : 'The game did not start, so it wrote no log of its own.')
      : 'The game\'s log could not be read (' + e + ').';
  }
  const text = [(document.title || name) + ', ' + new Date().toISOString() + ', ' + location.origin + location.pathname, navigator.userAgent, '',
    'The game stopped: ' + $('error-text').textContent, '']
    .concat(game ? ['== The game\'s log', game, ''] : [why, ''])
    // (the page's lines masked as an error report's are: no command line, queries or token-like runs)
    .concat(['== The page\'s log (seconds since the page opened)'], typeof pageLog !== 'undefined' ? pageLog.map(redactLine) : []).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  link.download = name;
  link.click();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
});
