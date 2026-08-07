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
 * shell adds window powers and nothing else.
 */

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(app.getPath('userData'), 'shell.json');

let win = null;
let tray = null;
let clickThrough = true;
let hidden = false;

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

/** A strip under the built-in camera: the closer to the lens, the better the
 *  eye-line reads to the people watching. */
function defaultBounds() {
  const d = screen.getPrimaryDisplay();
  const width = Math.min(900, Math.round(d.bounds.width * 0.56));
  const height = 320;
  return {
    x: Math.round(d.bounds.x + (d.bounds.width - width) / 2),
    y: d.bounds.y,
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
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
}

function createWindow() {
  const saved = loadState().bounds;
  win = new BrowserWindow({
    ...(saved || defaultBounds()),
    minWidth: 320,
    minHeight: 140,
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
    // Never take focus from Zoom. Every control has a global hotkey.
    focusable: false,
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
    win.showInactive();
  });

  const remember = () => saveState({ bounds: win.getBounds() });
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('closed', () => {
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

  toggleClickThrough: () => {
    clickThrough = !clickThrough;
    applyFlags();
    trayRebuild();
    send('clickThrough', { on: clickThrough });
  },
  toggleHidden: () => {
    if (!win) return;
    hidden = !hidden;
    if (hidden) win.hide();
    else win.showInactive();
    trayRebuild();
  },
  quit: () => app.quit(),
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
  'Control+Alt+I': COMMANDS.toggleClickThrough,
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
          label: clickThrough ? 'Take the mouse' : 'Let clicks pass through',
          accelerator: 'Control+Alt+I',
          click: COMMANDS.toggleClickThrough,
        },
        { type: 'separator' },
        { label: 'Start / stop', accelerator: 'Control+Alt+Space', click: COMMANDS.playPause },
        { label: 'Back to top', accelerator: 'Control+Alt+R', click: COMMANDS.restart },
        { type: 'separator' },
        { label: 'Edit the script in a browser', click: () => shell.openExternal('https://ihelfrich.github.io/cueline/') },
        { label: 'Reset position', click: () => { if (win) win.setBounds(defaultBounds()); } },
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
  app.on('second-instance', () => win && win.showInactive());

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide(); // an overlay has no business in the Dock
    createWindow();
    createTray();
    const failed = registerHotkeys();

    ipcMain.handle('cueline:shellInfo', () => ({
      isShell: true,
      clickThrough,
      hotkeys: HOTKEYS ? Object.keys(HOTKEYS) : [],
      failedHotkeys: failed,
      contentProtection: true,
    }));

    ipcMain.on('cueline:shellAction', (_e, msg) => {
      if (!msg) return;
      if (msg.type === 'quit') app.quit();
      else if (msg.type === 'setClickThrough') {
        clickThrough = !!msg.on;
        applyFlags();
      } else if (msg.type === 'setContentProtection' && win) {
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
