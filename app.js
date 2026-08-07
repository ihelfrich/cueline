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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ state */

const STORE_KEY = 'cueline.v1';

const WELCOME = `# Start here

This is your script. It scrolls past the green reading line while you look
straight into your camera, so your audience sees eye contact instead of the
top of your head.

> Lines starting with ">" are cues to yourself. They are dimmed, and they
> never count toward your word count or your timing.

Press **Float over Zoom** in the top right. The prompter jumps into a small
window that stays on top of everything, including full-screen Zoom. Drag it
directly under your webcam.

---

# The one rule for screen sharing

In Zoom, share a **window** or a **Chrome tab**, not "Entire Screen". A window
share only ever contains the app you picked, so the floating prompter is not
in it. If you share the entire screen, everything on that screen goes out,
including this. No web page can opt out of that — only a native app can.

# Pace yourself

Set a target length in the box above the editor. Cueline works out the words
per minute that lands it, and tells you live whether you are running ahead or
behind. Change speed any time with the plus and minus buttons.

> Cue: pause here. Look at the camera. Let it land.

# Hands free

Turn on **voice follow** in Settings and Cueline listens to you, keeping the
line you are actually saying on the reading line. Ad-lib, pause, take a
question — it waits, then picks you back up when you return to the script.

Now delete all of this and paste in what you actually have to say.
`;

const DEFAULTS = {
  wpm: 140,
  fontSize: 34,
  lineHeight: 1.45,
  weight: 600,
  paddingX: 44,
  fontFamily: 'system',
  align: 'left',
  background: 'dim',
  readingLine: 0.38,
  focusBand: true,
  showMarks: true,
  dimSpent: true,
  mirror: false,
  countdown: 3,
  voice: false,
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
  };
  if (!raw || !Array.isArray(raw.scripts) || !raw.scripts.length) return seed;
  return {
    settings: { ...DEFAULTS, ...(raw.settings || {}) },
    scripts: raw.scripts,
    activeId: raw.scripts.some((s) => s.id === raw.activeId) ? raw.activeId : raw.scripts[0].id,
    seenHelp: !!raw.seenHelp,
  };
}

const db = loadStore();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch {
      /* private mode, quota — the app still works for this session */
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
let runStartedAt = null;
let countingDown = false;
let voiceTarget = null; // y that voice-follow is easing toward
let pipWindow = null;
let lastFrame = 0;

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
  smaller: $('p-smaller'),
  bigger: $('p-bigger'),
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
  y = clamp(y, 0, layout.maxY);
  paint();
}

function paint() {
  pContent.style.transform = `translate3d(0, ${-y}px, 0)`;
  if (!S.dimSpent) return;
  const line = y + layout.readingPx;
  const kids = pContent.children;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    const idx = Number(n.dataset.i);
    const spent = (layout.tops[idx] || 0) + (layout.heights[idx] || 0) < line;
    if (spent !== n.classList.contains('spent')) n.classList.toggle('spent', spent);
  }
}

/* ------------------------------------------------------- position ↔ words */

const pxPerWord = () =>
  doc.totalWords && layout.textHeight ? layout.textHeight / doc.totalWords : 0;

const velocity = () => (pxPerWord() ? (S.wpm / 60) * pxPerWord() : 0);

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

function yForWord(w) {
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (b.wordsBefore <= w) {
      const frac = b.words ? clamp((w - b.wordsBefore) / b.words, 0, 1) : 0;
      const top = (layout.tops[i] || 0) + frac * (layout.heights[i] || 0);
      return clamp(top - layout.readingPx, 0, layout.maxY);
    }
  }
  return 0;
}

/* ==========================================================================
   Transport
   ========================================================================== */

async function setPlaying(next) {
  if (next === playing) return;
  if (next && layout.maxY <= 0) return;

  playing = next;
  if (playing && !runStartedAt) runStartedAt = Date.now();

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
}

function togglePlay() {
  setPlaying(!playing);
}

function restart() {
  setPlaying(false);
  runStartedAt = null;
  y = 0;
  voiceTarget = null;
  paint();
  tickUI();
}

function jumpSection(dir) {
  const heads = doc.blocks.filter((b) => b.type === 'h');
  if (!heads.length) {
    y = clamp(y + dir * pViewport.clientHeight * 0.8, 0, layout.maxY);
  } else if (dir > 0) {
    const t = heads.find((h) => yForBlock(h.index) > y + 2);
    y = t ? yForBlock(t.index) : layout.maxY;
  } else {
    const before = heads.filter((h) => yForBlock(h.index) < y - 4);
    y = before.length ? yForBlock(before[before.length - 1].index) : 0;
  }
  voiceTarget = null;
  paint();
}

function nudge(lines) {
  y = clamp(y + lines * S.fontSize * S.lineHeight, 0, layout.maxY);
  voiceTarget = null;
  paint();
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
  const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.25) : 0;
  lastFrame = ts;

  if (layout.maxY > 0 && !countingDown) {
    if (voiceTarget !== null) {
      // Voice follow: ease toward where we heard you, never jump.
      const diff = voiceTarget - y;
      if (Math.abs(diff) < 0.6) {
        y = voiceTarget;
        voiceTarget = null;
      } else {
        y = clamp(y + diff * Math.min(1, dt * 4.5), 0, layout.maxY);
      }
      paint();
    } else if (playing) {
      const v = velocity();
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

  const v = velocity();
  const remaining = v > 0 ? (layout.maxY - y) / v : NaN;
  const frac = layout.maxY > 0 ? y / layout.maxY : 0;

  $('scrub-fill').style.width = frac * 100 + '%';
  $('scrub-knob').style.left = frac * 100 + '%';

  const elapsed = runStartedAt ? (Date.now() - runStartedAt) / 1000 : 0;
  $('t-elapsed').textContent = formatClock(elapsed);
  $('t-remaining').textContent = formatClock(remaining) + ' left';
  P.left.textContent = formatClock(remaining);
  P.wpm.textContent = S.wpm;

  // Pace against the target length.
  const target = (Number(active().targetMin) || 0) * 60;
  const pPace = P.pace;
  const tPace = $('t-pace');
  if (target > 0 && runStartedAt) {
    const expected = clamp(elapsed / target, 0, 1.5);
    const delta = (frac - expected) * target;
    const cls = Math.abs(delta) < 5 ? 'onpace' : delta > 0 ? 'ahead' : 'behind';
    const label =
      Math.abs(delta) < 5
        ? 'on pace'
        : (delta > 0 ? '+' : '') + Math.round(delta) + 's ' + (delta > 0 ? 'ahead' : 'behind');
    pPace.hidden = false;
    pPace.textContent = label;
    pPace.className = 'p-pace ' + cls;
    tPace.textContent = label;
    tPace.className = 't-pace ' + cls;
  } else {
    pPace.hidden = true;
    tPace.textContent = '';
    tPace.className = 't-pace';
  }
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
  $('t-play-label').textContent = playing ? 'Stop' : 'Start';
}

function renderStats() {
  const words = doc.totalWords;
  const target = Number(active().targetMin) || 0;
  const est = S.wpm > 0 ? (words / S.wpm) * 60 : 0;
  const required = target > 0 && words ? Math.round(words / target) : 0;

  const bits = [
    `<span><b>${words.toLocaleString()}</b> words</span>`,
    `<span><b>${formatClock(est)}</b> at ${S.wpm} wpm</span>`,
  ];
  if (required) {
    const hot = Math.abs(required - S.wpm) > 25;
    bits.push(
      `<span class="req ${hot ? 'hot' : ''}">needs <b>${required} wpm</b> to hit ${target} min</span>`
    );
  }
  $('stats').innerHTML = bits.join('');

  const hint = $('pace-hint');
  if (hint) {
    hint.textContent = required
      ? `${words.toLocaleString()} words in ${target} minutes needs ${required} wpm. Conversational delivery is 120–150.`
      : 'Conversational delivery is 120–150 wpm. Set a target length in the editor to get a live pace check.';
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
  if (pipWindow) {
    // The floating window has its own document, so it needs the same variables.
    const pr = pipWindow.document.documentElement.style;
    pr.setProperty('--font-size', S.fontSize + 'px');
    pr.setProperty('--line-height', String(S.lineHeight));
    pr.setProperty('--pad-x', S.paddingX + 'px');
    pr.setProperty('--reading', Math.round(S.readingLine * 100) + '%');
    pr.setProperty('--weight', String(S.weight));
    pr.setProperty('--align', S.align);
  }

  prompter.className =
    'prompter bg-' +
    S.background +
    ' font-' +
    S.fontFamily +
    (S.focusBand ? ' focus-band' : '') +
    (S.showMarks ? ' show-marks' : '') +
    (S.dimSpent ? ' dim-spent' : '') +
    (S.mirror ? ' mirror' : '') +
    (S.hideBar && pipWindow ? ' hide-bar' : '');

  if (!S.dimSpent) {
    pContent.querySelectorAll('.spent').forEach((n) => n.classList.remove('spent'));
  }

  $('main').classList.toggle('editor-hidden', S.editorHidden);
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

  segSync('s-fontFamily', S.fontFamily);
  segSync('s-align', S.align);
  segSync('s-background', S.background);

  $('s-focusBand').checked = S.focusBand;
  $('s-showMarks').checked = S.showMarks;
  $('s-dimSpent').checked = S.dimSpent;
  $('s-mirror').checked = S.mirror;
  $('s-hideBar').checked = S.hideBar;
  $('s-voice').checked = S.voice;

  renderStats();
  save();
}

function segSync(id, value) {
  const seg = $(id);
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === value));
}

function relayout() {
  const anchor = currentWord();
  measure();
  y = yForWord(anchor);
  paint();
  renderScrubMarks();
}

function setSetting(key, value, { relayout: needsLayout = true } = {}) {
  S[key] = value;
  applySettings();
  if (needsLayout) requestAnimationFrame(relayout);
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
function notify(html, kind = 'info', ms = 11000) {
  const n = $('notice');
  $('notice-text').innerHTML = html;
  n.className = 'notice' + (kind === 'warn' ? ' warn' : '');
  n.hidden = false;
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => (n.hidden = true), ms);
}
$('notice-x').onclick = () => ($('notice').hidden = true);

function pipSupported() {
  return 'documentPictureInPicture' in window;
}

function styleInto(win) {
  const link = win.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('app.css', location.href).href;
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

  pipWindow = win;
  styleInto(win);
  win.document.body.appendChild(prompter);

  win.addEventListener('pagehide', closeFloat);
  win.addEventListener('unload', closeFloat);
  win.addEventListener('resize', () => requestAnimationFrame(relayout));
  win.document.addEventListener('keydown', onKey);

  $('floating-note').hidden = false;
  $('btn-float').classList.add('is-floating');
  $('btn-float').lastChild.textContent = ' Bring it back';
  applySettings();
  requestAnimationFrame(relayout);
}

function closeFloat() {
  if (!pipWindow) return;
  const win = pipWindow;
  pipWindow = null;
  host.appendChild(prompter);
  $('floating-note').hidden = true;
  $('btn-float').classList.remove('is-floating');
  $('btn-float').lastChild.textContent = ' Float over Zoom';
  try {
    win.close();
  } catch {
    /* already gone */
  }
  applySettings();
  requestAnimationFrame(relayout);
}

/* ==========================================================================
   Voice follow
   ========================================================================== */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let voiceCursor = 0;
let voiceStopping = false;

function sameWord(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length > 3 && b.length > 3 && a.slice(0, 4) === b.slice(0, 4);
}

/**
 * Align the tail of what was heard against the script near the current
 * position. Returns the script word index just past the match, or null.
 */
function alignVoice(heard) {
  const tail = heard.slice(-6);
  if (tail.length < 2 || !wordList.length) return null;

  const lo = Math.max(0, voiceCursor - 25);
  const hi = Math.min(wordList.length, voiceCursor + 160);
  let best = { score: 0, end: -1 };

  for (let i = lo; i < hi; i++) {
    let score = 0;
    let si = i;
    for (let j = 0; j < tail.length && si < wordList.length; j++) {
      if (sameWord(tail[j], wordList[si].norm)) {
        score++;
        si++;
      } else if (si + 1 < wordList.length && sameWord(tail[j], wordList[si + 1].norm)) {
        // absorb one skipped script word (a filler, a misheard article)
        score++;
        si += 2;
      }
    }
    if (score > best.score) best = { score, end: si };
  }

  const need = Math.max(2, Math.ceil(tail.length * 0.5));
  return best.score >= need ? best.end : null;
}

function voiceStatus(text, cls) {
  const n = $('voice-status');
  n.textContent = text;
  n.className = 'hint' + (cls ? ' ' + cls : '');
}

function startVoice() {
  if (!SpeechRec) {
    voiceStatus(
      'This browser has no speech recognition. Voice follow needs Chrome, Edge, Arc or Brave.',
      'bad'
    );
    S.voice = false;
    $('s-voice').checked = false;
    return;
  }
  if (rec) return;

  rec = new SpeechRec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  rec.onstart = () => {
    voiceStatus('Listening. Speak your script and the prompter will follow.', 'ok');
    P.mic.hidden = false;
  };

  rec.onresult = (e) => {
    const heard = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      heard.push(
        ...e.results[i][0].transcript
          .split(/\s+/)
          .map(normalize)
          .filter(Boolean)
      );
    }
    const end = alignVoice(heard);
    if (end !== null) {
      voiceCursor = end;
      const w = wordList[Math.min(end, wordList.length - 1)];
      // Keep the line being spoken ON the reading line, not above it.
      voiceTarget = yForWord(w ? w.index : 0);
    }
  };

  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      voiceStatus('Microphone access was refused, so voice follow is off.', 'bad');
      S.voice = false;
      $('s-voice').checked = false;
      stopVoice();
    } else if (e.error === 'no-speech') {
      voiceStatus('Listening — no speech heard yet.', '');
    } else {
      voiceStatus('Speech recognition error: ' + e.error, 'bad');
    }
  };

  rec.onend = () => {
    P.mic.hidden = true;
    // Chrome ends the session periodically; restart unless we asked it to stop.
    if (S.voice && !voiceStopping) {
      setTimeout(() => {
        try {
          rec && rec.start();
        } catch {
          /* already starting */
        }
      }, 250);
    }
  };

  voiceCursor = Math.round(currentWord());
  voiceStopping = false;
  try {
    rec.start();
  } catch {
    /* already started */
  }
}

function stopVoice() {
  voiceStopping = true;
  voiceTarget = null;
  P.mic.hidden = true;
  if (rec) {
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
    rec = null;
  }
  voiceStatus(
    SpeechRec ? 'Off. Cueline scrolls at the speed you set.' : 'Not available in this browser.',
    ''
  );
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
P.bigger.onclick = () => setSetting('fontSize', clamp(S.fontSize + 2, 14, 120));
P.smaller.onclick = () => setSetting('fontSize', clamp(S.fontSize - 2, 14, 120));

/* --- scrubbing ---------------------------------------------------------- */
function scrubTo(clientX) {
  const r = $('scrub').getBoundingClientRect();
  y = clamp((clientX - r.left) / r.width, 0, 1) * layout.maxY;
  voiceTarget = null;
  paint();
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
  if (e.key === 'ArrowLeft') nudge(-1);
  else if (e.key === 'ArrowRight') nudge(1);
});

/* --- dragging / wheel on the prompter ----------------------------------- */
pViewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    y = clamp(y + e.deltaY, 0, layout.maxY);
    voiceTarget = null;
    paint();
  },
  { passive: false }
);

let drag = null;
pViewport.addEventListener('pointerdown', (e) => {
  drag = { y0: e.clientY, s0: y };
  pViewport.setPointerCapture(e.pointerId);
});
pViewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  y = clamp(drag.s0 - (e.clientY - drag.y0), 0, layout.maxY);
  voiceTarget = null;
  paint();
});
pViewport.addEventListener('pointerup', () => (drag = null));
pViewport.addEventListener('pointercancel', () => (drag = null));

/* --- editor ------------------------------------------------------------- */
const editor = $('editor');
let editTimer = null;
editor.addEventListener('input', () => {
  active().text = editor.value;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const anchor = currentWord();
    renderScript();
    y = clamp(yForWord(anchor), 0, layout.maxY);
    paint();
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

$('btn-delete').onclick = () => {
  if (db.scripts.length <= 1) {
    active().text = '';
    active().name = 'Untitled script';
    renderLibrary();
    renderScript();
    save();
    return;
  }
  if (!confirm(`Delete "${active().name || 'this script'}"? This cannot be undone.`)) return;
  db.scripts = db.scripts.filter((s) => s.id !== db.activeId);
  loadScript(db.scripts[0].id);
};

$('btn-import').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const s = {
    id: 's' + Date.now().toString(36),
    name: file.name.replace(/\.(txt|md|markdown)$/i, ''),
    text,
    targetMin: 0,
  };
  db.scripts.unshift(s);
  loadScript(s.id);
  e.target.value = '';
});

// Drop a file anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (!file) return;
  e.preventDefault();
  const text = await file.text();
  const s = {
    id: 's' + Date.now().toString(36),
    name: file.name.replace(/\.(txt|md|markdown)$/i, ''),
    text,
    targetMin: 0,
  };
  db.scripts.unshift(s);
  loadScript(s.id);
});

/* --- settings ----------------------------------------------------------- */
const RANGES = {
  wpm: (v) => Math.round(v),
  fontSize: (v) => Math.round(v),
  lineHeight: (v) => Number(v),
  weight: (v) => Math.round(v),
  paddingX: (v) => Math.round(v),
  readingLine: (v) => Number(v),
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
  showMarks: 'showMarks',
  dimSpent: 'dimSpent',
  mirror: 'mirror',
  hideBar: 'hideBar',
};
for (const [id, key] of Object.entries(CHECKS)) {
  $('s-' + id).addEventListener('change', (e) => setSetting(key, e.target.checked, { relayout: false }));
}

$('s-voice').addEventListener('change', (e) => {
  S.voice = e.target.checked;
  save();
  if (S.voice) startVoice();
  else stopVoice();
});

for (const [id, key] of [
  ['s-fontFamily', 'fontFamily'],
  ['s-align', 'align'],
  ['s-background', 'background'],
]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setSetting(key, b.dataset.v);
  });
}

$('btn-reset').onclick = () => {
  Object.assign(S, DEFAULTS);
  applySettings();
  requestAnimationFrame(relayout);
};

$('btn-settings').onclick = () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('btn-settings').setAttribute('aria-expanded', String(open));
  $('btn-settings').classList.toggle('is-on', open);
};
$('btn-settings-close').onclick = () => {
  $('settings').hidden = true;
  $('btn-settings').classList.remove('is-on');
};

$('btn-collapse').onclick = () => setSetting('editorHidden', true, { relayout: true });
$('btn-editor').onclick = () => setSetting('editorHidden', !S.editorHidden, { relayout: true });

/* --- float -------------------------------------------------------------- */
$('btn-float').onclick = openFloat;
$('btn-unfloat').onclick = closeFloat;

/* --- help --------------------------------------------------------------- */
$('btn-help').onclick = () => ($('help').hidden = false);
$('help-close').onclick = () => {
  $('help').hidden = true;
  db.seenHelp = true;
  save();
};
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) $('help-close').click();
});

/* --- keyboard ----------------------------------------------------------- */
function onKey(e) {
  const t = e.target;
  const typing =
    t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
  if (typing) return;
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
      setSetting('fontSize', clamp(S.fontSize + 2, 14, 120));
      break;
    case '-':
    case '_':
      setSetting('fontSize', clamp(S.fontSize - 2, 14, 120));
      break;
    case 'Escape':
      if (pipWindow) closeFloat();
      break;
    default:
      break;
  }
}
document.addEventListener('keydown', onKey);

/* --- resize ------------------------------------------------------------- */
const ro = new ResizeObserver(() => requestAnimationFrame(relayout));
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
      'Your browser does not support always-on-top prompter windows. Chrome, Edge, Arc and Brave do.';
    $('voice-tag').textContent = SpeechRec ? 'beta' : 'unavailable here';
    if (!SpeechRec) $('voice-tag').classList.add('bad');
  }

  renderLibrary();
  applySettings();
  renderScript();
  syncPlayButtons();
  voiceStatus(
    SpeechRec ? 'Off. Cueline scrolls at the speed you set.' : 'Not available in this browser.',
    ''
  );
  if (S.voice) startVoice();

  if (!db.seenHelp) $('help').hidden = false;

  tickUI(true);
  scheduleFrame();
})();
