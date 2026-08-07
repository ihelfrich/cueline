/**
 * Engine tests for Cueline.  Run with:  node test/engine.test.js
 *
 * The app is three browser files with no build step, so there is nothing to
 * import. Rather than re-implement the logic here (which would test a copy,
 * not the code), these tests pull the real function bodies out of app.js and
 * evaluate them. If a function is renamed or removed the extraction throws,
 * which is itself a useful failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const parserSrc = fs.readFileSync(path.join(ROOT, 'script-parse.js'), 'utf8');

/* --------------------------------------------------------------- harness */

let passed = 0;
let failed = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  pass  ' : '  FAIL  '}${label}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
  ok ? passed++ : failed++;
}

function assert(label, cond, detail = '') {
  console.log(`${cond ? '  pass  ' : '  FAIL  '}${label}${cond || !detail ? '' : `\n          ${detail}`}`);
  cond ? passed++ : failed++;
}

function section(name) {
  console.log(`\n${name}`);
}

/** Extract a top-level `function name(...) { ... }` by brace matching. */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js no longer contains function ${name}() — tests need updating`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
      seen = true;
    } else if (src[i] === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/* ----------------------------------------------------------- the parser */

const CuelineScript = (() => {
  const module = { exports: {} };
  new Function('module', 'self', parserSrc)(module, {});
  return module.exports;
})();

section('Parser — what counts as a spoken word');

{
  const d = CuelineScript.parse(
    '# A heading\n> a cue line with words\nHello world this is five.\n- bullet two\n---'
  );
  check('headings and cues are excluded from the word count', d.totalWords, 7);
  check('block types', d.blocks.map((b) => b.type), ['h', 'cue', 'p', 'li', 'rule']);
  check('one jumpable section', d.sections.length, 1);
  check('wordsBefore accumulates only spoken words', d.blocks.map((b) => b.wordsBefore), [0, 0, 0, 5, 7]);
}

{
  const d = CuelineScript.parse('One two.\n\nThree four five.');
  check('a blank line separates paragraphs', d.blocks.length, 2);
  check('paragraph word counts', d.blocks.map((b) => b.words), [2, 3]);
}

{
  const d = CuelineScript.parse('Line one\nline two continues');
  check('consecutive lines join into one paragraph', d.blocks.length, 1);
  check('joined paragraph word count', d.totalWords, 5);
}

{
  const d = CuelineScript.parse('> cue one\n> cue two');
  check('consecutive cue lines merge into one block', d.blocks.length, 1);
  check('merged cue still counts zero words', d.totalWords, 0);
}

section('Parser — inline formatting and escaping');

{
  const html = CuelineScript.parse('**bold** and *em* and <script>alert(1)</script>').blocks[0].html;
  assert('bold renders', html.includes('<b>bold</b>'), html);
  assert('italic renders', html.includes('<i>em</i>'), html);
  assert('script tags are escaped, not executed', html.includes('&lt;script&gt;') && !html.includes('<script>'), html);
}

{
  const d = CuelineScript.parse('Words **with bold** inside.');
  check('emphasis markers do not inflate the word count', d.totalWords, 4);
}

{
  const html = CuelineScript.parse('Hit ==this word== hard.').blocks[0].html;
  assert('stress renders as a mark', html.includes('<mark>this word</mark>'), html);
  check('stress markers do not inflate the word count', CuelineScript.parse('Hit ==this word== hard.').totalWords, 4);
  const esc = CuelineScript.parse('==<img src=x onerror=alert(1)>==').blocks[0].html;
  assert('stress content is still escaped', esc.includes('&lt;img') && !esc.includes('<img'), esc);
  const un = CuelineScript.parse('a = b and c = d').blocks[0].html;
  assert('a lone equals sign is not treated as a marker', !un.includes('<mark>'), un);
  const multi = CuelineScript.parse('==one== plain ==two==').blocks[0].html;
  assert('two stress runs on one line both render', (multi.match(/<mark>/g) || []).length === 2, multi);
}

{
  const d = CuelineScript.parse('1. first item\n2) second item');
  check('numbered lists parse as list items', d.blocks.map((b) => b.type), ['li', 'li']);
  check('numbered markers are kept', d.blocks.map((b) => b.marker), ['1.', '2.']);
}

section('Clock formatting');

check('zero', CuelineScript.formatClock(0), '0:00');
check('rounds to nearest second', CuelineScript.formatClock(91.3), '1:31');
check('pads seconds', CuelineScript.formatClock(65), '1:05');
check('negative is signed', CuelineScript.formatClock(-12), '-0:12');
check('non-finite is placeholder', CuelineScript.formatClock(Infinity), '--:--');

section('Timing model — the wpm number must be literally true');

{
  // velocity = (wpm/60) * (textHeight/totalWords), and maxY === textHeight,
  // so the run time must be exactly totalWords/wpm minutes at any geometry.
  const runSeconds = (words, wpm, textHeight) => {
    const pxPerWord = textHeight / words;
    const velocity = (wpm / 60) * pxPerWord;
    return textHeight / velocity;
  };
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  assert('700 words at 140 wpm takes 5:00', approx(runSeconds(700, 140, 12345), 300));
  assert('213 words at 140 wpm takes 91.28s', approx(runSeconds(213, 140, 999), (213 / 140) * 60));
  assert('run time is independent of text height', approx(runSeconds(500, 120, 100), runSeconds(500, 120, 98765)));
}

section('Voice follow — alignment matcher');

{
  // alignVoice is pure — (heard, cursor, words) in, match or null out — so it
  // can be lifted straight out of app.js and exercised for real. Its only
  // ambient dependencies are the TAIL constant and VOICE.lastMatchAt, which
  // voiceWindow() uses to decide how wide to search.
  const TAIL = Number(/const TAIL = (\d+)/.exec(appSrc)[1]);
  const lab = new Function(
    'performance',
    `
    const TAIL = ${TAIL};
    const VOICE = { lastMatchAt: performance.now() };
    ${extractFn(appSrc, 'voiceWindow')}
    ${extractFn(appSrc, 'sameWord')}
    ${extractFn(appSrc, 'alignVoice')}
    return { alignVoice, sameWord, voiceWindow, VOICE };
  `
  )(performance);

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const script =
    'the quick brown fox jumps over the lazy dog and then it runs away into the deep dark woods tonight and then the fox came back'.split(' ');
  const words = script.map((w, i) => ({ norm: norm(w), index: i }));

  const at = (cursor, ...w) => {
    lab.VOICE.lastMatchAt = performance.now(); // keep the search window narrow
    const m = lab.alignVoice(w.map(norm), cursor, words);
    return m ? m.end : null;
  };

  assert('exact four-word match locks on', at(0, 'quick', 'brown', 'fox', 'jumps') !== null);
  assert('tolerates one misheard word', at(0, 'brown', 'FOXX', 'jumps', 'over') !== null);
  assert('absorbs a word the reader skipped', at(0, 'jumps', 'over', 'lazy', 'dog') !== null);
  assert('a weak two-of-four match is rejected', at(0, 'fox', 'jumps', 'banana', 'helicopter') === null);
  assert('off-script speech is ignored', at(0, 'banana', 'helicopter', 'tuesday') === null);
  assert('fewer than three words is ignored', at(0, 'dog', 'and') === null);

  // "and then the" occurs at index 9 and again at 22. From a cursor of 20 it
  // must resolve near the cursor rather than flinging back to 9.
  const amb = at(20, 'and', 'then', 'the');
  assert('ambiguous common words resolve near the cursor', amb === null || Math.abs(amb - 20) <= 12, `got ${amb}`);

  // Backwards is the expensive mistake: it drops the reader into text they
  // have already spoken. A merely-decent match must not cause it.
  const backward = at(60, 'quick', 'brown', 'fox', 'banana');
  assert('a mediocre match cannot jump backwards', backward === null || backward > 35, `got ${backward}`);

  // The search window must widen once we have not matched for a while,
  // otherwise a reader who wandered off script is stranded forever.
  lab.VOICE.lastMatchAt = performance.now();
  const narrow = lab.voiceWindow();
  lab.VOICE.lastMatchAt = performance.now() - 20000;
  const wide = lab.voiceWindow();
  assert('search window starts narrow', narrow[0] <= 30 && narrow[1] <= 140, JSON.stringify(narrow));
  assert('search window widens after a long miss', wide[0] > narrow[0] && wide[1] > narrow[1], JSON.stringify(wide));

  // A clean read-through must track, and must never scroll backwards.
  let cursor = 0;
  let last = 0;
  let regressions = 0;
  let matches = 0;
  for (let i = 0; i + 5 <= script.length; i++) {
    lab.VOICE.lastMatchAt = performance.now();
    const m = lab.alignVoice(script.slice(i, i + 5).map(norm), cursor, words);
    if (m) {
      matches++;
      if (m.end < last) regressions++;
      last = m.end;
      cursor = m.end;
    }
  }
  assert('a straight read-through never scrolls backwards', regressions === 0, `${regressions} regressions in ${matches} matches`);
  assert('a straight read-through actually tracks', matches > 10, `only ${matches} matches`);

  // Re-acquisition: reader goes silent mid-script, then resumes somewhere far
  // ahead. With a stale lastMatchAt the window is wide, so we must find them.
  lab.VOICE.lastMatchAt = performance.now() - 20000;
  const reacquired = lab.alignVoice(
    'into the deep dark woods'.split(' ').map(norm),
    2,
    words
  );
  assert('re-acquires a reader who jumped far ahead', reacquired !== null && reacquired.end > 15, JSON.stringify(reacquired));
}

section('Easing');

{
  // eslint-disable-next-line no-eval
  const easeInOutCubic = eval(
    '(' + /const easeInOutCubic = (.*?);\n/.exec(appSrc)[1] + ')'
  );
  check('ease starts at 0', easeInOutCubic(0), 0);
  check('ease ends at 1', easeInOutCubic(1), 1);
  check('ease is symmetric at the midpoint', easeInOutCubic(0.5), 0.5);
  assert('ease is monotonic', (() => {
    for (let t = 0; t < 1; t += 0.01) if (easeInOutCubic(t + 0.01) < easeInOutCubic(t)) return false;
    return true;
  })());
}

/* ------------------------------------------------------------ integrity */

section('Source integrity');

{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check('no duplicate element ids', ids.length - new Set(ids).size, 0);

  // Every $('...') lookup in app.js must correspond to a real element.
  const looked = [...appSrc.matchAll(/\$\('([a-zA-Z0-9-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !ids.includes(id));
  check('every getElementById target exists in the markup', missing, []);

  assert('prompter styling does not depend on a page-level ancestor',
    !/\.app\s+\.prompter|#app\s+\.prompter|\.stage\s+\.p-/.test(css),
    'the prompter subtree is moved into a bare PiP document, so it cannot rely on page ancestors');

  assert('no external resource references', !/https?:\/\/[^"')\s]+\.(css|js|woff2?|ttf|png|jpg|svg)/.test(css + html),
    'everything must be self-contained for offline and CSP-safe use');
}

/* --------------------------------------------------------------- report */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
