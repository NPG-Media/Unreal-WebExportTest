// The device profile. A classic script that index.html loads before the other page scripts and before the game's script. It sets
// window.ueProfile, which wasm-loader.js applies when it builds the engine's Module, and which the link's pthread pool expression
// reads (WasmTargetRules.cs PthreadPoolSize: the profile's pool first, else the link's own rule):
//   name    'ios' on iPhone and iPad (an iPad in desktop mode sends a Mac user agent with touch points), 'android' on Android
//           phones and tablets, 'desktop' elsewhere; ?profile=ios|android|desktop forces one (to try a profile on a desktop).
//           An iPhone or iPad always keeps 'ios': another profile there would drop the iOS safeguards (the single-threaded
//           engine, the small pthread pool) and could take more memory than the tab may use, so ?profile= is refused (logged)
// A profile's settings come from <meta name="ue-profile-<name>" content="memory=1536/1024 pool=32 fps=30">, empty by default, so
// nothing changes (the link's memory and pool, frames at the display's rate):
//   memory  a fixed wasm memory in MB (initial = maximum, so it never grows: some browsers' shared memory growth is unreliable
//           with threads); a list (1536/1280/1024) tries each size in turn when the browser will not reserve one (a 32-bit
//           browser's address space), and the link's own memory when it reserves none. A size must lie in the link's range
//           (-WasmInitialMemoryMB to -WasmMaximumMemoryMB) and the glue must take it (wasmMemory in INCOMING_MODULE_JS_API,
//           WasmToolChain.cs): the loader sets it only on a game script that does not refuse it
//   pool    the pthread pool's size, in place of the link's expression
//   audio   audio=thread: one audio thread for the single-threaded engine (iOS, below)
//   fps     a frame cap: the lower of it and the display's rate becomes a ceiling on the game's frame rate (-WebFrameRateLimit=: the
//           engine's page bridge holds t.MaxFPS at or below it, so later settings updates cannot lift it; a lower limit stays)
// and <meta name="ue-args-<name>"> has the profile's engine arguments (a device profile with -dp=, a starting resolution).
// audioThread: on iOS, where the engine runs without threads, one pthread of its own renders and plays the sound
// (-WebAudioThread, AudioMixerWebAudio.cpp), so it plays on through long frames; the link's iOS pool grows by one for it.
// ?audiothread=1|0, else <meta name="ue-audio-thread" content="1"> (UAT: bSingleThreadedAudioThread), else the profile's audio=thread.
// Not with ?threads=1 (a threaded engine has its own audio threads)
// applyMemory(Module) gives the loader's Module the fixed memory; describe() is the PAGE PROFILE line
(() => {
  const query = new URLSearchParams(location.search);
  const ua = navigator.userAgent || '';
  const appleTouch = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = !appleTouch && (/Android/.test(ua) || !!(navigator.userAgentData && navigator.userAgentData.platform === 'Android'));
  const asked = query.get('profile');
  const forced = asked === 'ios' || asked === 'android' || asked === 'desktop' ? (appleTouch && asked !== 'ios' ? null : asked) : null;
  // Refusals are logged now, for the page's own log (the error card's download), and named again in describe(), which the
  // loader prints once the page's log reaches a UAT or Launch On session
  const askRefused = appleTouch && asked && asked !== 'ios'
    ? ` (?profile=${asked} refused: an iPhone or iPad keeps the ios profile, single-threaded engine and small pthread pool)` : '';
  if (askRefused) console.log('PAGE PROFILE' + askRefused);
  const name = forced || (appleTouch ? 'ios' : android ? 'android' : 'desktop');
  const meta = document.querySelector('meta[name=ue-profile-' + name + ']');
  const text = meta && meta.content && !meta.content.includes('%') ? meta.content : '';
  const settings = new Map(text.split(/\s+/).filter(Boolean).map((pair) => pair.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.toLowerCase(), v]));
  const whole = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  // the pool's size: a whole number from 1 to 128, the test the link's expression applies (WasmTargetRules.cs PthreadPoolSize)
  let poolRefused = null;
  const pool = (v) => {
    const n = whole(v);
    if (v !== undefined && !(n && n <= 128)) {
      poolRefused = v;
      console.log('PAGE PROFILE (pool=' + v + ' refused: not a whole number from 1 to 128)');
    }
    return n && n <= 128 ? n : null;
  };
  // MB to 64 KiB pages; applyMemory caps a size at 4 GiB for a build whose Memory64 was lowered (the most 32-bit addresses map),
  // a 64-bit memory takes larger sizes up to what the browser reserves
  const memoryPages = (settings.get('memory') || '').split('/').map(whole).filter(Boolean).map((mb) => mb * 16);
  const audioAsked = query.get('audiothread');
  const audioMeta = document.querySelector('meta[name=ue-audio-thread]');
  // ?audiothread= first, then the project's setting (a staged 0 is an explicit off), then the device profile's audio=thread
  const audioMetaValue = audioMeta ? audioMeta.content.trim() : '';
  const audioWanted = audioAsked === '1' || (audioAsked !== '0'
    && (audioMetaValue === '1' || (audioMetaValue !== '0' && settings.get('audio') === 'thread')));
  const profile = {
    name,
    forced: !!forced,
    memoryPages,
    poolSize: pool(settings.get('pool')),
    fps: whole(settings.get('fps')),
    audioThread: name === 'ios' && query.get('threads') !== '1' && audioWanted,
    reserved: 0,   // the pages applyMemory reserved (0: the link's own memory)
  };
  profile.configured = memoryPages.length > 0 || !!profile.poolSize || !!profile.fps || poolRefused !== null || !!askRefused || profile.audioThread;
  profile.describe = () => `PAGE PROFILE ${name}${profile.forced ? ' (forced)' : ''} memory=${profile.reserved ? (profile.reserved / 16) + ' MB fixed' : 'link default'}`
    + ` pool=${profile.poolSize || 'link default'}${poolRefused !== null ? ` (pool=${poolRefused} refused: not a whole number from 1 to 128)` : ''}`
    + ` fps=${profile.fps || 'display rate'}${askRefused}${profile.audioThread ? ' audio=thread' : ''}`;
  // Module.wasmMemory, shared (the build has threads), 64-bit addressed unless the build's Memory64 was lowered at link
  profile.applyMemory = (Module, options) => {
    if (!memoryPages.length) return false;
    const index64 = !(options && options.lowered);
    for (const asked of memoryPages) {
      const pages = index64 ? asked : Math.min(65536, asked);
      try {
        Module.wasmMemory = new WebAssembly.Memory(index64
          ? { initial: BigInt(pages), maximum: BigInt(pages), shared: true, address: 'i64' }
          : { initial: pages, maximum: pages, shared: true });
        profile.reserved = pages;
        // Recorded with the memory, for the engine's heap ceiling (WasmPlatformMemory.cpp uses it only while this memory is the
        // one the module runs in). A property of the page's own: an ASSERTIONS glue makes Module.wasmMemory a getter that aborts
        Module.ueFixedMemory = { memory: Module.wasmMemory, pages };
        return true;
      } catch (e) {
        console.log('PAGE PROFILE memory ' + (pages / 16) + ' MB refused: ' + e);
      }
    }
    return false;
  };
  window.ueProfile = profile;
})();
