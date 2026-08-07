/**
 * Script parsing shared by the overlay and the console.
 *
 * The format is deliberately close to Markdown so a script is readable as a
 * plain text file and survives being pasted anywhere:
 *
 *   # Heading        -> a section (jumpable, not spoken, not counted)
 *   > Cue line       -> a direction to yourself (dimmed, not counted)
 *   ---              -> a divider, e.g. "advance the slide here"
 *   - item           -> a bullet
 *   **bold** *em*    -> emphasis
 *
 * Everything else is a spoken paragraph. Word counts drive both the scroll
 * speed and the timing readout, so anything not spoken must not be counted.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CuelineScript = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function countWords(text) {
    const cleaned = text
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .trim();
    if (!cleaned) return 0;
    return cleaned.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]\n]+)\]/g, '<span class="aside">[$1]</span>');
  }

  /**
   * @returns {{blocks: Array, totalWords: number, sections: Array}}
   */
  function parse(text) {
    const lines = String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .split('\n');

    const blocks = [];
    let buffer = [];

    const flush = () => {
      if (!buffer.length) return;
      const raw = buffer.join(' ');
      blocks.push({ type: 'p', text: raw, html: inline(raw), words: countWords(raw) });
      buffer = [];
    };

    for (const line of lines) {
      const t = line.trim();

      if (!t) {
        flush();
        continue;
      }

      const heading = /^(#{1,3})\s+(.*)$/.exec(t);
      if (heading) {
        flush();
        blocks.push({
          type: 'h',
          level: heading[1].length,
          text: heading[2],
          html: inline(heading[2]),
          words: 0,
        });
        continue;
      }

      if (/^>\s?/.test(t)) {
        const body = t.replace(/^>\s?/, '');
        const prev = blocks[blocks.length - 1];
        if (buffer.length === 0 && prev && prev.type === 'cue') {
          prev.text += ' ' + body;
          prev.html = inline(prev.text);
        } else {
          flush();
          blocks.push({ type: 'cue', text: body, html: inline(body), words: 0 });
        }
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        flush();
        blocks.push({ type: 'rule', text: '', html: '', words: 0 });
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(t);
      if (bullet) {
        flush();
        blocks.push({
          type: 'li',
          text: bullet[1],
          html: inline(bullet[1]),
          words: countWords(bullet[1]),
        });
        continue;
      }

      const numbered = /^(\d+)[.)]\s+(.*)$/.exec(t);
      if (numbered) {
        flush();
        blocks.push({
          type: 'li',
          marker: numbered[1] + '.',
          text: numbered[2],
          html: inline(numbered[2]),
          words: countWords(numbered[2]),
        });
        continue;
      }

      buffer.push(t);
    }
    flush();

    let running = 0;
    const sections = [];
    blocks.forEach((b, i) => {
      b.index = i;
      b.wordsBefore = running;
      running += b.words;
      if (b.type === 'h') sections.push({ index: i, text: b.text, level: b.level });
    });

    if (!blocks.length) {
      blocks.push({
        type: 'empty',
        text: '',
        html: '',
        words: 0,
        index: 0,
        wordsBefore: 0,
      });
    }

    return { blocks, totalWords: running, sections };
  }

  function formatClock(seconds) {
    if (!isFinite(seconds)) return '--:--';
    const neg = seconds < 0;
    const s = Math.round(Math.abs(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (neg ? '-' : '') + m + ':' + String(r).padStart(2, '0');
  }

  return { parse, countWords, formatClock, escapeHtml, inline };
});
