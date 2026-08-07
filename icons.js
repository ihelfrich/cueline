'use strict';

/**
 * Cueline icon set.
 *
 * One hand-drawn set on a single 24x24 grid: 20x20 live area, 1.75 stroke,
 * round caps and joins, fill:none, stroke:currentColor. Because colour comes
 * from the button's own `color`, states like .p-play.on need no extra rules.
 *
 * Replaces the Unicode glyphs the transport used to borrow from the text font
 * (U+27F2, U+2912/2913, "A+"/"A-"), which rendered at a different stroke
 * weight and optical centre from the real SVGs beside them — the clearest
 * single tell of an unfinished interface.
 */

const ICON_ATTRS =
  'viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false"';

const ICON_PATHS = {
  'play':
    '<path d="M9 6.5 18 12 9 17.5Z" fill="currentColor" stroke="currentColor"/>',
  'pause':
    '<path d="M7.5 6.5h2v11h-2zM14.5 6.5h2v11h-2z" fill="currentColor" stroke="currentColor"/>',
  'restart':
    '<path d="M5.5 4.5h13M12 19.5V8.25m-4 4 4-4 4 4"/>',
  'prev-section':
    '<path d="M6.75 6.5v11M17 6.5 10 12l7 5.5"/>',
  'next-section':
    '<path d="M17.25 6.5v11M7 6.5 14 12l-7 5.5"/>',
  'nudge-back':
    '<path d="M5.5 15.75h13M8 12l4-4 4 4"/>',
  'nudge-forward':
    '<path d="M5.5 8.25h13M8 12l4 4 4-4"/>',
  'speed-up':
    '<path d="m6.5 11.5 5.5-5.5 5.5 5.5M6.5 18l5.5-5.5 5.5 5.5"/>',
  'speed-down':
    '<path d="M6.5 6 12 11.5 17.5 6M6.5 12.5 12 18l5.5-5.5"/>',
  'text-bigger':
    '<path d="M4 17.75 7.5 6.25 11 17.75M5.4 13.6h4.2M17.25 9.5v5M14.75 12h5"/>',
  'text-smaller':
    '<path d="M4 17.75 7.5 6.25 11 17.75M5.4 13.6h4.2M14.75 12h5"/>',
  'mirror-horizontal':
    '<path d="M12 4.8v14.4" stroke-dasharray="2.8 3" stroke-linecap="butt"/><path d="M9.25 7v10L4.5 12Z"/><path d="M14.75 7v10L19.5 12Z"/>',
  'flip-vertical':
    '<path d="M4.8 12h14.4" stroke-dasharray="2.8 3" stroke-linecap="butt"/><path d="M7 9.25h10L12 4.5Z"/><path d="M7 14.75h10L12 19.5Z"/>',
  'float':
    '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="11.5" y="10.75" width="6" height="4.75" rx="1.25"/>',
  'exit-float':
    '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M16 16 9.5 9.5M14 9.5H9.5V14"/>',
  'fullscreen':
    '<path d="M9 4H5.75A1.75 1.75 0 0 0 4 5.75V9M15 4h3.25A1.75 1.75 0 0 1 20 5.75V9M9 20H5.75A1.75 1.75 0 0 1 4 18.25V15M15 20h3.25A1.75 1.75 0 0 0 20 18.25V15"/>',
  'exit-fullscreen':
    '<path d="M4 9h3.25A1.75 1.75 0 0 0 9 7.25V4M20 9h-3.25A1.75 1.75 0 0 1 15 7.25V4M4 15h3.25A1.75 1.75 0 0 1 9 16.75V20M20 15h-3.25A1.75 1.75 0 0 0 15 16.75V20"/>',
  'settings':
    '<path d="M6.5 4v16M12 4v16M17.5 4v16M3.75 9h5.5M9.25 15h5.5M14.75 7.5h5.5"/>',
  'help':
    '<circle cx="12" cy="12" r="8.25"/><path d="M9.6 9.4a2.45 2.45 0 1 1 3.55 2.3c-.72.44-1.15 1-1.15 1.8v.45"/><path d="M12 16.9h.01"/>',
  'microphone':
    '<rect x="9.25" y="3" width="5.5" height="10.5" rx="2.75"/><path d="M6.25 11.25v.75a5.75 5.75 0 0 0 11.5 0v-.75"/><path d="M12 17.75v2.75"/><path d="M9 20.5h6"/>',
  'microphone-off':
    '<mask id="cl-mic-off" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/><path d="M4.75 4.75 19.25 19.25" stroke="#000" stroke-width="4" stroke-linecap="round"/></mask><g mask="url(#cl-mic-off)"><rect x="9.25" y="3" width="5.5" height="10.5" rx="2.75"/><path d="M6.25 11.25v.75a5.75 5.75 0 0 0 11.5 0v-.75"/><path d="M12 17.75v2.75"/><path d="M9 20.5h6"/></g><path d="M4.75 4.75 19.25 19.25"/>',
  'editor-panel':
    '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M9.5 5v14M12.75 9.75h5.25M12.75 14.25h3.5"/>',
  'close':
    '<path d="M6 6 18 18M18 6 6 18"/>',
  'check':
    '<path d="M5 12.75 9.5 17.25 19 6.75"/>',
  'chevron-down':
    '<path d="m6.5 9.25 5.5 5.5 5.5-5.5"/>',
  'warning':
    '<path d="M12.8 5.05 20.55 18.25a1.05 1.05 0 0 1-.9 1.6H4.35a1.05 1.05 0 0 1-.9-1.6L11.2 5.05a1.05 1.05 0 0 1 1.6 0Z"/><path d="M12 9.75v4"/><path d="M12 16.75h.01"/>',
  'timer-target':
    '<circle cx="12" cy="13" r="6.75"/><path d="M9.75 2.75h4.5M12 2.75v3.5M12 13l3.25-3.25"/>',
  'cueline-wordmark':
    '<g stroke="currentColor" stroke-width="2.75" stroke-linecap="round"><path d="M8 5.75h12.25" opacity=".34"/><path d="M8 12h13.25"/><path d="M8 18.25h9.75" opacity=".34"/></g><path d="M2 8.6 6 12 2 15.4Z" fill="currentColor" stroke="none"/>',
};

/** Inline SVG markup for an icon name. */
function icon(name) {
  const body = ICON_PATHS[name];
  if (!body) return '';
  return '<svg class="ic ic-' + name + '" ' + ICON_ATTRS + '>' + body + '</svg>';
}

/** Replace every [data-icon] placeholder in a root with its drawn icon. */
function paintIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((n) => {
    const name = n.dataset.icon;
    if (!name || n.dataset.iconPainted === name) return;
    n.innerHTML = icon(name);
    n.dataset.iconPainted = name;
  });
}

window.CuelineIcons = { icon, paintIcons, names: Object.keys(ICON_PATHS) };
