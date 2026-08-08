'use strict';

const SHELL = window.cuelineShell;
const $ = (id) => document.getElementById(id);
let state = null;
let recordingAction = null;
let toastTimer = null;

function acceleratorLabel(accelerator) {
  return String(accelerator || '')
    .replace(/CommandOrControl|CmdOrCtrl|Command/g, '⌘')
    .replace(/Control/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '')
    .replace(/Space/g, 'Space')
    .replace(/Up/g, '↑')
    .replace(/Down/g, '↓')
    .replace(/Left/g, '←')
    .replace(/Right/g, '→');
}

function keyName(event) {
  const map = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    '-': '-',
    '=': '=',
    '[': '[',
    ']': ']',
    ';': ';',
    "'": "'",
    ',': ',',
    '.': '.',
    '/': '/',
    '\\': '\\',
  };
  if (map[event.key]) return map[event.key];
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase();
  if (/^F\d{1,2}$/.test(event.key)) return event.key;
  return null;
}

function eventAccelerator(event) {
  const key = keyName(event);
  if (!key) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');
  if (!parts.length) return null;
  parts.push(key);
  return parts.join('+');
}

function toast(message, bad = false) {
  const node = $('control-toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 4200);
}

function renderHotkeys() {
  if (!state || !state.hotkeys || !state.hotkeyLabels) return;
  const grid = $('hotkey-grid');
  grid.innerHTML = Object.keys(state.hotkeyLabels)
    .map((action) => {
      const recording = recordingAction === action;
      return `<div class="hotkey-row">
        <span class="hotkey-label">${state.hotkeyLabels[action]}</span>
        <button class="hotkey-binding${recording ? ' recording' : ''}" data-hotkey-action="${action}"
          aria-label="Change ${state.hotkeyLabels[action]}">${recording ? 'Press keys…' : acceleratorLabel(state.hotkeys[action])}</button>
      </div>`;
    })
    .join('');
}

function renderVoice() {
  if (!state) return;
  const mode = state.rendererState?.voiceMode || 'off';
  const playing = !!state.rendererState?.playing;
  const local = state.localVoice || {};

  document.querySelectorAll('[data-voice-mode]').forEach((button) => {
    const selected = button.dataset.voiceMode === mode;
    button.classList.toggle('is-on', selected);
    button.setAttribute('aria-checked', String(selected));
    if (button.dataset.voiceMode === 'local') button.disabled = !local.available;
  });

  const engine = $('voice-engine-state');
  const engineStatus = local.available ? local.status || 'ready' : 'unavailable';
  engine.className = `engine-state ${engineStatus}`;
  engine.querySelector('span').textContent = local.available
    ? local.status === 'starting' || local.status === 'preparing'
      ? 'Preparing WhisperKit…'
      : local.status === 'listening'
        ? 'WhisperKit listening'
        : 'WhisperKit ready · on device'
    : 'WhisperKit unavailable';
  $('voice-install').hidden = !!local.available;

  const title = $('voice-status-title');
  const copy = $('voice-status-copy');
  if (local.status === 'error' || local.status === 'unavailable') {
    title.textContent = 'Voice engine needs attention';
    copy.textContent = local.error || 'Open the setup note below.';
  } else if (playing && mode === 'local') {
    title.textContent = local.status === 'listening' ? 'Following your words' : 'Preparing local recognition';
    copy.textContent = 'Audio remains on this Mac and is discarded as it is processed.';
  } else if (playing && mode === 'pace') {
    title.textContent = 'Following your speaking cadence';
    copy.textContent = 'The script advances while you speak and holds during silence.';
  } else if (mode === 'off') {
    title.textContent = 'Clock mode';
    copy.textContent = 'The script advances at the selected words-per-minute rate.';
  } else {
    title.textContent = 'Armed, not listening';
    copy.textContent = 'Press Start when you are ready; the microphone stays closed until then.';
  }

  const toggle = $('voice-toggle');
  toggle.textContent = playing ? 'Stop listening' : mode === 'off' ? 'Start prompter' : 'Start listening';
}

function applyState(next) {
  if (!next) return;
  state = next;
  renderVoice();
  renderHotkeys();
}

$('hotkey-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-hotkey-action]');
  if (!button) return;
  recordingAction = button.dataset.hotkeyAction;
  renderHotkeys();
  button.focus();
});

document.addEventListener('keydown', (event) => {
  if (!recordingAction) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    recordingAction = null;
    renderHotkeys();
    return;
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  const accelerator = eventAccelerator(event);
  if (!accelerator) {
    toast('Use at least one modifier plus a letter, number, arrow, or Space.', true);
    return;
  }
  SHELL.send('setHotkey', { action: recordingAction, accelerator });
});

$('reset-hotkeys').onclick = () => SHELL.send('resetHotkeys');
$('voice-toggle').onclick = () => SHELL.send('command', { action: 'playPause' });

document.querySelector('.voice-modes').addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice-mode]');
  if (!button || button.disabled) return;
  SHELL.send('setVoiceMode', { mode: button.dataset.voiceMode });
});

SHELL.on((message) => {
  if (!message) return;
  if (message.type === 'shellState') applyState(message.payload);
  if (message.type === 'hotkeyResult') {
    const result = message.payload || {};
    if (result.ok) {
      recordingAction = null;
      toast(result.action === 'reset' ? 'Default shortcuts restored.' : 'Shortcut updated.');
    } else {
      toast(result.error || 'That shortcut could not be registered.', true);
    }
    renderHotkeys();
  }
});

SHELL.info().then(applyState).catch(() => {
  toast('Could not connect to the Cueline overlay.', true);
});
