/* ==========================================================================
   Cueline — teleprompter
   --------------------------------------------------------------------------
   Scrolling model
     The text column is padded so y = 0 puts the first line exactly on the
     reading line and y = maxY puts the last line there, so maxY is just the
     natural height of the text. Speed comes from words per minute:

         pxPerWord = textHeight / totalWords
         velocity  = (wpm / 60) * pxPerWord          px per second

     which makes the wpm number literally true end to end: 700 words at
     140 wpm takes five minutes, whatever the font size or column width.

   Everything lives in localStorage. There is no server.
   ========================================================================== */

'use strict';

const { parse, formatClock } = window.CuelineScript;

const $ = (id) => document.getElementById(id);
const escapeText = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ state */

const STORE_KEY = 'cueline.v1';

const WELCOME = `# Cueline

This is the reading surface. Text scrolls past the marked line while you look
into the camera, so your audience sees you address them rather than read to
them.

> Lines beginning with a chevron are notes to yourself. They are dimmed, never
> spoken, and never counted toward the timing.

Lines break where a phrase breaks, / not where the column runs out, so the shape
of a sentence is visible before you reach it. // A single slash marks a breath.
A double slash marks a full stop. Both are charged to the running time, because
silence is time.

Wrap a phrase in double equals to mark it as a word to hit: this proposal is
==not a request for more funding==. Put a respelling in braces after a name you
must not fumble — Kyrgyzstan{KEER-gih-STAN} — and it is set above the word,
shown but never spoken. [Square brackets hold a direction to yourself.]

Set a target length above the script and the pace field reports your drift
against it as you speak. Speed is stated in words per minute, so the figure
means something exact: seven hundred words at 140 wpm runs five minutes,
whatever the type size or the width of the column.

---

# Screen sharing

Share a window, or a single browser tab. Not the entire screen.

A web page cannot exclude itself from screen capture; only a native application
can. A window share carries only the window you nominate, so the floating
prompter stays private. An entire-screen share carries everything on it.

# Voice follow

With voice follow enabled the script follows you rather than a clock. Speak,
and the line you are saying holds the reading line. Pause, take a question, or
leave the text altogether — it waits, and picks you up when you return.

> Replace this with your own script when you are ready.
`;

const DEFAULTS = {
  wpm: 140,
  fontSize: 34,
  lineHeight: 1.45,
  weight: 600,
  paddingX: 44,
  fontFamily: 'system',
  align: 'left',
  measureEm: 17,
  flip: false,
  background: 'dim',
  emphasis: 'strong',
  senseLines: true,
  lookaheadSeconds: 2.8,
  focusWord: false,
  readingLine: 0.38,
  focusBand: true,
  showMarks: true,
  dimSpent: true,
  mirror: false,
  countdown: 3,
  voiceMode: 'off', // 'off' | 'pace' | 'words'
  voiceLang: '',
  micDeviceId: '',
  micSensitivity: 9,
  pipW: 720,
  pipH: 300,
  hideBar: false,
  editorHidden: false,
};

function loadStore() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    raw = null;
  }
  const seed = {
    settings: { ...DEFAULTS },
    scripts: [{ id: 's1', name: 'Welcome / demo', text: WELCOME, targetMin: 0 }],
    activeId: 's1',
    seenHelp: false,
    preflightDone: false,
  };
  if (!raw || !Array.isArray(raw.scripts) || !raw.scripts.length) return seed;
  return {
    settings: { ...DEFAULTS, ...(raw.settings || {}) },
    scripts: raw.scripts,
    activeId: raw.scripts.some((s) => s.id === raw.activeId) ? raw.activeId : raw.scripts[0].id,
    seenHelp: !!raw.seenHelp,
    preflightDone: !!raw.preflightDone,
  };
}

const db = loadStore();
let saveTimer = null;
let saveFailed = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      saveFailed = false;
    } catch {
      // Private mode, or quota. The session still works, but silently losing
      // persistence is not something to discover after the fact.
      if (!saveFailed) {
        saveFailed = true;
        notify(
          '<b>Your work is no longer being saved in this browser.</b> Storage is full or ' +
            'blocked. Copy your script somewhere safe before closing this tab.',
          'warn',
          0
        );
      }
    }
  }, 200);
}

const S = db.settings;
const active = () => db.scripts.find((s) => s.id === db.activeId) || db.scripts[0];

/* --------------------------------------------------------------- runtime */

let doc = parse('');
/** Flat list of spoken words, index-aligned with block.wordsBefore. */
let wordList = [];
let y = 0;
let layout = { textHeight: 0, maxY: 0, readingPx: 0, tops: [], heights: [] };
let playing = false;
/*
 * Run clock.
 *
 * This counts time spent ROLLING, not wall-clock time since you first pressed
 * play. It used to be wall clock, which meant that stopping for a ninety second
 * audience question told you — in warning orange — that you were ninety seconds
 * behind, when your delivery speed had not changed at all. The one number a
 * presenter has to trust under pressure cannot behave like that. Pausing pauses
 * the clock, exactly like a stopwatch.
 */
let runAccumMs = 0;
let runResumedAt = null;
const runElapsed = () =>
  (runAccumMs + (runResumedAt ? Date.now() - runResumedAt : 0)) / 1000;
const runStarted = () => runAccumMs > 0 || runResumedAt !== null;
let countingDown = false;
let pipWindow = null;
let lastFrame = 0;
/** The control bar withdraws a couple of seconds into a roll. */
let barIdle = false;
let barTimer = null;
/** Actual scroll speed, eased toward S.wpm so speed changes are not a jolt. */
let rampWpm = db.settings.wpm;

/**
 * First-order smoothing time constants, in seconds. approach() is
 * unconditionally stable, cannot overshoot, and gives an identical approach
 * shape at any refresh rate — which matters here because the floating window
 * and this page can sit on displays running at different rates.
 */
const TAU = { wpm: 0.28, voice: 0.22 };
const approach = (x, target, tau, dt) => x + (target - x) * (1 - Math.exp(-dt / tau));

/* ------------------------------------------------------------------ nodes */

const prompter = $('prompter');
const host = $('prompter-host');

/**
 * Everything inside #prompter is cached by reference, because the whole
 * subtree gets moved into the floating window's document — after which
 * document.getElementById() would no longer find any of it.
 */
const P = {
  viewport: $('p-viewport'),
  content: $('p-content'),
  empty: $('p-empty'),
  play: $('p-play'),
  playIcon: prompter.querySelector('#p-play .i-play'),
  pauseIcon: prompter.querySelector('#p-play .i-pause'),
  wpm: $('p-wpm'),
  left: $('p-left'),
  pace: $('p-pace'),
  mic: $('p-mic'),
  countdown: $('p-countdown'),
  countN: $('p-count-n'),
  bar: $('p-bar'),
  slower: $('p-slower'),
  faster: $('p-faster'),
  restart: $('p-restart'),
  prev: $('p-prev'),
  next: $('p-next'),
  paceNum: $('p-pace-num'),
  countRing: null,
};

const pViewport = P.viewport;
const pContent = P.content;
const pEmpty = P.empty;

/* ==========================================================================
   Rendering and measurement
   ========================================================================== */

function normalize(w) {
  return w
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function buildWordList() {
  wordList = [];
  doc.blocks.forEach((b) => {
    if (!b.words) return;
    const toks = b.text
      .replace(/==/g, '')
      .replace(/\*/g, '')
      .split(/\s+/)
      .filter((t) => /[\p{L}\p{N}]/u.test(t));
    toks.forEach((t, i) => {
      wordList.push({ norm: normalize(t), block: b.index, index: b.wordsBefore + i });
    });
  });
}

function renderScript() {
  const s = active();
  doc = parse(s.text);
  buildWordList();

  pContent.innerHTML = doc.blocks
    .map((b) => {
      switch (b.type) {
        case 'h':
          return `<div class="blk h" data-i="${b.index}"><span>${b.html}</span></div>`;
        case 'cue':
          return `<div class="blk cue" data-i="${b.index}">${b.html}</div>`;
        case 'rule':
          return `<div class="blk rule" data-i="${b.index}"></div>`;
        case 'li':
          return `<div class="blk li" data-i="${b.index}" data-marker="${b.marker || '•'}">${b.html}</div>`;
        case 'empty':
          return '';
        default:
          return `<div class="blk p" data-i="${b.index}">${b.html}</div>`;
      }
    })
    .join('');

  // Word elements are cached once per render. Highlighting then costs two
  // class toggles per change rather than a query per frame.
  wordEls = Array.from(pContent.querySelectorAll('w[data-w]'));
  litWord = -1;

  pEmpty.hidden = doc.totalWords > 0 || doc.blocks.some((b) => b.type !== 'empty');
  measure();
  renderScrubMarks();
  renderStats();
}

function measure() {
  const vh = pViewport.clientHeight;
  const readingPx = Math.round(vh * S.readingLine);

  pContent.style.paddingTop = readingPx + 'px';
  pContent.style.paddingBottom = Math.max(0, vh - readingPx) + 'px';

  const tops = [];
  const heights = [];
  pContent.querySelectorAll('.blk').forEach((n) => {
    const i = Number(n.dataset.i);
    tops[i] = n.offsetTop;
    heights[i] = n.offsetHeight;
  });

  const textHeight = Math.max(
    0,
    pContent.offsetHeight - readingPx - Math.max(0, vh - readingPx)
  );
  layout = { textHeight, maxY: textHeight, readingPx, tops, heights };

  /*
   * Guarantee the look-ahead.
   *
   * The eye runs ahead of the voice to the end of the current phrase and then
   * waits, so full-brightness text below the reading line is not decoration —
   * it is the input to the next intonation and breath decision. Sizing it as a
   * fixed multiple of the line height meant the guarantee silently varied with
   * type size, window height and speed. It is now expressed in the only unit
   * that means anything here: seconds of speech at the current rate.
   */
  const perWord = doc.totalWords && textHeight ? textHeight / doc.totalWords : 0;
  const pxPerSecond = perWord ? (S.wpm / 60) * perWord : 0;
  const lineH = S.fontSize * S.lineHeight;
  const room = Math.max(0, vh - readingPx - 44);
  const wanted = pxPerSecond * S.lookaheadSeconds;
  const plateau = clamp(wanted || lineH * 2.4, Math.min(lineH * 1.6, room), room);
  layout.lookaheadSeconds = pxPerSecond ? plateau / pxPerSecond : 0;
  prompter.style.setProperty('--plateau', readingPx + plateau + 'px');
  y = clamp(y, 0, layout.maxY);
  paint();
}

/**
 * Paint is one property write per frame and nothing else.
 *
 * Dimming already-spoken text used to be a class toggle across every block on
 * every frame — O(blocks) of layout reads at 60fps, and it dimmed a whole
 * paragraph at a time, so the fade jumped a block at a time instead of tracking
 * the line you are on. It is now a mask on the viewport-sized layer, which is
 * exact to the pixel, free at run time, and works over a transparent backdrop.
 */
function paint() {
  pContent.style.transform = `translate3d(0, ${-y}px, 0)`;
}

/** Cached <w> elements, index-aligned with the global word index. */
let wordEls = [];
let litWord = -1;

/** Light exactly one word. Called every frame, so it must stay this cheap. */
function highlightWord(i) {
  if (i === litWord) return;
  if (wordEls[litWord]) wordEls[litWord].classList.remove('now');
  if (i >= 0 && wordEls[i]) wordEls[i].classList.add('now');
  litWord = i;
}

/* ------------------------------------------------------- position ↔ words */

const pxPerWord = () =>
  doc.totalWords && layout.textHeight ? layout.textHeight / doc.totalWords : 0;

const velocityFor = (wpm) => (pxPerWord() ? (wpm / 60) * pxPerWord() : 0);
/** What the scroll is doing right now (mid-ramp). */
const velocity = () => velocityFor(rampWpm);
/** What the readouts should quote — the speed you asked for, so the time
 *  remaining does not wobble while the ramp settles. */
const settledVelocity = () => velocityFor(S.wpm);

function blockAt(scrollY) {
  const line = scrollY + layout.readingPx;
  let found = 0;
  for (let i = 0; i < layout.tops.length; i++) {
    if (layout.tops[i] === undefined) continue;
    if (layout.tops[i] <= line) found = i;
    else break;
  }
  return found;
}

function yForBlock(i) {
  const top = layout.tops[i];
  return top === undefined ? y : clamp(top - layout.readingPx, 0, layout.maxY);
}

function currentWord() {
  const i = blockAt(y);
  const b = doc.blocks[i];
  if (!b) return 0;
  const h = layout.heights[i] || 1;
  const within = clamp((y + layout.readingPx - (layout.tops[i] || 0)) / h, 0, 1);
  return b.wordsBefore + within * b.words;
}

/**
 * Position of a spoken word. Only blocks that actually contain words are
 * candidates, so the zero-word blocks that share a wordsBefore value with the
 * paragraph after them (headings, cues, rules) can never be selected.
 */
function yForWord(w) {
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (b.words > 0 && w < b.wordsBefore + b.words) {
      const frac = clamp((w - b.wordsBefore) / b.words, 0, 1);
      const top = (layout.tops[i] || 0) + frac * (layout.heights[i] || 0);
      return clamp(top - layout.readingPx, 0, layout.maxY);
    }
  }
  return layout.maxY;
}

/**
 * Where the reader is, expressed structurally: which block is on the reading
 * line and how far into it. Unlike a word index this is exact for every block
 * type, so re-measuring cannot silently move the script.
 */
function captureAnchor() {
  const i = blockAt(y);
  const h = layout.heights[i] || 1;
  return { block: i, frac: clamp((y + layout.readingPx - (layout.tops[i] || 0)) / h, 0, 1) };
}

function restoreAnchor(a) {
  if (!a || layout.tops[a.block] === undefined) return;
  const top = layout.tops[a.block] + a.frac * (layout.heights[a.block] || 0);
  y = clamp(top - layout.readingPx, 0, layout.maxY);
}

/* ==========================================================================
   Transport
   ========================================================================== */

async function setPlaying(next) {
  if (next === playing) return;
  if (next && layout.maxY <= 0) return;

  playing = next;
  if (playing) {
    runResumedAt = null; // stamped after the countdown, below
  } else if (runResumedAt) {
    runAccumMs += Date.now() - runResumedAt;
    runResumedAt = null;
  }

  // In a voice mode, "go" means "start listening", not "start the clock".
  if (S.voiceMode === 'words') {
    if (playing) voiceStart();
    else voiceStop();
  } else if (S.voiceMode === 'pace') {
    if (playing) vadStart();
    else vadStop();
  }

  wakeBar();
  syncPlayButtons();

  if (playing && y < 2 && S.countdown > 0) {
    countingDown = true;
    P.countdown.hidden = false;
    for (let i = S.countdown; i >= 1; i--) {
      P.countN.textContent = String(i);
      P.countN.style.animation = 'none';
      void P.countN.offsetWidth;
      P.countN.style.animation = '';
      await new Promise((r) => setTimeout(r, 720));
      if (!playing) break;
    }
    P.countdown.hidden = true;
    countingDown = false;
  }

  // Only now does the script actually move, so only now does the clock start.
  if (playing && !runResumedAt) runResumedAt = Date.now();
}

function togglePlay() {
  setPlaying(!playing);
}

function setBarIdle(next) {
  if (barIdle === next) return;
  barIdle = next;
  prompter.classList.toggle('bar-idle', next);
}

/** Called on pointer movement over the prompter, and whenever we roll. */
function wakeBar() {
  setBarIdle(false);
  clearTimeout(barTimer);
  if (playing) barTimer = setTimeout(() => setBarIdle(true), 2200);
}

/* --------------------------------------------------------------- gliding */

/**
 * Seeks and section jumps travel rather than teleport. A cut makes you lose
 * your place; a short eased move lets the eye follow. Duration scales with
 * distance but is bounded, so a jump to the end of a long script is still
 * quick.
 */
let glide = null;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function glideTo(target, opts = {}) {
  const to = clamp(target, 0, layout.maxY);
  const dist = Math.abs(to - y);
  VOICE.target = null;
  if (opts.instant || dist < 1.5 || prefersReducedMotion()) {
    glide = null;
    y = to;
    paint();
    return;
  }
  glide = {
    from: y,
    to,
    t0: performance.now(),
    dur: clamp(150 + dist * 0.28, 190, 560),
  };
}

function cancelGlide() {
  glide = null;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function restart() {
  setPlaying(false);
  runAccumMs = 0;
  runResumedAt = null;
  rampWpm = S.wpm;
  glideTo(0);
  voiceResync();
  tickUI(true);
}

function jumpSection(dir) {
  const heads = doc.blocks.filter((b) => b.type === 'h');
  let target;
  if (!heads.length) {
    target = y + dir * pViewport.clientHeight * 0.8;
  } else if (dir > 0) {
    const t = heads.find((h) => yForBlock(h.index) > y + 2);
    target = t ? yForBlock(t.index) : layout.maxY;
  } else {
    const before = heads.filter((h) => yForBlock(h.index) < y - 4);
    target = before.length ? yForBlock(before[before.length - 1].index) : 0;
  }
  glideTo(target);
}

function nudge(lines) {
  glideTo(y + lines * S.fontSize * S.lineHeight);
}

/* ==========================================================================
   Animation loop
   ========================================================================== */

/**
 * The loop is driven by whichever window currently holds the prompter.
 *
 * This matters: once you float the prompter and click over to Zoom, this page
 * is a background tab and its requestAnimationFrame stops firing. The floating
 * window is always visible, so its clock keeps running. A generation counter
 * makes sure only the newest scheduled callback survives, and a watchdog
 * restarts the chain if the window hosting it disappears mid-flight.
 */
let rafGen = 0;
let rafWin = window;
let lastTickAt = 0;

/** requestAnimationFrame on whichever window currently holds the prompter. */
function hostRaf(fn) {
  const w = pipWindow && !pipWindow.closed ? pipWindow : window;
  try {
    return w.requestAnimationFrame(fn);
  } catch {
    return window.requestAnimationFrame(fn);
  }
}

function scheduleFrame() {
  const w = pipWindow && !pipWindow.closed ? pipWindow : window;
  if (w !== rafWin) {
    rafWin = w;
    lastFrame = 0; // clocks in two windows are not comparable
  }
  const gen = ++rafGen;
  const run = (ts) => {
    if (gen !== rafGen) return;
    frame(ts);
  };
  try {
    rafWin.requestAnimationFrame(run);
  } catch {
    window.requestAnimationFrame(run);
  }
}

setInterval(() => {
  const w = pipWindow && !pipWindow.closed ? pipWindow : window;
  const hostVisible = w === window ? document.visibilityState === 'visible' : true;
  if (hostVisible && performance.now() - lastTickAt > 600) {
    lastFrame = 0;
    scheduleFrame();
  }
}, 700);

function frame(ts) {
  lastTickAt = performance.now();
  scheduleFrame();
  const dt = lastFrame ? clamp((ts - lastFrame) / 1000, 0, 0.25) : 0;
  lastFrame = ts;

  if (VAD.stream) vadSample(dt);

  if (layout.maxY > 0 && !countingDown) {
    // Ease the real speed toward the requested speed. Nudging the pace mid
    // sentence should feel like leaning on the accelerator, not a gear change.
    if (rampWpm !== S.wpm) {
      rampWpm = approach(rampWpm, S.wpm, TAU.wpm, dt);
      if (Math.abs(S.wpm - rampWpm) < 0.4) rampWpm = S.wpm;
    }

    if (glide) {
      const p = clamp((performance.now() - glide.t0) / glide.dur, 0, 1);
      y = glide.from + (glide.to - glide.from) * easeInOutCubic(p);
      if (p >= 1) {
        y = glide.to;
        glide = null;
      }
      paint();
    } else if (voiceTick(dt)) {
      // Voice follow drives the scroll; the wpm clock stands down so the two
      // cannot fight each other for the same pixels.
      paint();
    } else if (playing) {
      // In pace mode the clock only runs while you are actually talking.
      const gated = S.voiceMode === 'pace' && (VAD.stream || VAD.wantOn);
      const speaking = !!VAD.stream && VAD.speaking;
      const v = gated && !speaking ? 0 : velocity();
      if (v > 0) {
        y = Math.min(layout.maxY, y + v * dt);
        paint();
        if (y >= layout.maxY) setPlaying(false);
      }
    }
  }

  tickUI();
}

/* ==========================================================================
   Readouts
   ========================================================================== */

let uiLast = 0;
function tickUI(force) {
  const now = performance.now();
  if (!force && now - uiLast < 100) return;
  uiLast = now;

  if (S.focusWord) highlightWord(Math.round(currentWord()));

  updateTally();
  if (VAD.stream && !$('settings').hidden && !$('voice-mic-row').hidden) {
    // Map roughly -70..-15 dBFS onto the bar.
    const pct = (db) => clamp(((db + 70) / 55) * 100, 0, 100);
    $('meter-fill').style.width = pct(VAD.level) + '%';
    $('meter-gate').style.left = pct(VAD.floor + (S.micSensitivity || 9)) + '%';
    $('meter-fill').classList.toggle('hot', VAD.speaking);
  }

  const v = settledVelocity();
  const remaining = v > 0 ? (layout.maxY - y) / v : NaN;
  const frac = layout.maxY > 0 ? y / layout.maxY : 0;

  $('scrub-fill').style.width = frac * 100 + '%';
  $('scrub-knob').style.left = frac * 100 + '%';
  const sc = $('scrub');
  const pc = Math.round(frac * 100);
  if (sc.getAttribute('aria-valuenow') !== String(pc)) {
    sc.setAttribute('aria-valuenow', String(pc));
    sc.setAttribute('aria-valuetext', pc + '%, ' + formatClock(remaining) + ' remaining');
  }

  const elapsed = runElapsed();
  $('t-elapsed').textContent = formatClock(elapsed);
  $('t-remaining').textContent = formatClock(remaining) + ' left';
  P.left.textContent = formatClock(remaining);
  P.wpm.textContent = S.wpm;

  // Pace against the target length.
  const target = (Number(active().targetMin) || 0) * 60;
  const pPace = P.pace;
  const tPace = $('t-pace');
  if (target > 0 && runStarted()) {
    const expected = clamp(elapsed / target, 0, 1.5);
    const delta = (frac - expected) * target;
    // Full-scale deflection at one minute of drift; direction is carried by
    // which side of the centre index the bar sits on, never by hue.
    const dev = clamp(delta / 60, -1, 1);
    const out = Math.abs(delta) >= 5;
    const label = (delta > 0 ? '+' : delta < 0 ? '\u2212' : '') + Math.round(Math.abs(delta)) + 's';
    pPace.hidden = false;
    pPace.style.setProperty('--dev', String(dev));
    pPace.classList.toggle('out', out);
    P.paceNum.textContent = label;
    tPace.textContent = out ? label + (delta > 0 ? ' ahead' : ' behind') : 'on pace';
    tPace.className = 't-pace num' + (out ? ' out' : '');
  } else {
    pPace.hidden = true;
    tPace.textContent = '';
    tPace.className = 't-pace num';
  }
}

/**
 * The tally lamp. Pace mode reports whether it can hear you; word mode
 * reports whether it can still place you in the script.
 */
function updateTally() {
  if (!P.mic) return;
  if (S.voiceMode === 'pace' && VAD.stream) {
    P.mic.hidden = false;
    P.mic.dataset.state = VAD.speaking ? 'locked' : 'searching';
    P.mic.textContent = VAD.speaking ? 'Speaking' : 'Waiting';
    return;
  }
  if (S.voiceMode === 'words') {
    const st = VOICE.status;
    P.mic.hidden = !(st === 'listening' || st === 'locked' || st === 'searching');
    P.mic.dataset.state = st;
    P.mic.textContent = st === 'locked' ? 'Following' : st === 'searching' ? 'Searching' : 'Listening';
    return;
  }
  P.mic.hidden = true;
}

function syncPlayButtons() {
  // `hidden` is an HTMLElement property, so setting it on an <svg> does
  // nothing. Toggle a class instead. Nodes are held by reference because the
  // prompter half of them may live in the floating window.
  for (const [play, pause] of [
    [P.playIcon, P.pauseIcon],
    [document.querySelector('#t-play .i-play'), document.querySelector('#t-play .i-pause')],
  ]) {
    if (!play || !pause) continue;
    play.classList.toggle('off', playing);
    pause.classList.toggle('off', !playing);
  }
  P.play.classList.toggle('on', playing);
  $('t-play').classList.toggle('on', playing);
  prompter.classList.toggle('rolling', playing);
  $('app').classList.toggle('rolling', playing);
  const voiceMode = S.voiceMode !== 'off';
  $('t-play-label').textContent = playing ? 'Stop' : voiceMode ? 'Listen' : 'Start';
}

function renderStats() {
  const words = doc.totalWords;
  const target = Number(active().targetMin) || 0;
  const est = S.wpm > 0 ? (words / S.wpm) * 60 : 0;
  const required = target > 0 && words ? Math.round(words / target) : 0;

  const bits = [
    `<span class="stat"><span class="lbl">Words</span><b>${words.toLocaleString()}</b></span>`,
    `<span class="stat"><span class="lbl">Runs</span><b>${formatClock(est)}</b></span>`,
  ];
  if (required) {
    const hot = Math.abs(required - S.wpm) > 25;
    bits.push(
      `<span class="stat ${hot ? 'hot' : ''}"><span class="lbl">Needs</span><b>${required} wpm</b></span>`
    );
  }
  $('stats').innerHTML = bits.join('');

  const hint = $('pace-hint');
  if (hint) {
    hint.textContent = required
      ? `${words.toLocaleString()} words in ${target} minutes requires ${required} wpm. Considered delivery runs 120–150.`
      : 'Considered delivery runs 120–150 wpm. Set a target length to get a live drift reading.';
  }
}

function renderScrubMarks() {
  const marks = $('scrub-marks');
  marks.innerHTML = '';
  if (layout.maxY <= 0) return;
  doc.blocks
    .filter((b) => b.type === 'h')
    .forEach((h) => {
      const i = document.createElement('i');
      i.style.left = clamp(yForBlock(h.index) / layout.maxY, 0, 1) * 100 + '%';
      i.title = h.text;
      marks.appendChild(i);
    });
}

/* ==========================================================================
   Settings plumbing
   ========================================================================== */

function applySettings() {
  const r = document.documentElement.style;
  r.setProperty('--font-size', S.fontSize + 'px');
  r.setProperty('--line-height', String(S.lineHeight));
  r.setProperty('--pad-x', S.paddingX + 'px');
  r.setProperty('--reading', Math.round(S.readingLine * 100) + '%');
  r.setProperty('--weight', String(S.weight));
  r.setProperty('--align', S.align);
  // With sense lines on, the phrase governs the line length, so the measure
  // cap becomes redundant — and actively harmful, because a phrase wider than
  // the cap wraps mid-phrase, reintroducing exactly the arbitrary break the
  // sense breaks removed. Widen it enough to hold the longest phrase.
  r.setProperty('--measure', (S.senseLines ? Math.max(S.measureEm, 25) : S.measureEm) + 'em');
  if (pipWindow) {
    // The floating window has its own document, so it needs the same variables.
    const pr = pipWindow.document.documentElement.style;
    pr.setProperty('--font-size', S.fontSize + 'px');
    pr.setProperty('--line-height', String(S.lineHeight));
    pr.setProperty('--pad-x', S.paddingX + 'px');
    pr.setProperty('--reading', Math.round(S.readingLine * 100) + '%');
    pr.setProperty('--weight', String(S.weight));
    pr.setProperty('--align', S.align);
    pr.setProperty('--measure', (S.senseLines ? Math.max(S.measureEm, 25) : S.measureEm) + 'em');
  }

  prompter.className =
    'prompter bg-' +
    S.background +
    ' font-' +
    S.fontFamily +
    ' emph-' +
    S.emphasis +
    (S.focusBand ? ' focus-band' : '') +
    (S.showMarks ? ' show-marks' : '') +
    (S.dimSpent ? ' dim-spent' : '') +
    (S.senseLines ? '' : ' run-on') +
    (S.mirror ? ' mirror' : '') +
    (S.flip ? ' flip' : '') +
    (playing ? ' rolling' : '') +
    (barIdle ? ' bar-idle' : '') +
    (S.hideBar && pipWindow ? ' hide-bar' : '');

  $('main').classList.toggle('editor-hidden', S.editorHidden);
  $('main').classList.toggle('settings-open', !$('settings').hidden);
  $('btn-editor').classList.toggle('is-on', !S.editorHidden);

  // reflect into controls
  const setRange = (id, val, fmt) => {
    const inp = $('s-' + id);
    if (inp) inp.value = val;
    const out = $('v-' + id);
    if (out) out.textContent = fmt ? fmt(val) : val;
  };
  setRange('wpm', S.wpm);
  setRange('fontSize', S.fontSize);
  setRange('lineHeight', S.lineHeight, (v) => Number(v).toFixed(2));
  setRange('weight', S.weight);
  setRange('paddingX', S.paddingX);
  setRange('readingLine', S.readingLine, (v) => Math.round(v * 100) + '%');
  setRange('countdown', S.countdown, (v) => (Number(v) === 0 ? 'off' : v + 's'));
  setRange('pipW', S.pipW);
  setRange('pipH', S.pipH);
  setRange('measureEm', S.measureEm);
  setRange('lookaheadSeconds', S.lookaheadSeconds, (v) => Number(v).toFixed(1) + 's');

  segSync('s-fontFamily', S.fontFamily);
  segSync('s-align', S.align);
  segSync('s-background', S.background);
  segSync('s-emphasis', S.emphasis);
  $('s-senseLines').checked = S.senseLines;
  $('s-focusWord').checked = S.focusWord;
  if (!S.focusWord) highlightWord(-1);
  $('clear-hint').hidden = S.background !== 'clear';

  $('s-focusBand').checked = S.focusBand;
  $('s-showMarks').checked = S.showMarks;
  $('s-dimSpent').checked = S.dimSpent;
  $('s-mirror').checked = S.mirror;
  $('s-flip').checked = S.flip;
  $('s-hideBar').checked = S.hideBar;
  segSync('s-voiceMode', S.voiceMode);
  $('s-voiceLang').value = S.voiceLang || '';
  $('voice-words-note').hidden = S.voiceMode !== 'words';
  $('voice-pace-note').hidden = S.voiceMode !== 'pace';
  $('voice-lang-row').hidden = S.voiceMode !== 'words';
  $('voice-mic-row').hidden = S.voiceMode !== 'pace';
  $('s-micSensitivity').value = S.micSensitivity;

  renderStats();
  save();
}

function segSync(id, value) {
  const seg = $(id);
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.v === value;
    b.classList.toggle('is-on', on);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
  });
}

function relayout() {
  const anchor = captureAnchor();
  measure();
  restoreAnchor(anchor);
  paint();
  renderScrubMarks();
  updateSizeHint();
  updateLookaheadHint();
}

/**
 * Type auto-fits the window height, so in a short floating window the Size
 * slider stops having any visible effect. Say so, rather than letting the
 * control look broken.
 */
function updateLookaheadHint() {
  const n = $('lookahead-hint');
  if (!n) return;
  const got = layout.lookaheadSeconds || 0;
  const short = got < S.lookaheadSeconds - 0.15;
  n.textContent = short
    ? `Only ${got.toFixed(1)}s of script fits below the reading line at this size. ` +
      'Reduce the type size, raise the reading line, or make the window taller.'
    : `${got.toFixed(1)}s of speech is visible below the reading line.`;
  n.className = 'hint' + (short ? ' bad' : '');
}

function updateSizeHint() {
  const n = $('size-hint');
  if (!n) return;
  const used = parseFloat(getComputedStyle(pContent).fontSize) || S.fontSize;
  const clamped = used < S.fontSize - 0.5;
  n.hidden = !clamped;
  if (clamped) {
    n.textContent =
      `Showing ${Math.round(used)} px. The window is too short for ${S.fontSize} px, ` +
      'so the type is being fitted to it. Make the window taller for larger type.';
  }
}

function setSetting(key, value, { relayout: needsLayout = true } = {}) {
  S[key] = value;
  applySettings();
  if (needsLayout) hostRaf(relayout);
}

/* ==========================================================================
   Script library
   ========================================================================== */

function renderLibrary() {
  const sel = $('script-picker');
  sel.innerHTML = db.scripts
    .map(
      (s) =>
        `<option value="${s.id}"${s.id === db.activeId ? ' selected' : ''}>${
          (s.name || 'Untitled').replace(/[<>&]/g, '')
        }</option>`
    )
    .join('');
  const s = active();
  $('script-name').value = s.name || '';
  $('target-min').value = s.targetMin || '';
  $('editor').value = s.text || '';
}

function loadScript(id) {
  db.activeId = id;
  restart();
  renderLibrary();
  renderScript();
  save();
}

/* ==========================================================================
   Floating window (Document Picture-in-Picture)
   ========================================================================== */

let noticeTimer = null;
function notify(html, kind = 'info', ms = 11000, action = null) {
  const n = $('notice');
  $('notice-text').innerHTML =
    html + (action ? ` <button class="btn quiet notice-action">${action.label}</button>` : '');
  n.className = 'notice' + (kind === 'warn' ? ' warn' : '');
  n.hidden = false;
  if (action) {
    // Held by reference, not looked up by id: it does not exist in the markup.
    const btn = $('notice-text').querySelector('.notice-action');
    if (btn)
      btn.onclick = () => {
        n.hidden = true;
        action.run();
      };
  }
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => (n.hidden = true), ms);
}
$('notice-x').onclick = () => ($('notice').hidden = true);

function pipSupported() {
  return 'documentPictureInPicture' in window;
}

function styleInto(win) {
  // Declare the colour scheme before anything paints. A Picture-in-Picture
  // window is a real operating-system window with its own opaque canvas; if
  // the document declares nothing, the browser paints its default base, which
  // is WHITE in a light-themed browser. This is what removes the flash on
  // open — the explicit black background below only takes effect once the
  // stylesheet has arrived.
  const meta = win.document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'dark';
  win.document.head.appendChild(meta);
  win.document.documentElement.style.background = '#000';

  const link = win.document.createElement('link');
  link.rel = 'stylesheet';
  // Copy this page's own stylesheet URL, version query and all, so the
  // floating window can never end up on a different build from the page.
  const own = document.querySelector('link[rel=stylesheet]');
  link.href = own ? own.href : new URL('app.css', location.href).href;
  win.document.head.appendChild(link);
  win.document.body.classList.add('pip-body');
  win.document.title = 'Cueline';
}

async function openFloat() {
  if (pipWindow) {
    closeFloat();
    return;
  }

  let win = null;
  if (pipSupported()) {
    try {
      win = await window.documentPictureInPicture.requestWindow({
        width: S.pipW,
        height: S.pipH,
        disallowReturnToOpener: false,
      });
    } catch (err) {
      win = null;
    }
  }

  if (!win) {
    // Fallback: a plain popup. Useful, but the OS will not keep it on top,
    // so say so rather than pretending it is the same thing.
    win = window.open(
      '',
      'cueline-prompter',
      `width=${S.pipW},height=${S.pipH},menubar=no,toolbar=no,location=no,status=no`
    );
    if (!win) {
      notify(
        '<b>The prompter window was blocked.</b> Allow pop-ups for this page, or open ' +
          'Cueline in Chrome, Edge, Arc or Brave, where it gets a proper always-on-top ' +
          'window. In the meantime you can press <b>F</b> for full screen.',
        'warn',
        0
      );
      return;
    }
    win.document.write(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
    );
    win.document.close();
    notify(
      '<b>Opened in a normal window.</b> Your browser does not support always-on-top ' +
        'prompter windows, so you will have to keep it in front yourself. Chrome, Edge, ' +
        'Arc and Brave do support it.',
      'warn',
      0
    );
  }

  // From here the prompter subtree lives in another document. If anything
  // throws part-way through, put it back rather than leaving the page with
  // no prompter in it.
  try {
    pipWindow = win;
    styleInto(win);
    win.document.body.appendChild(prompter);

    win.addEventListener('pagehide', closeFloat);
    win.addEventListener('unload', closeFloat);
    win.addEventListener('resize', () => hostRaf(relayout));
    win.document.addEventListener('keydown', onKey);
  } catch (err) {
    pipWindow = null;
    host.appendChild(prompter);
    try {
      win.close();
    } catch {
      /* ignore */
    }
    notify(
      '<b>Could not open the floating prompter.</b> ' +
        (err && err.message ? err.message : 'Unknown error.') +
        ' The prompter is still here on the page — press <b>F</b> for full screen instead.',
      'warn',
      0
    );
    applySettings();
    hostRaf(relayout);
    return;
  }

  $('floating-note').hidden = false;
  $('btn-float').classList.add('live');
  $('float-label').textContent = 'Bring it back';
  applySettings();
  scheduleFrame(); // hand the animation clock over to the floating window
  hostRaf(relayout);
}

function closeFloat() {
  if (!pipWindow) return;
  const win = pipWindow;
  pipWindow = null;
  host.appendChild(prompter);
  $('floating-note').hidden = true;
  $('btn-float').classList.remove('live');
  $('float-label').textContent = 'Float over Zoom';
  try {
    win.close();
  } catch {
    /* already gone */
  }
  applySettings();
  scheduleFrame(); // take the animation clock back off the closed window
  hostRaf(relayout);
}

/* ==========================================================================
   Pace follow — speech-gated scrolling
   --------------------------------------------------------------------------
   Why this exists, and why it is the default.

   The Web Speech API is the only way a browser will transcribe you, and it
   comes with two costs that matter enormously here. It gives no control over
   which microphone it opens — always the default device, with no deviceId
   constraint and no way to hand it an existing stream — and starting it can
   take the microphone away from whatever else is using it. In practice that
   means turning on word-level tracking during a Google Meet or Zoom call can
   mute you on the call. For a teleprompter that is a catastrophic failure: it
   breaks the exact situation the product exists for.

   getUserMedia has neither problem. It accepts a deviceId, so you can point
   the prompter at a different microphone from the one carrying the call, and
   it is designed for concurrent consumers.

   So this mode does not transcribe at all. It asks one question sixty times a
   second — are you speaking right now? — and advances the script at your set
   rate only while the answer is yes. Stop talking and it stops. Take a
   question and it waits. It cannot know WHICH word you are on, so it will not
   correct drift the way word tracking does, but it never lies about it, it
   never leaves the machine, and it never touches your call audio.
   ========================================================================== */

const VAD = {
  stream: null,
  ctx: null,
  analyser: null,
  buf: null,
  /** Slowly-tracked noise floor in dBFS. */
  floor: -70,
  /** True while we believe speech is present, including the hangover. */
  speaking: false,
  lastVoicedAt: 0,
  /** Smoothed level, for the meter. */
  level: -100,
  status: 'off',
  deviceId: '',
  error: '',
  /** True from the moment we ask for the microphone until we stop or fail. */
  wantOn: false,
};

/** Speech continues through the gaps between words; this bridges them. */
const VAD_HANGOVER_MS = 320;

function vadSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);
}

async function vadStart() {
  if (VAD.stream) return true;
  VAD.wantOn = true;
  if (!vadSupported()) {
    VAD.wantOn = false;
    VAD.status = 'unsupported';
    setVoiceStatus('unsupported', 'This browser cannot open a microphone.');
    return false;
  }

  try {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    // A specific device is what lets the call keep the one it is already on.
    if (S.micDeviceId) audio.deviceId = { ideal: S.micDeviceId };

    VAD.stream = await navigator.mediaDevices.getUserMedia({ audio });
    VAD.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (VAD.ctx.state === 'suspended') await VAD.ctx.resume();

    const src = VAD.ctx.createMediaStreamSource(VAD.stream);
    VAD.analyser = VAD.ctx.createAnalyser();
    VAD.analyser.fftSize = 1024;
    VAD.analyser.smoothingTimeConstant = 0.3;
    src.connect(VAD.analyser);
    VAD.buf = new Float32Array(VAD.analyser.fftSize);

    VAD.floor = -70;
    VAD.level = -100;
    VAD.speaking = false;
    VAD.lastVoicedAt = 0;
    VAD.status = 'listening';
    VAD.error = '';

    // Device labels are only populated once permission has been granted.
    listMicrophones();
    setVoiceStatus('listening', 'Listening for your voice. The script moves only while you speak.');
    return true;
  } catch (err) {
    VAD.stream = null;
    VAD.wantOn = false;
    VAD.status = 'denied';
    VAD.error = err && err.name ? err.name : String(err);
    setVoiceStatus(
      'denied',
      VAD.error === 'NotAllowedError'
        ? 'Microphone access was refused, so pace follow is off.'
        : 'Could not open the microphone: ' + VAD.error
    );
    return false;
  }
}

function vadStop() {
  VAD.wantOn = false;
  if (VAD.stream) {
    VAD.stream.getTracks().forEach((t) => t.stop());
    VAD.stream = null;
  }
  if (VAD.ctx) {
    VAD.ctx.close().catch(() => {});
    VAD.ctx = null;
  }
  VAD.analyser = null;
  VAD.buf = null;
  VAD.speaking = false;
  VAD.status = 'off';
}

/**
 * One reading of the input, in dBFS, with an adaptive noise floor.
 *
 * The floor tracks downward quickly and upward very slowly, so a quiet room
 * calibrates in about a second and a passing air-conditioner does not
 * permanently raise the gate.
 */
function vadSample(dt) {
  if (!VAD.analyser) return;
  VAD.analyser.getFloatTimeDomainData(VAD.buf);

  let sum = 0;
  for (let i = 0; i < VAD.buf.length; i++) sum += VAD.buf[i] * VAD.buf[i];
  const rms = Math.sqrt(sum / VAD.buf.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-8));

  VAD.level = VAD.level === -100 ? db : approach(VAD.level, db, 0.05, dt);

  if (db < VAD.floor) {
    VAD.floor = approach(VAD.floor, db, 0.25, dt);
  } else {
    VAD.floor = approach(VAD.floor, Math.min(db, VAD.floor + 12), 6, dt);
  }

  const gate = VAD.floor + (S.micSensitivity || 9);
  const now = performance.now();
  if (VAD.level > gate) VAD.lastVoicedAt = now;
  VAD.speaking = now - VAD.lastVoicedAt < VAD_HANGOVER_MS;
}

/** Enumerate inputs so the prompter can be pointed at a different mic. */
async function listMicrophones() {
  const sel = $('s-micDevice');
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    sel.innerHTML =
      '<option value="">Default input</option>' +
      mics
        .map(
          (d, i) =>
            `<option value="${escapeText(d.deviceId)}">${escapeText(d.label || 'Microphone ' + (i + 1))}</option>`
        )
        .join('');
    sel.value = S.micDeviceId || '';
  } catch {
    /* enumeration is a nicety; the default device still works */
  }
}

/* ==========================================================================
   Voice follow
   --------------------------------------------------------------------------
   The reader — not a clock — drives the script.

   Speech recognition gives us a noisy, laggy, partially-wrong stream of words.
   Turning that into a prompter that feels calm needs three things beyond
   "search for the words and jump there":

   1. PREDICT AND CORRECT.  Confirmations arrive in bursts every second or two.
      Moving only on confirmation gives a stop-start crawl that is horrible to
      read against. So between confirmations we keep gliding at the rate we
      measured from previous confirmations, and each new match becomes a small
      correction rather than a jump. The motion is continuous; the accuracy is
      periodic.

   2. LOCK STATES AND RE-ACQUISITION.  A presenter goes off script — an aside,
      a question from the floor, a joke. The tracker must notice it has lost
      them, stop moving rather than guess, and widen its search until it finds
      them again, anywhere in the script. A narrow window that only ever looks
      just ahead of the cursor will strand the prompter permanently.

   3. ASYMMETRIC TRUST.  Moving forward on a decent match is cheap to recover
      from. Moving backward is not — it is the failure that makes people give
      up on voice prompters, because a repeated phrase throws them into text
      they already read. Backward jumps therefore demand a near-perfect match.
   ========================================================================== */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Rolling transcript window, in normalised words. */
const HEARD_KEEP = 24;
/** How many recent words we try to align against the script. */
const TAIL = 7;

const VOICE = {
  rec: null,
  /** 'off' | 'starting' | 'listening' | 'locked' | 'searching' | 'denied' | 'error' | 'unsupported' */
  status: 'off',
  wantOn: false,
  finalWords: [],
  interimWords: [],
  /** Script word index we believe the reader has reached. */
  cursor: 0,
  /** Target y for the corrector to ease toward, or null. */
  target: null,
  /** Measured speaking rate in words per second, exponentially smoothed. */
  rate: 0,
  lastMatchAt: 0,
  lastSpeechAt: 0,
  lastCursor: 0,
  lastCursorAt: 0,
  consecutiveMisses: 0,
  restartTimer: null,
  restartDelay: 250,
  message: '',
};

function sameWord(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Speech engines routinely differ on inflection ("run"/"running") and on
  // plurals, so compare stems once both words are long enough for that to
  // mean something.
  return a.length > 3 && b.length > 3 && a.slice(0, 4) === b.slice(0, 4);
}

/**
 * How far either side of the cursor to search.
 *
 * While we are tracking well, look only just behind and a couple of sentences
 * ahead: it is fast and it cannot be fooled by a phrase repeated elsewhere.
 * The longer we go without a confident match, the more likely it is the reader
 * has moved somewhere we are not looking, so widen until eventually we search
 * the whole script.
 */
function voiceWindow() {
  const quiet = (performance.now() - VOICE.lastMatchAt) / 1000;
  if (quiet < 3) return [30, 140];
  if (quiet < 8) return [120, 400];
  return [Infinity, Infinity];
}

/**
 * Align the tail of what was heard against the script.
 * @returns {{end:number, raw:number, at:number}|null}
 */
function alignVoice(heard, cursor, words) {
  const tail = heard.slice(-TAIL);
  if (tail.length < 3 || !words.length) return null;

  const [back, fwd] = voiceWindow();
  const lo = Math.max(0, cursor - (back === Infinity ? cursor : back));
  const hi = Math.min(words.length, fwd === Infinity ? words.length : cursor + fwd);

  let best = { weighted: 0, raw: 0, end: -1, at: -1 };

  for (let i = lo; i < hi; i++) {
    let raw = 0;
    let si = i;
    let skips = 0;
    for (let j = 0; j < tail.length && si < words.length; j++) {
      if (sameWord(tail[j], words[si].norm)) {
        raw++;
        si++;
      } else if (skips < 2 && si + 1 < words.length && sameWord(tail[j], words[si + 1].norm)) {
        // Absorb a word the reader skipped, or one the recogniser dropped.
        raw++;
        si += 2;
        skips++;
      }
    }
    // Break ties toward where we already are. Without this a run of common
    // words ("and then the") scores equally in several places and the earliest
    // candidate wins, dragging the reader backwards across the script.
    const weighted = raw * (1 - Math.min(1, Math.abs(i - cursor) / 200) * 0.5);
    if (weighted > best.weighted) best = { weighted, raw, end: si, at: i };
  }

  const need = Math.max(3, Math.ceil(tail.length * 0.6));
  if (best.raw < need) return null;

  // Going backwards is the expensive mistake: it drops the reader into text
  // they have already said. Demand near-certainty for it.
  if (best.end < cursor - 25 && best.raw < Math.max(5, tail.length - 1)) return null;

  return best;
}

/* ------------------------------------------------------------ transcript */

function voiceHeard() {
  const all = VOICE.finalWords.concat(VOICE.interimWords);
  return all.slice(-HEARD_KEEP);
}

function toWords(text) {
  return text.split(/\s+/).map(normalize).filter(Boolean);
}

/* ---------------------------------------------------------------- status */

const VOICE_COPY = {
  off: 'Off — the prompter scrolls at the speed you set.',
  starting: 'Starting the microphone…',
  listening: 'Listening. Start reading and the prompter will pick you up.',
  locked: 'Following you.',
  searching: 'Lost the thread — say a line from the script and it will find you.',
  denied: 'Microphone access was refused, so voice follow is off.',
  error: 'Speech recognition stopped unexpectedly.',
  unsupported: 'This browser has no speech recognition. Voice follow needs Chrome, Edge, Arc or Brave.',
};

function setVoiceStatus(status, message) {
  VOICE.status = status;
  VOICE.message = message || VOICE_COPY[status] || '';
  const el = $('voice-status');
  if (el) {
    el.textContent = VOICE.message;
    el.className =
      'hint' +
      (status === 'locked' || status === 'listening' ? ' ok' : '') +
      (status === 'denied' || status === 'error' || status === 'unsupported' ? ' bad' : '');
  }
  updateTally();
  syncPlayButtons();
}

/** Voice owns the scroll whenever it is actually running. */
function voiceDriving() {
  return S.voiceMode === 'words' && VOICE.wantOn;
}

/* -------------------------------------------------------------- lifecycle */

function voiceStart() {
  if (!SpeechRec) {
    setVoiceStatus('unsupported');
    S.voiceMode = 'off';
    applySettings();
    return;
  }
  if (VOICE.rec) return;

  VOICE.wantOn = true;
  VOICE.finalWords = [];
  VOICE.interimWords = [];
  VOICE.cursor = Math.round(currentWord());
  VOICE.lastCursor = VOICE.cursor;
  VOICE.lastCursorAt = performance.now();
  VOICE.lastMatchAt = performance.now();
  VOICE.lastSpeechAt = 0;
  VOICE.rate = 0;
  VOICE.target = null;
  VOICE.consecutiveMisses = 0;
  VOICE.restartDelay = 250;

  const rec = new SpeechRec();
  VOICE.rec = rec;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = S.voiceLang || navigator.language || 'en-US';

  rec.onstart = () => {
    VOICE.restartDelay = 250;
    setVoiceStatus('listening');
  };

  rec.onresult = (e) => {
    VOICE.lastSpeechAt = performance.now();

    // Committed results are appended once; the interim tail is replaced each event
    // rather than appended, or the same words pile up and poison the match.
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) VOICE.finalWords.push(...toWords(r[0].transcript));
      else interim += ' ' + r[0].transcript;
    }
    VOICE.interimWords = toWords(interim);
    if (VOICE.finalWords.length > HEARD_KEEP * 3) {
      VOICE.finalWords = VOICE.finalWords.slice(-HEARD_KEEP * 2);
    }

    const match = alignVoice(voiceHeard(), VOICE.cursor, wordList);
    if (!match) {
      VOICE.consecutiveMisses++;
      // Only admit we are lost after several failures and a real gap, so a
      // single misheard phrase does not flip the UI into "searching".
      if (VOICE.consecutiveMisses >= 3 && performance.now() - VOICE.lastMatchAt > 4000) {
        setVoiceStatus('searching');
      }
      return;
    }

    const now = performance.now();
    const advanced = match.end - VOICE.lastCursor;
    const dt = (now - VOICE.lastCursorAt) / 1000;
    // Measure the reader's actual pace so the predictor between confirmations
    // moves at their speed, not the dial's.
    if (dt > 0.35 && advanced > 0 && advanced < 60) {
      const observed = advanced / dt;
      if (observed > 0.5 && observed < 8) {
        VOICE.rate = VOICE.rate ? VOICE.rate * 0.7 + observed * 0.3 : observed;
      }
    }

    VOICE.cursor = match.end;
    VOICE.lastCursor = match.end;
    VOICE.lastCursorAt = now;
    VOICE.lastMatchAt = now;
    VOICE.consecutiveMisses = 0;

    const w = wordList[Math.min(match.end, wordList.length - 1)];
    VOICE.target = yForWord(w ? w.index : 0);
    if (VOICE.status !== 'locked') setVoiceStatus('locked');
  };

  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setVoiceStatus('denied');
      S.voiceMode = 'off';
      voiceStop();
      save();
    } else if (e.error === 'no-speech' || e.error === 'aborted') {
      // Routine. onend will restart us.
    } else if (e.error === 'audio-capture') {
      setVoiceStatus('error', 'No microphone was found.');
    } else if (e.error === 'network') {
      setVoiceStatus('error', 'Speech recognition needs a network connection.');
    } else {
      setVoiceStatus('error', 'Speech recognition error: ' + e.error);
    }
  };

  rec.onend = () => {
    // Chrome ends the session on its own every so often, and after silence.
    // Restart with backoff so a hard failure cannot become a hot loop.
    if (!VOICE.wantOn) {
      setVoiceStatus('off');
      return;
    }
    clearTimeout(VOICE.restartTimer);
    VOICE.restartTimer = setTimeout(() => {
      if (!VOICE.wantOn || !VOICE.rec) return;
      try {
        VOICE.rec.start();
      } catch {
        /* already starting */
      }
    }, VOICE.restartDelay);
    VOICE.restartDelay = Math.min(VOICE.restartDelay * 1.8, 8000);
  };

  setVoiceStatus('starting');
  try {
    rec.start();
  } catch {
    /* start() throws if called twice; onstart will settle the status */
  }
}

function voiceStop() {
  VOICE.wantOn = false;
  clearTimeout(VOICE.restartTimer);
  VOICE.target = null;
  VOICE.rate = 0;
  if (VOICE.rec) {
    const rec = VOICE.rec;
    VOICE.rec = null;
    try {
      rec.onend = null;
      rec.stop();
    } catch {
      /* ignore */
    }
  }
  setVoiceStatus(SpeechRec || vadSupported() ? 'off' : 'unsupported');
  if (S.voiceMode === 'pace') listMicrophones();
}

/** Called when the script or position changes underneath the tracker. */
function voiceResync() {
  VOICE.cursor = Math.round(currentWord());
  VOICE.lastCursor = VOICE.cursor;
  VOICE.lastCursorAt = performance.now();
  VOICE.target = null;
  VOICE.finalWords = [];
  VOICE.interimWords = [];
}

/* ------------------------------------------------------------------ tick */

/**
 * Advance the scroll under voice control. Returns true if voice handled this
 * frame, in which case the wpm auto-scroll must not also run.
 */
function voiceTick(dt) {
  if (!voiceDriving()) return false;

  const now = performance.now();
  const sinceSpeech = (now - VOICE.lastSpeechAt) / 1000;
  const sinceMatch = (now - VOICE.lastMatchAt) / 1000;

  if (VOICE.target !== null) {
    // Corrector: ease onto the confirmed position.
    const diff = VOICE.target - y;
    if (Math.abs(diff) < 0.5) {
      y = VOICE.target;
      VOICE.target = null;
    } else {
      y = clamp(approach(y, VOICE.target, TAU.voice, dt), 0, layout.maxY);
    }
  } else if (VOICE.status === 'locked' && VOICE.rate > 0 && sinceSpeech < 1.5 && sinceMatch < 3) {
    // Predictor: keep moving at the reader's measured pace between
    // confirmations, so the scroll is continuous rather than stop-start.
    y = clamp(y + velocityFor(VOICE.rate * 60) * dt, 0, layout.maxY);
  }
  // Otherwise hold still: they have stopped talking, or we have lost them.
  // Holding is always better than guessing.

  if (VOICE.status === 'locked' && sinceMatch > 6) setVoiceStatus('searching');
  return true;
}

/* ==========================================================================
   Events
   ========================================================================== */

/* --- transport ---------------------------------------------------------- */
$('t-play').onclick = togglePlay;
P.play.onclick = togglePlay;
$('t-restart').onclick = restart;
P.restart.onclick = restart;
$('t-prev').onclick = () => jumpSection(-1);
$('t-next').onclick = () => jumpSection(1);

const bumpWpm = (d) => setSetting('wpm', clamp(S.wpm + d, 40, 400), { relayout: false });
P.faster.onclick = () => bumpWpm(5);
P.slower.onclick = () => bumpWpm(-5);
P.prev.onclick = () => jumpSection(-1);
P.next.onclick = () => jumpSection(1);

/* --- scrubbing ---------------------------------------------------------- */
function scrubTo(clientX) {
  const r = $('scrub').getBoundingClientRect();
  cancelGlide();
  y = clamp((clientX - r.left) / r.width, 0, 1) * layout.maxY;
  paint();
  voiceResync();
  tickUI(true);
}
let scrubbing = false;
$('scrub').addEventListener('pointerdown', (e) => {
  scrubbing = true;
  $('scrub').setPointerCapture(e.pointerId);
  scrubTo(e.clientX);
});
$('scrub').addEventListener('pointermove', (e) => scrubbing && scrubTo(e.clientX));
$('scrub').addEventListener('pointerup', () => (scrubbing = false));
$('scrub').addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 };
  if (e.key in step) {
    e.preventDefault();
    nudge(step[e.key]);
  } else if (e.key === 'Home') {
    e.preventDefault();
    glideTo(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    glideTo(layout.maxY);
  } else if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    jumpSection(e.key === 'PageDown' ? 1 : -1);
  }
});

/* --- dragging / wheel on the prompter ----------------------------------- */
pViewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cancelGlide();
    // deltaMode 1 is lines and 2 is pages; Firefox uses lines by default, so
    // an unscaled deltaY moves the script by about three pixels per notch.
    const unit =
      e.deltaMode === 1 ? S.fontSize * S.lineHeight : e.deltaMode === 2 ? pViewport.clientHeight : 1;
    y = clamp(y + e.deltaY * unit, 0, layout.maxY);
    paint();
    voiceResync();
  },
  { passive: false }
);

let drag = null;
pViewport.addEventListener('pointerdown', (e) => {
  cancelGlide();
  drag = { y0: e.clientY, s0: y };
  pViewport.setPointerCapture(e.pointerId);
});
pViewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  cancelGlide();
  y = clamp(drag.s0 - (e.clientY - drag.y0), 0, layout.maxY);
  paint();
});
pViewport.addEventListener('pointermove', wakeBar);
pViewport.addEventListener('pointerup', () => {
  if (drag) voiceResync();
  drag = null;
});
pViewport.addEventListener('pointercancel', () => (drag = null));

/* --- editor ------------------------------------------------------------- */
const editor = $('editor');
let editTimer = null;
editor.addEventListener('input', () => {
  active().text = editor.value;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const anchor = captureAnchor();
    renderScript();
    restoreAnchor(anchor);
    paint();
    voiceResync();
    save();
  }, 260);
});

$('script-name').addEventListener('input', (e) => {
  active().name = e.target.value;
  renderLibrary();
  save();
});
$('target-min').addEventListener('input', (e) => {
  active().targetMin = Number(e.target.value) || 0;
  renderStats();
  save();
});

$('script-picker').addEventListener('change', (e) => loadScript(e.target.value));

$('btn-new').onclick = () => {
  const s = { id: 's' + Date.now().toString(36), name: 'Untitled script', text: '', targetMin: 0 };
  db.scripts.unshift(s);
  loadScript(s.id);
  editor.focus();
};

// No native confirm(): OS chrome in the middle of a considered interface is
// the loudest possible tell. Delete immediately and offer undo instead —
// which is also faster for the common case where the user meant it.
$('btn-delete').onclick = () => {
  const doomed = active();
  const at = db.scripts.indexOf(doomed);
  const label = doomed.name || 'Untitled';

  if (db.scripts.length <= 1) {
    const restore = { ...doomed };
    doomed.text = '';
    doomed.name = 'Untitled';
    doomed.targetMin = 0;
    renderLibrary();
    renderScript();
    save();
    notify(`Cleared <b>${escapeText(label)}</b>.`, 'info', 9000, {
      label: 'Undo',
      run: () => {
        Object.assign(active(), restore);
        renderLibrary();
        renderScript();
        save();
      },
    });
    return;
  }

  db.scripts = db.scripts.filter((x) => x.id !== doomed.id);
  loadScript(db.scripts[0].id);
  notify(`Deleted <b>${escapeText(label)}</b>.`, 'info', 9000, {
    label: 'Undo',
    run: () => {
      db.scripts.splice(at, 0, doomed);
      loadScript(doomed.id);
    },
  });
};


/** Shared guard for both ways a file can arrive. */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

async function loadScriptFile(file) {
  const named = /\.(txt|md|markdown)$/i.test(file.name || '');
  if (file.type && !file.type.startsWith('text/') && !named) {
    notify(`<b>${escapeText(file.name || 'That file')}</b> is not a text file.`, 'warn');
    return;
  }
  if (file.size > MAX_SCRIPT_BYTES) {
    notify(
      `<b>${escapeText(file.name)}</b> is ${(file.size / 1048576).toFixed(1)} MB. ` +
        'Scripts are capped at 2 MB — anything larger would not fit in browser storage.',
      'warn'
    );
    return;
  }
  const text = await file.text();
  const s = {
    id: 's' + Date.now().toString(36),
    name: (file.name || 'Untitled').replace(/\.(txt|md|markdown)$/i, ''),
    text,
    targetMin: 0,
  };
  db.scripts.unshift(s);
  loadScript(s.id);
}

// Import without export makes the app a one-way door — and save() already
// ships a message telling you to copy your script somewhere safe.
$('btn-export').onclick = () => {
  const s = active();
  const name = (s.name || 'script').replace(/[^\w\- ]+/g, '').trim() || 'script';
  const blob = new Blob([s.text || ''], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

$('btn-import').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await loadScriptFile(file);
  e.target.value = '';
});

// Drop a file anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  // Unconditionally, and first: otherwise dropping a link or selected text
  // navigates the page and destroys a running prompter.
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) await loadScriptFile(file);
});

/* --- settings ----------------------------------------------------------- */
const RANGES = {
  wpm: (v) => Math.round(v),
  fontSize: (v) => Math.round(v),
  lineHeight: (v) => Number(v),
  weight: (v) => Math.round(v),
  paddingX: (v) => Math.round(v),
  readingLine: (v) => Number(v),
  lookaheadSeconds: (v) => Number(v),
  measureEm: (v) => Number(v),
  countdown: (v) => Math.round(v),
  pipW: (v) => Math.round(v),
  pipH: (v) => Math.round(v),
};
for (const [key, cast] of Object.entries(RANGES)) {
  const input = $('s-' + key);
  if (!input) continue;
  input.addEventListener('input', () =>
    setSetting(key, cast(input.value), {
      relayout: !['wpm', 'countdown', 'pipW', 'pipH'].includes(key),
    })
  );
}

const CHECKS = {
  focusBand: 'focusBand',
  senseLines: 'senseLines',
  focusWord: 'focusWord',
  showMarks: 'showMarks',
  dimSpent: 'dimSpent',
  mirror: 'mirror',
  flip: 'flip',
  hideBar: 'hideBar',
};
for (const [id, key] of Object.entries(CHECKS)) {
  $('s-' + id).addEventListener('change', (e) => setSetting(key, e.target.checked, { relayout: false }));
}

$('s-voiceLang').addEventListener('change', (e) => {
  S.voiceLang = e.target.value;
  save();
  // A running recogniser keeps the language it started with.
  if (VOICE.wantOn) {
    voiceStop();
    voiceStart();
  }
});

function setVoiceMode(mode) {
  S.voiceMode = mode;
  save();
  // Never leave two capture paths open at once.
  voiceStop();
  vadStop();
  if (mode === 'words' && playing) voiceStart();
  else if (mode === 'pace' && playing) vadStart();
  else if (mode === 'off') setVoiceStatus('off');
  else setVoiceStatus('off', 'Ready. Press Listen and it will follow you.');
  if (mode === 'pace') listMicrophones();
  applySettings();
}

$('s-voiceMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (b) setVoiceMode(b.dataset.v);
});

$('s-micDevice').addEventListener('change', async (e) => {
  S.micDeviceId = e.target.value;
  save();
  if (VAD.stream) {
    vadStop();
    await vadStart();
  }
});

$('s-micSensitivity').addEventListener('input', (e) => {
  S.micSensitivity = Number(e.target.value);
  save();
});

for (const [id, key] of [
  ['s-fontFamily', 'fontFamily'],
  ['s-align', 'align'],
  ['s-background', 'background'],
  ['s-emphasis', 'emphasis'],
]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setSetting(key, b.dataset.v);
  });
}

$('btn-reset').onclick = () => {
  Object.assign(S, DEFAULTS);
  applySettings();
  hostRaf(relayout);
};

function toggleSettings(open) {
  const next = open === undefined ? $('settings').hidden : open;
  $('settings').hidden = !next;
  $('btn-settings').setAttribute('aria-expanded', String(next));
  $('btn-settings').classList.toggle('on', next);
  applySettings();
  hostRaf(relayout);
}
$('btn-settings').onclick = () => toggleSettings();
$('btn-settings-close').onclick = () => toggleSettings(false);

$('btn-collapse').onclick = () => setSetting('editorHidden', true, { relayout: true });
$('btn-editor').onclick = () => setSetting('editorHidden', !S.editorHidden, { relayout: true });

/* --- float -------------------------------------------------------------- */
$('btn-float').onclick = () => {
  if (pipWindow) {
    closeFloat();
    return;
  }
  // Asked once, at the moment it matters, instead of a permanent warning
  // stripe that everyone learns to stop seeing.
  if (!db.preflightDone) {
    pfOpener = document.activeElement;
    $('preflight').hidden = false;
    $('pf-go').focus();
    return;
  }
  openFloat();
};
$('pf-go').onclick = () => {
  db.preflightDone = true;
  save();
  closePreflight();
  openFloat();
};
$('pf-cancel').onclick = closePreflight;
$('btn-unfloat').onclick = closeFloat;

/* --- help --------------------------------------------------------------- */
let pfOpener = null;
function closePreflight() {
  $('preflight').hidden = true;
  if (pfOpener && pfOpener.focus) pfOpener.focus();
  pfOpener = null;
}

let helpOpener = null;
function openHelp() {
  helpOpener = document.activeElement;
  $('help').hidden = false;
  $('help-close').focus();
}
function closeHelp() {
  $('help').hidden = true;
  db.seenHelp = true;
  save();
  if (helpOpener && helpOpener.focus) helpOpener.focus();
  helpOpener = null;
}
$('btn-help').onclick = openHelp;
$('help-close').onclick = closeHelp;
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) closeHelp();
});
$('preflight').addEventListener('click', (e) => {
  if (e.target === $('preflight')) closePreflight();
});

/* --- keyboard ----------------------------------------------------------- */
function onKey(e) {
  // Escape is handled before the typing guard: it must work from anywhere.
  if (e.key === 'Escape') {
    if (!$('preflight').hidden) {
      closePreflight();
      return;
    }
    if (!$('help').hidden) {
      closeHelp();
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    if (pipWindow) closeFloat();
    return;
  }

  const t = e.target;
  const typing =
    t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
  if (typing) return;
  // Space activates a button, the arrows move a select or a slider. Stealing
  // them globally breaks keyboard operation of every control in the app.
  if (t && t.closest && t.closest('button, select, summary, a[href], [role="slider"]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowUp':
      e.preventDefault();
      bumpWpm(5);
      break;
    case 'ArrowDown':
      e.preventDefault();
      bumpWpm(-5);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      jumpSection(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      jumpSection(1);
      break;
    case 'j':
    case 'J':
      nudge(-1);
      break;
    case 'k':
    case 'K':
      nudge(1);
      break;
    case 'r':
    case 'R':
      restart();
      break;
    case 'm':
    case 'M':
      setSetting('mirror', !S.mirror, { relayout: false });
      break;
    case 'f':
    case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else prompter.requestFullscreen && prompter.requestFullscreen();
      break;
    case '+':
    case '=':
      setSetting('fontSize', clamp(S.fontSize + 2, 20, 120));
      break;
    case '-':
    case '_':
      setSetting('fontSize', clamp(S.fontSize - 2, 20, 120));
      break;
    default:
      break;
  }
}
document.addEventListener('keydown', onKey);

/* --- resize ------------------------------------------------------------- */
const ro = new ResizeObserver(() => hostRaf(relayout));
ro.observe(pViewport);
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* ignore */
  }
});

/* ==========================================================================
   Boot
   ========================================================================== */

(function init() {
  if (!pipSupported()) {
    $('btn-float').title =
      'This browser cannot open an always-on-top window. Chrome, Edge, Arc and Brave can.';
  }
  window.CuelineIcons.paintIcons(document);

  renderLibrary();
  applySettings();
  renderScript();
  syncPlayButtons();
  setVoiceStatus(SpeechRec || vadSupported() ? 'off' : 'unsupported');
  if (S.voiceMode === 'pace') listMicrophones();

  // One onboarding surface. The demo script in the prompter already explains
  // the product; opening a modal wall on top of it said everything twice.
  if (!db.seenHelp) {
    db.seenHelp = true;
    save();
  }

  tickUI(true);
  scheduleFrame();
})();
