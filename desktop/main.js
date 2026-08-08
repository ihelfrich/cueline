'use strict';

/*
 * Cueline desktop shell.
 *
 * This exists for the four things a web page is not allowed to do, no matter
 * how it is written:
 *
 *   1. A genuinely transparent window. A browser's Picture-in-Picture window
 *      is a real OS window with an opaque backing store, and no CSS or API
 *      can make it see-through. Here the script floats over the desktop with
 *      nothing behind it.
 *   2. Best-effort capture protection. setContentProtection asks macOS not to
 *      share the window through legacy capture paths. Electron explicitly
 *      warns that modern ScreenCaptureKit clients may ignore that request, so
 *      a selected-window share is the only privacy boundary we promise.
 *   3. Click-through. Mouse events pass straight to Zoom underneath, so the
 *      overlay can never steal a click or focus.
 *   4. Global hotkeys. Transport control that works while Zoom holds the
 *      keyboard, which is the whole problem with driving a prompter from a
 *      browser tab.
 *
 * Everything else — the prompter, the timing model, voice follow, the whole
 * interface — is the identical web app loaded from the parent directory. This
 * shell adds those window powers and the small arrangement surface required
 * to control an otherwise invisible frameless window.
 */

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(app.getPath('userData'), 'shell.json');
const STATE_VERSION = 4;

const PRESETS = Object.freeze({
  compact: { width: 520, height: 210 },
  standard: { width: 680, height: 260 },
  wide: { width: 860, height: 300 },
});
const MIN_SIZE = Object.freeze({ width: 420, height: 180 });
const MAX_SIZE = Object.freeze({ width: 1400, height: 640 });

/* A left-hand transport cluster. Control+Option stays under the little and
 * ring fingers; the action keys mirror WASD navigation and Q/E line nudges.
 * Every binding is editable and this exact map is always one click away. */
const DEFAULT_HOTKEYS = Object.freeze({
  playPause: 'Control+Alt+Space',
  faster: 'Control+Alt+W',
  slower: 'Control+Alt+S',
  prevSection: 'Control+Alt+A',
  nextSection: 'Control+Alt+D',
  nudgeBack: 'Control+Alt+Q',
  nudgeForward: 'Control+Alt+E',
  restart: 'Control+Alt+R',
  smaller: 'Control+Alt+Z',
  bigger: 'Control+Alt+X',
  toggleArrange: 'Control+Alt+G',
  toggleHidden: 'Control+Alt+H',
  openControls: 'Control+Alt+C',
  quit: 'Control+Alt+Shift+Q',
});

const HOTKEY_LABELS = Object.freeze({
  playPause: 'Start / stop',
  faster: 'Faster',
  slower: 'Slower',
  prevSection: 'Previous section',
  nextSection: 'Next section',
  nudgeBack: 'Back one line',
  nudgeForward: 'Forward one line',
  restart: 'Back to top',
  smaller: 'Smaller type',
  bigger: 'Larger type',
  toggleArrange: 'Arrange overlay',
  toggleHidden: 'Hide / show',
  openControls: 'Open Control Center',
  quit: 'Quit Cueline',
});

let win = null;
let controlsWin = null;
let tray = null;
let hidden = false;
let arranging = false;
let backdropOpacity = 0.32;
let setupComplete = false;
let resizeGesture = null;
let hotkeys = { ...DEFAULT_HOTKEYS };
let failedHotkeys = [];
let rendererState = { voiceMode: 'off', playing: false };
let localVoiceProcess = null;
let localVoiceStatus = 'off';
let localVoiceError = '';

/* ------------------------------------------------------------------ state */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    const next = { ...loadState(), ...patch };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* a lost window position is not worth surfacing */
  }
}

function clamp(value, lo, hi, fallback = lo) {
  const n = Number(value);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback));
}

/** Ignore geometry from older builds: it was saved while an invisible editor
 *  column still consumed a third of the shell, so preserving it would preserve
 *  the defect this state model replaces. */
function restoreShellState() {
  const saved = loadState();
  if (!Number.isFinite(saved.version) || saved.version < 3) return {};
  backdropOpacity = clamp(saved.backdropOpacity, 0, 1, 0.32);
  setupComplete = !!saved.setupComplete;
  hotkeys = Object.fromEntries(
    Object.keys(DEFAULT_HOTKEYS).map((action) => [
      action,
      typeof saved.hotkeys?.[action] === 'string' && saved.hotkeys[action]
        ? saved.hotkeys[action]
        : DEFAULT_HOTKEYS[action],
    ])
  );
  return saved;
}

/** A strip under the built-in camera: the closer to the lens, the better the
 *  eye-line reads to the people watching. */
function defaultBounds() {
  const d = screen.getPrimaryDisplay();
  const { width, height } = PRESETS.standard;
  return {
    x: Math.round(d.workArea.x + (d.workArea.width - width) / 2),
    y: d.workArea.y + 8,
    width,
    height,
  };
}

function normalizedBounds(bounds) {
  if (!bounds) return null;
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const width = clamp(bounds.width, MIN_SIZE.width, Math.min(MAX_SIZE.width, area.width), PRESETS.standard.width);
  const height = clamp(bounds.height, MIN_SIZE.height, Math.min(MAX_SIZE.height, area.height), PRESETS.standard.height);
  return {
    x: clamp(bounds.x, area.x - width + 80, area.x + area.width - 80),
    y: clamp(bounds.y, area.y, area.y + area.height - 80),
    width,
    height,
  };
}

/* ----------------------------------------------------------------- window */

function applyFlags() {
  if (!win || win.isDestroyed()) return;
  // 'screen-saver' is the level that floats above full-screen Zoom and the
  // menu bar. Anything lower loses the moment Zoom goes full screen.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  win.setContentProtection(true);
  win.setFocusable(arranging);
  win.setIgnoreMouseEvents(!arranging, { forward: true });

  if (arranging) {
    // Arrange is an explicit editing state. It takes focus and the mouse so
    // the bounds are real, visible controls rather than an invisible hit box.
    win.show();
    win.focus();
  }
}

function createWindow() {
  const saved = restoreShellState();
  arranging = !setupComplete;
  const bounds = normalizedBounds(saved.bounds) || defaultBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    maxWidth: MAX_SIZE.width,
    maxHeight: MAX_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Present mode never takes focus from Zoom. Arrange mode changes this
    // temporarily so its controls and native resize edges can work.
    focusable: arranging,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(ROOT, 'index.html'), { query: { shell: '1' } });

  win.once('ready-to-show', () => {
    applyFlags();
    if (arranging) win.show();
    else win.showInactive();
    sendShellState();
  });

  let rememberTimer = null;
  const remember = () => {
    // Dimensions should feel live in Arrange, but window drags can generate
    // hundreds of events. Keep disk writes off that hot path.
    sendShellState();
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(persistShellState, 140);
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('closed', () => {
    clearTimeout(rememberTimer);
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openControls() {
  if (controlsWin && !controlsWin.isDestroyed()) {
    controlsWin.show();
    controlsWin.focus();
    sendShellState();
    return;
  }

  const saved = loadState();
  controlsWin = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 620,
    minHeight: 560,
    ...(saved.controlsBounds || {}),
    title: 'Cueline Control Center',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0b0b0b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  controlsWin.setContentProtection(true);
  controlsWin.loadFile(path.join(__dirname, 'controls.html'));
  controlsWin.once('ready-to-show', () => {
    controlsWin.show();
    controlsWin.focus();
    sendShellState();
  });

  let rememberTimer = null;
  const remember = () => {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (controlsWin && !controlsWin.isDestroyed()) {
        saveState({ version: STATE_VERSION, controlsBounds: controlsWin.getBounds() });
      }
    }, 180);
  };
  controlsWin.on('moved', remember);
  controlsWin.on('resized', remember);
  controlsWin.on('closed', () => {
    clearTimeout(rememberTimer);
    controlsWin = null;
  });
  controlsWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* -------------------------------------------------------------- commands */

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('cueline:shell', { type, payload });
}

function sendControls(type, payload) {
  if (controlsWin && !controlsWin.isDestroyed()) {
    controlsWin.webContents.send('cueline:shell', { type, payload });
  }
}

function resolveWhisperKit() {
  const candidates = [
    process.env.CUELINE_WHISPERKIT,
    '/opt/homebrew/bin/whisperkit-cli',
    '/usr/local/bin/whisperkit-cli',
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function shellState() {
  return {
    arranging,
    backdropOpacity,
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    setupComplete,
    presets: PRESETS,
    hotkeys,
    hotkeyDefaults: DEFAULT_HOTKEYS,
    hotkeyLabels: HOTKEY_LABELS,
    failedHotkeys,
    rendererState,
    localVoice: {
      available: !!resolveWhisperKit(),
      engine: 'WhisperKit',
      model: 'tiny',
      status: localVoiceStatus,
      error: localVoiceError,
    },
  };
}

function sendShellState() {
  const state = shellState();
  send('shellState', state);
  sendControls('shellState', state);
}

function persistShellState() {
  saveState({
    version: STATE_VERSION,
    bounds: win && !win.isDestroyed() ? win.getBounds() : undefined,
    backdropOpacity,
    setupComplete,
    hotkeys,
  });
}

function setArranging(on) {
  arranging = !!on;
  if (arranging) hidden = false;
  if (!arranging) setupComplete = true;
  applyFlags();
  if (!arranging && win && !win.isDestroyed()) win.showInactive();
  persistShellState();
  trayRebuild();
  sendShellState();
}

function setBackdropOpacity(value) {
  backdropOpacity = clamp(value, 0, 1, backdropOpacity);
  persistShellState();
  trayRebuild();
  sendShellState();
}

function placeUnderCamera() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;
  const b = win.getBounds();
  win.setBounds({
    ...b,
    x: Math.round(area.x + (area.width - b.width) / 2),
    y: area.y + 8,
  });
}

function applyPreset(name) {
  if (!win || win.isDestroyed() || !PRESETS[name]) return;
  const p = PRESETS[name];
  const b = win.getBounds();
  // Preserve the horizontal centre when changing size, then snap back beneath
  // the camera. That is the only position that improves eye contact.
  win.setBounds({
    x: Math.round(b.x + (b.width - p.width) / 2),
    y: b.y,
    ...p,
  });
  placeUnderCamera();
}

function resetLayout() {
  backdropOpacity = 0.32;
  if (win && !win.isDestroyed()) win.setBounds(defaultBounds());
  setArranging(true);
}

/** Frameless transparent windows have inconsistent native resize hit targets
 *  across macOS/Electron releases. Arrange mode therefore owns an explicit
 *  resize gesture. The renderer sends screen coordinates from one of eight
 *  visible handles; the main process remains the only authority allowed to
 *  move the native window. */
function beginResize(edge, x, y) {
  if (!arranging || !win || win.isDestroyed()) return;
  if (!/^(?:n|e|s|w|ne|se|sw|nw)$/.test(edge)) return;
  const startX = Number(x);
  const startY = Number(y);
  if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;
  resizeGesture = { edge, startX, startY, bounds: win.getBounds() };
}

function resizeTo(x, y) {
  if (!resizeGesture || !win || win.isDestroyed()) return;
  const pointerX = Number(x);
  const pointerY = Number(y);
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return;

  const { edge, startX, startY, bounds: start } = resizeGesture;
  const display = screen.getDisplayMatching(start);
  const maxWidth = Math.min(MAX_SIZE.width, display.workArea.width);
  const maxHeight = Math.min(MAX_SIZE.height, display.workArea.height);
  const dx = pointerX - startX;
  const dy = pointerY - startY;
  let { x: nextX, y: nextY, width, height } = start;

  if (edge.includes('e')) width = clamp(start.width + dx, MIN_SIZE.width, maxWidth, start.width);
  if (edge.includes('s')) height = clamp(start.height + dy, MIN_SIZE.height, maxHeight, start.height);
  if (edge.includes('w')) {
    width = clamp(start.width - dx, MIN_SIZE.width, maxWidth, start.width);
    nextX = start.x + start.width - width;
  }
  if (edge.includes('n')) {
    height = clamp(start.height - dy, MIN_SIZE.height, maxHeight, start.height);
    nextY = start.y + start.height - height;
  }

  win.setBounds({
    x: Math.round(nextX),
    y: Math.round(nextY),
    width: Math.round(width),
    height: Math.round(height),
  });
}

function endResize() {
  resizeGesture = null;
  persistShellState();
}

const COMMANDS = {
  playPause: () => send('playPause'),
  faster: () => send('faster'),
  slower: () => send('slower'),
  nextSection: () => send('nextSection'),
  prevSection: () => send('prevSection'),
  nudgeBack: () => send('nudgeBack'),
  nudgeForward: () => send('nudgeForward'),
  restart: () => send('restart'),
  bigger: () => send('bigger'),
  smaller: () => send('smaller'),

  toggleArrange: () => setArranging(!arranging),
  toggleHidden: () => {
    if (!win) return;
    hidden = !hidden;
    if (hidden) win.hide();
    else if (arranging) {
      win.show();
      win.focus();
    } else win.showInactive();
    trayRebuild();
  },
  quit: () => app.quit(),
  openControls,
  placeUnderCamera,
  resetLayout,
  nudgeWindow: (dx, dy) => {
    if (!win) return;
    const b = win.getBounds();
    win.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
  },
};

function registerHotkeyMap(map) {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const action of Object.keys(DEFAULT_HOTKEYS)) {
    const accel = map[action];
    const fn = COMMANDS[action];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch {
      ok = false;
    }
    if (!ok) failed.push({ action, accelerator: accel });
  }
  if (failed.length) {
    // Surface it rather than letting a shortcut silently do nothing on stage.
    console.warn(
      '[cueline] these shortcuts were already taken:',
      failed.map((item) => item.accelerator).join(', ')
    );
  }
  return failed;
}

function registerHotkeys() {
  const failed = registerHotkeyMap(hotkeys);
  failedHotkeys = failed.map((item) => item.accelerator);
  return failedHotkeys;
}

function applyHotkeyMap(candidate, changedAction = null) {
  const accelerators = Object.values(candidate).map((value) => value.toLowerCase());
  if (new Set(accelerators).size !== accelerators.length) {
    sendControls('hotkeyResult', {
      ok: false,
      action: changedAction,
      error: 'That key combination is already assigned inside Cueline.',
    });
    return false;
  }

  const previous = hotkeys;
  const failed = registerHotkeyMap(candidate);
  if (failed.length) {
    const restoredFailures = registerHotkeyMap(previous);
    failedHotkeys = restoredFailures.map((item) => item.accelerator);
    sendControls('hotkeyResult', {
      ok: false,
      action: changedAction,
      error: `${failed[0].accelerator} is already reserved by macOS or another app.`,
    });
    sendShellState();
    return false;
  }

  hotkeys = { ...candidate };
  failedHotkeys = [];
  persistShellState();
  trayRebuild();
  sendControls('hotkeyResult', { ok: true, action: changedAction });
  sendShellState();
  return true;
}

function setHotkey(action, accelerator) {
  if (!(action in DEFAULT_HOTKEYS)) return;
  const value = String(accelerator || '').trim();
  if (!value || !/(?:Control|Alt|Shift|Command|CmdOrCtrl)\+/i.test(value)) {
    sendControls('hotkeyResult', {
      ok: false,
      action,
      error: 'Use at least one modifier plus a letter, number, arrow, or Space.',
    });
    return;
  }
  applyHotkeyMap({ ...hotkeys, [action]: value }, action);
}

function resetHotkeys() {
  applyHotkeyMap({ ...DEFAULT_HOTKEYS }, 'reset');
}

/* ------------------------------------------------------- local voice v2 */

let localVoiceStopping = false;

function setLocalVoiceStatus(status, error = '') {
  if (localVoiceStatus === status && localVoiceError === error) return;
  localVoiceStatus = status;
  localVoiceError = error;
  send('localVoiceStatus', { status, error });
  sendShellState();
}

function startLocalVoice() {
  if (localVoiceProcess) return;
  const executable = resolveWhisperKit();
  if (!executable) {
    setLocalVoiceStatus(
      'unavailable',
      'WhisperKit is not installed. Open Control Center for the one-command setup.'
    );
    return;
  }

  localVoiceStopping = false;
  setLocalVoiceStatus('starting');
  const language = String(rendererState.voiceLang || 'en').split('-')[0] || 'en';
  const child = spawn(
    executable,
    [
      'transcribe',
      '--stream',
      '--model',
      'tiny',
      '--language',
      language,
      '--word-timestamps',
      '--chunking-strategy',
      'vad',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    }
  );
  localVoiceProcess = child;

  let transcriptBuffer = '';
  const emitTranscript = (value, final = false) => {
    const text = String(value || '').trim();
    if (!text || /^\[|^(?:model|loading|download|audio)\b/i.test(text)) return;
    setLocalVoiceStatus('listening');
    send('localTranscript', { text, final });
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (localVoiceProcess !== child) return;
    transcriptBuffer += String(chunk)
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const parts = transcriptBuffer.split(/[\r\n]+/);
    transcriptBuffer = parts.pop() || '';
    for (const part of parts) emitTranscript(part, false);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (/download|load|model/i.test(line) && localVoiceStatus === 'starting') {
      setLocalVoiceStatus('preparing');
    }
  });

  child.on('error', (error) => {
    if (localVoiceProcess === child) localVoiceProcess = null;
    setLocalVoiceStatus('error', error && error.message ? error.message : 'Local speech engine failed.');
  });
  child.on('exit', (code, signal) => {
    // CLI output does not have to end in a newline. Preserve the final phrase
    // before releasing the process so the reader never loses the last words
    // of an utterance.
    if (!localVoiceStopping) emitTranscript(transcriptBuffer, true);
    transcriptBuffer = '';
    if (localVoiceProcess === child) localVoiceProcess = null;
    if (localVoiceStopping || signal === 'SIGTERM') setLocalVoiceStatus('off');
    else if (code === 0) setLocalVoiceStatus('off');
    else setLocalVoiceStatus('error', `Local speech engine stopped (${code ?? signal ?? 'unknown'}).`);
    localVoiceStopping = false;
  });
}

function stopLocalVoice() {
  const child = localVoiceProcess;
  if (!child) {
    setLocalVoiceStatus('off');
    return;
  }
  localVoiceStopping = true;
  child.kill('SIGTERM');
  setTimeout(() => {
    // `child.killed` means that a signal was sent, not that the process has
    // actually exited. Check exitCode so a wedged recogniser cannot hold the
    // microphone after the user pressed Stop.
    if (localVoiceProcess === child && child.exitCode === null) child.kill('SIGKILL');
  }, 1200);
}

/* -------------------------------------------------------------- menu bar */

/*
 * Without this the app is a trap. It hides its Dock icon so the overlay does
 * not clutter the switcher, and the window is deliberately not focusable so it
 * can never take a keystroke meant for Zoom — which together mean Command-Q
 * has nothing to quit. A menu-bar item is the standard macOS answer for an
 * agent app, and it is also where you go when you have forgotten the hotkeys.
 */
function createTray() {
  const icon = path.join(__dirname, 'trayTemplate.png');
  try {
    tray = new Tray(icon);
  } catch {
    return; // an app that cannot draw a tray icon should still run
  }
  tray.setToolTip('Cueline');

  const rebuild = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Control Center…', accelerator: hotkeys.openControls, click: COMMANDS.openControls },
        { type: 'separator' },
        { label: hidden ? 'Show prompter' : 'Hide prompter', accelerator: hotkeys.toggleHidden, click: COMMANDS.toggleHidden },
        {
          label: arranging ? 'Done arranging' : 'Arrange overlay…',
          accelerator: hotkeys.toggleArrange,
          click: COMMANDS.toggleArrange,
        },
        {
          label: 'Backdrop',
          submenu: [
            ['Clear', 0],
            ['15%', 0.15],
            ['30%', 0.3],
            ['50%', 0.5],
            ['70%', 0.7],
            ['85%', 0.85],
            ['Solid', 1],
          ].map(([label, value]) => ({
            label,
            type: 'radio',
            checked: Math.abs(backdropOpacity - value) < 0.035,
            click: () => setBackdropOpacity(value),
          })),
        },
        {
          label: 'Size',
          submenu: Object.entries(PRESETS).map(([name, bounds]) => ({
            label: `${name[0].toUpperCase()}${name.slice(1)}  —  ${bounds.width} × ${bounds.height}`,
            click: () => applyPreset(name),
          })),
        },
        { label: 'Place under camera', click: COMMANDS.placeUnderCamera },
        { type: 'separator' },
        { label: 'Start / stop', accelerator: hotkeys.playPause, click: COMMANDS.playPause },
        { label: 'Back to top', accelerator: hotkeys.restart, click: COMMANDS.restart },
        { type: 'separator' },
        { label: 'Edit the script in a browser', click: () => shell.openExternal('https://ihelfrich.github.io/cueline/') },
        { label: 'Reset layout…', click: COMMANDS.resetLayout },
        { type: 'separator' },
        { label: 'Capture protection on (best effort)', enabled: false },
        { label: 'For privacy: share one window, not the display', enabled: false },
        { type: 'separator' },
        { label: 'Quit Cueline', accelerator: hotkeys.quit, click: () => app.quit() },
      ])
    );
  };

  rebuild();
  trayRebuild = rebuild;
}

let trayRebuild = () => {};

/* ------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    hidden = false;
    if (arranging) {
      win.show();
      win.focus();
    } else win.showInactive();
    trayRebuild();
  });

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide(); // an overlay has no business in the Dock
    createWindow();
    createTray();
    registerHotkeys();

    ipcMain.handle('cueline:shellInfo', () => ({
      isShell: true,
      ...shellState(),
      contentProtection: true,
      captureProtectionScope: 'best-effort',
    }));

    ipcMain.on('cueline:shellAction', (_e, msg) => {
      if (!msg) return;
      if (msg.type === 'quit') app.quit();
      else if (msg.type === 'setArrange') setArranging(!!msg.on);
      else if (msg.type === 'setBackdropOpacity') setBackdropOpacity(msg.value);
      else if (msg.type === 'setPreset') applyPreset(msg.name);
      else if (msg.type === 'placeUnderCamera') placeUnderCamera();
      else if (msg.type === 'resetLayout') resetLayout();
      else if (msg.type === 'openControls') openControls();
      else if (msg.type === 'setHotkey') setHotkey(msg.action, msg.accelerator);
      else if (msg.type === 'resetHotkeys') resetHotkeys();
      else if (msg.type === 'command' && msg.action && COMMANDS[msg.action]) COMMANDS[msg.action]();
      else if (msg.type === 'localVoiceStart') startLocalVoice();
      else if (msg.type === 'localVoiceStop') stopLocalVoice();
      else if (msg.type === 'setVoiceMode') send('setVoiceMode', { mode: msg.mode });
      else if (msg.type === 'rendererState') {
        rendererState = {
          ...rendererState,
          voiceMode: typeof msg.voiceMode === 'string' ? msg.voiceMode : rendererState.voiceMode,
          voiceLang: typeof msg.voiceLang === 'string' ? msg.voiceLang : rendererState.voiceLang,
          playing: typeof msg.playing === 'boolean' ? msg.playing : rendererState.playing,
        };
        sendShellState();
      }
      else if (msg.type === 'beginResize') beginResize(msg.edge, msg.x, msg.y);
      else if (msg.type === 'resizeTo') resizeTo(msg.x, msg.y);
      else if (msg.type === 'endResize') endResize();
      else if (msg.type === 'setContentProtection' && win) {
        win.setContentProtection(!!msg.on);
      }
    });

    app.on('activate', () => {
      if (!win) createWindow();
    });
  });

  app.on('will-quit', () => {
    if (localVoiceProcess) localVoiceProcess.kill('SIGTERM');
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => app.quit());
}
