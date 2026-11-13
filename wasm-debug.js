// The page's debug overlay, loaded only with ?debug=1 (index.html). A panel at the bottom right: frame rate and
// the worst frame of the last second, the cover's state, the load marks (LOADTIME), the wasm memory, the last engine lines,
// and the service worker's state (/__sw). Ctrl+Alt+D hides and shows it. Nothing here runs on a normal load.
(() => {
  const panel = document.createElement('div');
  panel.id = 'ue-debug';
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9;max-width:min(520px,calc(100vw - 16px));max-height:60vh;overflow:auto;'
    + 'background:#000c;color:#d8f0d8;font:12px/1.35 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:6px;white-space:pre-wrap;pointer-events:auto';
  document.body.appendChild(panel);
  const frames = [];
  let last = 0;
  const tick = (t) => {
    if (last) frames.push(t - last);
    last = t;
    while (frames.length > 240) frames.shift();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let sw = '';
  const refreshSw = async () => {
    try { sw = JSON.stringify(await (await fetch('__sw', { cache: 'no-store' })).json()).slice(0, 400); } catch (e) { sw = 'no worker (' + e + ')'; }
  };
  // An ASSERTIONS build puts an aborting getter on Module for each unexported runtime symbol, so read data properties only
  const own = (m, name) => { const d = m && Object.getOwnPropertyDescriptor(m, name); return d && 'value' in d ? d.value : undefined; };
  const memory = () => {
    const m = window.Module;
    const heap = own(m, 'HEAPU8'), wasmMemory = own(m, 'wasmMemory');
    const bytes = heap ? heap.length : (wasmMemory && wasmMemory.buffer ? wasmMemory.buffer.byteLength : 0);
    return bytes ? (bytes / 1048576).toFixed(0) + ' MiB' : 'n/a';
  };
  const render = () => {
    const recent = [];
    let sum = 0;
    for (let i = frames.length - 1; i >= 0 && sum < 1000; i--) { recent.push(frames[i]); sum += frames[i]; }
    const fps = sum ? (recent.length * 1000 / sum).toFixed(1) : '-';
    const worst = recent.length ? Math.max(...recent).toFixed(1) : '-';
    const marks = Object.entries((window.__harness && window.__harness.timings) || {}).map(([k, v]) => k + ' ' + v).join('  ');
    const lines = (typeof engineLines !== 'undefined' ? engineLines : []).slice(-8).join('\n');
    panel.textContent = `UE debug (Ctrl+Alt+D)\nfps ${fps}  worst ${worst} ms  cover ${typeof coverState !== 'undefined' ? coverState : '?'}  wasm ${memory()}\n`
      + `marks ${marks}\nsw ${sw}\n--- engine\n${lines}`;
  };
  setInterval(render, 500);
  setInterval(refreshSw, 5000);
  refreshSw();
  render();
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) panel.hidden = !panel.hidden;
  }, { capture: true });
  console.log('PAGE DEBUG overlay on');
  window.ueDebug = { panel, render };
})();
