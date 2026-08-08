'use strict';

/*
 * Real-window smoke test for the desktop shell. Static source tests cannot
 * prove that Chromium, Electron and macOS agree on transparency, bounds or
 * focus. This boots the production main process against isolated state, probes
 * the live renderer, exercises the native controls, and captures the Arrange
 * surface for visual review.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const testState = path.join(os.tmpdir(), `cueline-shell-smoke-${process.pid}`);
const capturePath = process.env.CUELINE_SMOKE_CAPTURE || path.join(os.tmpdir(), 'cueline-shell-arrange.png');
const controlsCapturePath = process.env.CUELINE_CONTROLS_CAPTURE || path.join(os.tmpdir(), 'cueline-control-center.png');
app.setPath('userData', testState);

// Exercise the complete local-recognition lifecycle without ever opening a
// microphone in an automated test. The production process contract is the
// same; only the executable is replaced by a deterministic line emitter.
fs.mkdirSync(testState, { recursive: true });
const fakeWhisper = path.join(testState, 'fake-whisperkit');
fs.writeFileSync(
  fakeWhisper,
  `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(0));
process.stdout.write('Cueline follows the speaker and waits through every pause.\\n');
setInterval(() => {}, 1000);
`
);
fs.chmodSync(fakeWhisper, 0o755);
process.env.CUELINE_WHISPERKIT = fakeWhisper;

require('./main');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alphaProfile(image) {
  const bitmap = image.toBitmap();
  let transparent = 0;
  let partial = 0;
  let opaque = 0;
  let alphaSum = 0;
  for (let i = 3; i < bitmap.length; i += 4) {
    const alpha = bitmap[i];
    alphaSum += alpha;
    if (alpha === 0) transparent++;
    else if (alpha === 255) opaque++;
    else partial++;
  }
  const pixels = transparent + partial + opaque;
  return {
    transparent: Number((transparent / pixels).toFixed(4)),
    partial: Number((partial / pixels).toFixed(4)),
    opaque: Number((opaque / pixels).toFixed(4)),
    mean: Number((alphaSum / pixels / 255).toFixed(4)),
  };
}

async function waitForWindow() {
  for (let i = 0; i < 100; i++) {
    const candidate = BrowserWindow.getAllWindows()[0];
    if (candidate && !candidate.isDestroyed() && !candidate.webContents.isLoadingMainFrame()) {
      await delay(180);
      return candidate;
    }
    await delay(50);
  }
  throw new Error('Cueline window did not finish loading');
}

async function waitForControlCenter() {
  for (let i = 0; i < 100; i++) {
    const candidate = BrowserWindow.getAllWindows().find(
      (window) => window.getTitle() === 'Cueline Control Center'
    );
    if (candidate && !candidate.isDestroyed() && !candidate.webContents.isLoadingMainFrame()) {
      await delay(180);
      return candidate;
    }
    await delay(50);
  }
  throw new Error('Control Center did not finish loading');
}

async function info(win) {
  return win.webContents.executeJavaScript('window.cuelineShell.info()');
}

async function waitForInfo(win, predicate, label) {
  let current = null;
  for (let i = 0; i < 60; i++) {
    current = await info(win);
    if (predicate(current)) return current;
    await delay(50);
  }
  throw new Error(`${label}: ${JSON.stringify(current)}`);
}

async function send(win, type, payload = {}) {
  await win.webContents.executeJavaScript(
    `window.cuelineShell.send(${JSON.stringify(type)}, ${JSON.stringify(payload)})`
  );
  await delay(120);
}

app.whenReady().then(async () => {
  let passed = false;
  let alphaStats = null;
  try {
    const win = await waitForWindow();
    const initialBounds = win.getBounds();
    assert.deepStrictEqual(
      { width: initialBounds.width, height: initialBounds.height },
      { width: 680, height: 260 },
      'first launch should use the focused Standard lens'
    );
    assert.strictEqual(win.isAlwaysOnTop(), true, 'overlay must stay above Zoom');
    assert.strictEqual(win.isFocusable(), true, 'first launch should enter Arrange');

    const surface = await win.webContents.executeJavaScript(`(() => {
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const prompt = document.getElementById('prompter');
      const firstSense = prompt.querySelector('.sense');
      return {
        shellBody: document.body.classList.contains('shell-body'),
        arranging: document.documentElement.classList.contains('shell-adjusting'),
        rolling: document.getElementById('app').classList.contains('rolling'),
        countdownHidden: document.getElementById('p-countdown').hidden,
        countdownDisplay: getComputedStyle(document.getElementById('p-countdown')).display,
        main: rect(document.querySelector('.main')),
        prompt: rect(prompt),
        firstSense: firstSense ? rect(firstSense) : null,
        background: getComputedStyle(prompt).backgroundColor,
        calibratorDisplay: getComputedStyle(document.getElementById('shell-calibrator')).display,
      };
    })()`);

    assert.strictEqual(surface.shellBody, true, 'renderer did not enter shell mode');
    assert.strictEqual(surface.arranging, true, 'Arrange chrome is missing on first launch');
    assert.strictEqual(surface.rolling, false, 'overlay started rolling before a transport command');
    assert.strictEqual(surface.countdownHidden, true, 'countdown was armed before a transport command');
    assert.strictEqual(surface.countdownDisplay, 'none', 'hidden countdown still paints over the overlay');
    assert.strictEqual(surface.calibratorDisplay, 'block', 'Arrange bounds are not visible');
    assert(surface.main.width >= 679 && surface.prompt.width >= 679, 'prompter does not fill the native window');
    assert(surface.firstSense, 'script failed to render');
    const senseCentre = surface.firstSense.x + surface.firstSense.width / 2;
    assert(Math.abs(senseCentre - surface.prompt.width / 2) < 3, 'sense lines are stranded away from the lens');
    assert(/rgba?\(0, 0, 0, 0\.32\)/.test(surface.background), 'default backdrop is not 32%');

    const capture = await win.capturePage();
    fs.writeFileSync(capturePath, capture.toPNG());
    alphaStats = alphaProfile(capture);
    assert(alphaStats.partial > 0.45, 'the adjustable translucent backdrop is not present in the capture');

    await send(win, 'setBackdropOpacity', { value: 0 });
    await send(win, 'setArrange', { on: false });
    const clearAlpha = alphaProfile(await win.capturePage());
    const clearBackdrop = await win.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('prompter')).backgroundColor`
    );
    assert(
      clearAlpha.transparent > 0.7 && clearAlpha.mean < 0.18,
      `Clear does not expose the desktop behind the reading surface: ${clearBackdrop} ${JSON.stringify(clearAlpha)}`
    );

    await send(win, 'setBackdropOpacity', { value: 1 });
    const solidAlpha = alphaProfile(await win.capturePage());
    assert(
      solidAlpha.opaque > 0.98,
      `Solid does not create a fully opaque reading surface: ${JSON.stringify(solidAlpha)}`
    );

    await send(win, 'setArrange', { on: true });
    await send(win, 'setBackdropOpacity', { value: 0.55 });
    const opacity = await win.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('prompter')).backgroundColor`
    );
    assert(/rgba?\(0, 0, 0, 0\.55\)/.test(opacity), 'backdrop slider does not reach the live surface');

    await send(win, 'setPreset', { name: 'compact' });
    let bounds = win.getBounds();
    assert.deepStrictEqual(
      { width: bounds.width, height: bounds.height },
      { width: 520, height: 210 },
      'Compact preset did not change native bounds'
    );

    await send(win, 'beginResize', {
      edge: 'se',
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
    });
    await send(win, 'resizeTo', {
      x: bounds.x + bounds.width + 100,
      y: bounds.y + bounds.height + 40,
    });
    await send(win, 'endResize');
    bounds = win.getBounds();
    assert.deepStrictEqual(
      { width: bounds.width, height: bounds.height },
      { width: 620, height: 250 },
      'explicit corner resize did not change native bounds'
    );

    await send(win, 'placeUnderCamera');
    bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    assert.strictEqual(bounds.x, Math.round(area.x + (area.width - bounds.width) / 2));
    assert.strictEqual(bounds.y, area.y + 8);

    await send(win, 'setArrange', { on: false });
    assert.strictEqual(win.isFocusable(), false, 'Present must return focus to Zoom');
    const stillAdjusting = await win.webContents.executeJavaScript(
      `document.documentElement.classList.contains('shell-adjusting')`
    );
    assert.strictEqual(stillAdjusting, false, 'Arrange chrome remains visible in Present');

    await send(win, 'openControls');
    const controls = await waitForControlCenter();
    const controlsSurface = await controls.webContents.executeJavaScript(`(() => ({
      heading: document.querySelector('h1')?.textContent,
      shortcutRows: document.querySelectorAll('[data-hotkey-action]').length,
      localDisabled: document.querySelector('[data-voice-mode="local"]').disabled,
      privacy: document.getElementById('privacy-title')?.textContent,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    }))()`);
    assert.strictEqual(controlsSurface.heading, 'Control Center', 'Control Center did not render');
    assert.strictEqual(controlsSurface.shortcutRows, 14, 'not every global shortcut is editable');
    assert.strictEqual(controlsSurface.localDisabled, false, 'installed local speech engine is disabled');
    assert(/source selection/i.test(controlsSurface.privacy), 'capture boundary is not stated in Control Center');
    assert.strictEqual(controlsSurface.bodyBackground, 'rgb(11, 11, 11)', 'Control Center surface is visually unstyled');
    fs.writeFileSync(controlsCapturePath, (await controls.capturePage()).toPNG());

    await send(win, 'setHotkey', { action: 'playPause', accelerator: 'Control+Alt+Shift+F10' });
    let current = await info(win);
    assert.strictEqual(current.hotkeys.playPause, 'Control+Alt+Shift+F10', 'custom shortcut was not registered');
    await send(win, 'resetHotkeys');
    current = await info(win);
    assert.strictEqual(current.hotkeys.playPause, 'Control+Alt+Space', 'default shortcuts were not restored');

    await send(win, 'localVoiceStart');
    current = await waitForInfo(
      win,
      (next) => next.localVoice.status === 'listening',
      'local speech subprocess did not reach listening'
    );
    assert.strictEqual(current.localVoice.status, 'listening', 'local speech subprocess did not reach listening');
    await send(win, 'localVoiceStop');
    current = await waitForInfo(
      win,
      (next) => next.localVoice.status === 'off',
      'local speech subprocess did not release on Stop'
    );
    assert.strictEqual(current.localVoice.status, 'off', 'local speech subprocess did not release on Stop');

    passed = true;
    console.log(JSON.stringify({
      passed: true,
      capturePath,
      controlsCapturePath,
      initialBounds,
      finalBounds: bounds,
      backdrop: opacity,
      alphaStats,
    }, null, 2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    setTimeout(() => app.quit(), passed ? 80 : 250);
  }
});

app.on('quit', () => {
  try {
    fs.rmSync(testState, { recursive: true, force: true });
  } catch {
    /* isolated smoke state can be left for the OS to clean up */
  }
});
