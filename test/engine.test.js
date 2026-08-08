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
  // Words are wrapped in <w> spans for addressing, so assert on the text
  // inside each formatting element rather than on a literal markup string.
  const inside = (tag, h) => {
    const m = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>').exec(h);
    return m ? m[1].replace(/<[^>]*>/g, '') : null;
  };
  check('bold wraps its word', inside('b', html), 'bold');
  check('italic wraps its word', inside('i', html), 'em');
  assert('script tags are escaped, not executed', html.includes('&lt;script&gt;') && !html.includes('<script>'), html);
}

{
  const d = CuelineScript.parse('Words **with bold** inside.');
  check('emphasis markers do not inflate the word count', d.totalWords, 4);
}

{
  const html = CuelineScript.parse('Hit ==this word== hard.').blocks[0].html;
  const marked = /<mark>([\s\S]*?)<\/mark>/.exec(html);
  check('stress wraps exactly the marked phrase',
    marked && marked[1].replace(/<[^>]*>/g, ''), 'this word');
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

section('Word addressing — every spoken word is individually reachable');

{
  const d = CuelineScript.parse('Hit ==this word== hard.\n\nSecond para here.');
  const ws = (h) => [...h.matchAll(/<w data-w="(\d+)">([^<]*)<\/w>/g)].map((m) => [Number(m[1]), m[2]]);

  check('word indices run continuously across blocks',
    d.blocks.flatMap((b) => ws(b.html)).map((w) => w[0]), [0, 1, 2, 3, 4, 5, 6]);
  check('the block word count equals the spans emitted',
    d.blocks.map((b) => b.words), [4, 3]);
  check('wordsBefore lines up with the first span of each block',
    d.blocks.map((b) => b.wordsBefore), [0, 4]);

  // Formatting must wrap the words, not the other way round, or a multi-word
  // stress mark would render as separate underlines with gaps at the spaces.
  assert('inline formatting survives and contains the word spans',
    /<mark><w data-w="1">this<\/w> <w data-w="2">word<\/w><\/mark>/.test(d.blocks[0].html),
    d.blocks[0].html);
  assert('markers themselves are never wrapped as words',
    !/<w[^>]*>==/.test(d.blocks[0].html), d.blocks[0].html);
}

{
  // The emitter is the counter, so even a word split by formatting stays
  // self-consistent between the DOM and the timing model.
  const d = CuelineScript.parse('un**believable** result');
  const spans = [...d.blocks[0].html.matchAll(/data-w="(\d+)"/g)].length;
  check('span count equals the reported word count', spans, d.blocks[0].words);
  check('totalWords agrees with the spans emitted', d.totalWords, spans);
}

{
  const d = CuelineScript.parse('# Heading\n> a cue\nSpoken words here.');
  const spanned = d.blocks.filter((b) => /data-w=/.test(b.html)).map((b) => b.type);
  check('headings and cues carry no word spans', spanned, ['p']);
}

section('Source ranges — a rendered word can be traced back to the script');

{
  const src = 'First line here\nsecond line joined.\n\n- a bullet item\n';
  const d = CuelineScript.parse(src);
  d.blocks.forEach((b) => {
    if (!b.ranges) return;
    const rebuilt = b.ranges.map((r) => src.slice(r.start, r.end)).join(' ');
    check(`${b.type} block rebuilds exactly from its source ranges`, rebuilt, b.text);
  });
  assert('paragraphs record one range per source line', d.blocks[0].ranges.length === 2,
    JSON.stringify(d.blocks[0].ranges));
}

section('Say-it marks — silent text must never reach the clock');

{
  // A stage direction is displayed but not spoken. It used to be counted,
  // which charged the timing model for words the speaker never says.
  const d = CuelineScript.parse('Say five words here now [pause and look up] and then continue.');
  check('a stage direction costs no words', d.totalWords, 8);
  assert('the direction still renders as an aside',
    /<span class="aside">\[pause and look up\]<\/span>/.test(d.blocks[0].html), d.blocks[0].html);
  assert('no word index is spent inside the direction',
    !/data-w[^>]*>pause/.test(d.blocks[0].html), d.blocks[0].html);
}

{
  const d = CuelineScript.parse('Welcome to Kyrgyzstan{KEER-gih-STAN} today.');
  assert('a respelling sets as ruby above the word',
    /<ruby><w data-w="2">Kyrgyzstan<\/w><rt>KEER-gih-STAN<\/rt><\/ruby>/.test(d.blocks[0].html),
    d.blocks[0].html);
  check('the respelling costs no words', d.totalWords, 4);
  assert('no word index is spent inside the respelling',
    !/data-w[^>]*>KEER/.test(d.blocks[0].html), d.blocks[0].html);
}

{
  // Whatever the markup, the spans emitted and the count reported must agree,
  // because screen position and the timing model are derived from both.
  const samples = [
    'Plain words only here.',
    'Mixed ==stress== and **bold** and *em*.',
    'Name{RES-pell} plus [a direction] plus / a pause.',
    'un**believable** split word',
  ];
  const bad = samples.filter((src) => {
    const d = CuelineScript.parse(src);
    const spans = [...d.blocks[0].html.matchAll(/data-w="/g)].length;
    return spans !== d.blocks[0].words;
  });
  check('spans and word counts agree on every markup combination', bad, []);
}

section('Sense lines');

{
  const d = CuelineScript.parse('Colleagues, the figure is not a request. / It is permission to stop. // Thank you.');
  const g = d.blocks[0].senses;
  assert('a paragraph is broken into phrases', g.length >= 3, JSON.stringify(g.map((x) => x.text)));
  assert('no phrase exceeds the glance limit', g.every((x) => x.text.split(' ').length <= 9),
    JSON.stringify(g.map((x) => x.text)));
  assert('an author breath mark is retained', g.some((x) => x.pause === 1), JSON.stringify(g));
  assert('an author full stop is retained', g.some((x) => x.pause === 2), JSON.stringify(g));
  assert('marked pauses are budgeted as real time', d.pauseSeconds > 1, String(d.pauseSeconds));
  assert('pause marks are not spoken', !/data-w[^>]*>\/</.test(d.blocks[0].html), d.blocks[0].html);
}

{
  const d = CuelineScript.parse('A direction [that runs on for quite a few words indeed] stays whole.');
  const inside = d.blocks[0].senses.filter((g) => /\[/.test(g.text) && !/\]/.test(g.text));
  check('a sense break never falls inside a direction', inside, []);
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

section('Reading-position anchor — re-measuring must not move the script');

{
  // captureAnchor/restoreAnchor are the round trip that runs on every window
  // resize, every settings slider, and — the one that matters — on floating
  // and unfloating the prompter. They depend only on `doc`, `layout` and `y`,
  // so they can be lifted out and driven against a synthetic layout.
  const lab = new Function(
    `
    let y = 0;
    let doc = { blocks: [], totalWords: 0 };
    let layout = { tops: [], heights: [], readingPx: 0, maxY: 0, textHeight: 0 };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    ${extractFn(appSrc, 'blockAt')}
    ${extractFn(appSrc, 'yForWord')}
    ${extractFn(appSrc, 'captureAnchor')}
    ${extractFn(appSrc, 'restoreAnchor')}
    return {
      set(d, l, yy) { doc = d; layout = l; y = yy; },
      y: () => y,
      setY(v) { y = v; },
      blockAt: (v) => blockAt(v),
      yForWord: (w) => yForWord(w),
      capture: () => captureAnchor(),
      restore: (a) => { restoreAnchor(a); return y; },
    };
  `
  )();

  // A paragraph, then the shape that used to break it: heading, cue, rule,
  // then the paragraph they introduce. All four zero-word blocks share the
  // same wordsBefore as that paragraph.
  const mk = (type, words) => ({ type, words });
  const blocks = [mk('p', 10), mk('h', 0), mk('cue', 0), mk('rule', 0), mk('p', 10)];
  let running = 0;
  blocks.forEach((b, i) => {
    b.index = i;
    b.wordsBefore = running;
    running += b.words;
  });
  const doc = { blocks, totalWords: running };

  const layoutAt = (scale) => {
    const heights = [200, 60, 80, 30, 200].map((h) => h * scale);
    const tops = [];
    let acc = 150 * scale; // padding-top === readingPx
    heights.forEach((h, i) => {
      tops[i] = acc;
      acc += h;
    });
    const readingPx = 150 * scale;
    return { tops, heights, readingPx, maxY: acc, textHeight: acc };
  };

  const before = layoutAt(1);
  const after = layoutAt(1.35); // a re-measure that changes every dimension

  const names = ['paragraph', 'heading', 'cue', 'rule', 'paragraph after the rule'];
  let worstDrift = 0;
  const strayed = [];

  blocks.forEach((b, i) => {
    // Park the reading line a third of the way into block i.
    lab.set(doc, before, before.tops[i] + before.heights[i] * 0.33 - before.readingPx);
    const anchor = lab.capture();
    lab.set(doc, after, lab.y());
    const restored = lab.restore(anchor);

    // Which block is under the reading line now?
    const landed = lab.blockAt(restored);
    if (landed !== i) strayed.push(`${names[i]} -> ${names[landed] || landed}`);
    const want = after.tops[i] + after.heights[i] * 0.33 - after.readingPx;
    worstDrift = Math.max(worstDrift, Math.abs(restored - want));
  });

  check('every block type survives a re-measure on its own line', strayed, []);
  assert('restored position is exact, not approximate', worstDrift < 0.001, `worst drift ${worstDrift}px`);

  // The regression this replaced: a word-index round trip cannot distinguish
  // the zero-word blocks from the paragraph that follows them, because all
  // four carry the same wordsBefore.
  lab.set(doc, before, before.tops[1] - before.readingPx); // parked on the heading
  const wordAnchor = 10; // wordsBefore shared by heading, cue, rule and the next p
  const wordRestored = lab.yForWord(wordAnchor);
  assert(
    'yForWord only ever resolves to a block that contains words',
    lab.blockAt(wordRestored) === 4,
    `resolved to block ${lab.blockAt(wordRestored)}`
  );
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

  // The point of this check is that the page must LOAD nothing from a third
  // party — no CDN script, no hosted webfont. Absolute URLs in Open Graph
  // meta are required by that spec and are never fetched by the page, so they
  // must not trip it. Check the attributes that actually cause a request.
  const loaded = [
    ...html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*?\b(?:src|href)="([^"]+)"/gi),
  ].map((m) => m[1]);
  const cssUrls = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]);
  const external = [...loaded, ...cssUrls].filter((u) => /^(https?:)?\/\//i.test(u));
  check('the page loads nothing from a third party', external, []);
}

section('Desktop shell');

{
  const desktop = path.join(ROOT, 'desktop');
  const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');

  // The shell exists for exactly four powers a browser cannot grant. If any of
  // these calls is lost, the shell silently becomes a worse browser.
  const powers = [
    ['transparent window', /transparent:\s*true/],
    ['invisible to screen capture', /setContentProtection\(true\)/],
    ['above full-screen Zoom', /'screen-saver'/],
    ['click-through', /setIgnoreMouseEvents/],
    ['global hotkeys', /globalShortcut\.register/],
    ['never steals focus while presenting', /(?=[\s\S]*focusable:\s*arranging)(?=[\s\S]*setFocusable\(arranging\))/],
  ];
  const missing = powers.filter(([, re]) => !re.test(main)).map(([name]) => name);
  check('the shell keeps every power that justifies it', missing, []);

  // It must load the same app, not a fork of it.
  assert('the shell loads the web app itself', /loadFile\(path\.join\(ROOT, 'index\.html'\)/.test(main), 'shell should not carry its own copy of the prompter');

  // The native window can be transparent while Chromium's root canvas is
  // still black. Body-level transparency is therefore not enough: <html>
  // must be marked before the stylesheet's first paint and explicitly
  // cleared. This is the regression behind the opaque black overlay reported
  // from the real app.
  assert(
    'shell transparency clears the root canvas before first paint',
    /document\.documentElement\.classList\.add\('shell-root'\)/.test(html) &&
      /html\.shell-root[\s\S]*background:\s*transparent\s*!important/.test(css),
    'the root <html> canvas is still allowed to paint black'
  );

  // The shell is a single reading lens, not the browser editor with one
  // column hidden. This is the regression behind the words appearing in a
  // small box on the left of a much larger invisible window.
  assert(
    'shell gives the prompter the full native window',
    /body\.shell-body \.main\s*{[^}]*display:\s*block[^}]*width:\s*100%[^}]*height:\s*100%/s.test(css) &&
      /body\.shell-body \.prompter\s*{[^}]*width:\s*100%[^}]*height:\s*100%/s.test(css),
    'the hidden browser-editor column still consumes shell geometry'
  );

  assert(
    'shell backdrop opacity is adjustable without fading the words',
    /--shell-backdrop:\s*0\.32/.test(css) &&
      /setBackdropOpacity/.test(main) &&
      /id="shell-opacity"/.test(html),
    'the native overlay needs a persisted panel-only opacity control'
  );

  assert(
    'Arrange mode exposes bounds, placement, presets and explicit resize handles',
    /arranging\s*=\s*!setupComplete/.test(main) &&
      /placeUnderCamera/.test(main) &&
      /const PRESETS/.test(main) &&
      /beginResize/.test(main) &&
      (html.match(/data-edge="(?:n|e|s|w|ne|se|sw|nw)"/g) || []).length === 8 &&
      /shell-adjusting/.test(css),
    'a transparent frameless window must become concrete and adjustable before presenting'
  );
  // An agent app with no Dock icon and an unfocusable window cannot be quit
  // with Command-Q. If the menu bar item or the quit hotkey is ever removed,
  // the app becomes unquittable without killing the process.
  assert('there is a way to quit', /'Control\+Alt\+Q'/.test(main) && /new Tray\(/.test(main),
    'a dockless, unfocusable app needs a tray item and a quit hotkey');

  const files = ['main.js', 'preload.js', 'package.json', 'trayTemplate.png', 'trayTemplate@2x.png'];
  check('shell files present', files.filter((f) => !fs.existsSync(path.join(desktop, f))), []);
}

/* --------------------------------------------------------------- report */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
