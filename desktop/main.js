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
 *   2. Invisibility to screen capture. setContentProtection uses
 *      NSWindowSharingNone, so the prompter is excluded from screen sharing
 *      and screen recording at the OS level — including a full-screen share,
 *      which is the case a browser can never cover.
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
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(app.getPath('userData'), 'shell.json');
const STATE_VERSION = 3;

const PRESETS = Object.freeze({
  compact: { width: 520, height: 210 },
  standard: { width: 680, height: 260 },
  wide: { width: 860, height: 300 },
});
const MIN_SIZE = Object.freeze({ width: 420, height: 180 });
const MAX_SIZE = Object.freeze({ width: 1400, height: 640 });

let win = null;
let tray = null;
let hidden = false;
let arranging = false;
let backdropOpacity = 0.32;
let setupComplete = false;
let resizeGesture = null;

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
  if (saved.version !== STATE_VERSION) return {};
  backdropOpacity = clamp(saved.backdropOpacity, 0, 1, 0.32);
  setupComplete = !!saved.setupComplete;
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

/* -------------------------------------------------------------- commands */

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('cueline:shell', { type, payload });
}

function shellState() {
  return {
    arranging,
    backdropOpacity,
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    setupComplete,
    presets: PRESETS,
  };
}

function sendShellState() {
  send('shellState', shellState());
}

function persistShellState() {
  saveState({
    version: STATE_VERSION,
    bounds: win && !win.isDestroyed() ? win.getBounds() : undefined,
    backdropOpacity,
    setupComplete,
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
  placeUnderCamera,
  resetLayout,
  nudgeWindow: (dx, dy) => {
    if (!win) return;
    const b = win.getBounds();
    win.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
  },
};

/* Ctrl+Alt combinations: Zoom's own shortcuts on macOS are Command-based, so
   these do not collide with mute, video or share. */
const HOTKEYS = {
  'Control+Alt+Space': COMMANDS.playPause,
  'Control+Alt+Up': COMMANDS.faster,
  'Control+Alt+Down': COMMANDS.slower,
  'Control+Alt+Right': COMMANDS.nextSection,
  'Control+Alt+Left': COMMANDS.prevSection,
  'Control+Alt+[': COMMANDS.nudgeBack,
  'Control+Alt+]': COMMANDS.nudgeForward,
  'Control+Alt+R': COMMANDS.restart,
  'Control+Alt+=': COMMANDS.bigger,
  'Control+Alt+-': COMMANDS.smaller,
  'Control+Alt+I': COMMANDS.toggleArrange,
  'Control+Alt+H': COMMANDS.toggleHidden,
  'Control+Alt+Q': COMMANDS.quit,
};

function registerHotkeys() {
  const failed = [];
  for (const [accel, fn] of Object.entries(HOTKEYS)) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(accel);
  }
  if (failed.length) {
    // Surface it rather than letting a shortcut silently do nothing on stage.
    console.warn('[cueline] these shortcuts were already taken:', failed.join(', '));
  }
  return failed;
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
        { label: hidden ? 'Show prompter' : 'Hide prompter', accelerator: 'Control+Alt+H', click: COMMANDS.toggleHidden },
        {
          label: arranging ? 'Done arranging' : 'Arrange overlay…',
          accelerator: 'Control+Alt+I',
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
        { label: 'Start / stop', accelerator: 'Control+Alt+Space', click: COMMANDS.playPause },
        { label: 'Back to top', accelerator: 'Control+Alt+R', click: COMMANDS.restart },
        { type: 'separator' },
        { label: 'Edit the script in a browser', click: () => shell.openExternal('https://ihelfrich.github.io/cueline/') },
        { label: 'Reset layout…', click: COMMANDS.resetLayout },
        { type: 'separator' },
        { label: 'Hidden from screen sharing', enabled: false },
        { type: 'separator' },
        { label: 'Quit Cueline', accelerator: 'Control+Alt+Q', click: () => app.quit() },
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
    const failed = registerHotkeys();

    ipcMain.handle('cueline:shellInfo', () => ({
      isShell: true,
      ...shellState(),
      hotkeys: HOTKEYS ? Object.keys(HOTKEYS) : [],
      failedHotkeys: failed,
      contentProtection: true,
    }));

    ipcMain.on('cueline:shellAction', (_e, msg) => {
      if (!msg) return;
      if (msg.type === 'quit') app.quit();
      else if (msg.type === 'setArrange') setArranging(!!msg.on);
      else if (msg.type === 'setBackdropOpacity') setBackdropOpacity(msg.value);
      else if (msg.type === 'setPreset') applyPreset(msg.name);
      else if (msg.type === 'placeUnderCamera') placeUnderCamera();
      else if (msg.type === 'resetLayout') resetLayout();
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

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
