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
app.setPath('userData', testState);

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
        main: rect(document.querySelector('.main')),
        prompt: rect(prompt),
        firstSense: firstSense ? rect(firstSense) : null,
        background: getComputedStyle(prompt).backgroundColor,
        calibratorDisplay: getComputedStyle(document.getElementById('shell-calibrator')).display,
      };
    })()`);

    assert.strictEqual(surface.shellBody, true, 'renderer did not enter shell mode');
    assert.strictEqual(surface.arranging, true, 'Arrange chrome is missing on first launch');
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

    passed = true;
    console.log(JSON.stringify({
      passed: true,
      capturePath,
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
