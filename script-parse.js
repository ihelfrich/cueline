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
 *   ==stress==      -> a word to hit; rendered per the emphasis setting
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

  /** Seconds a pause mark is worth: a breath, and a full stop. */
  const PAUSE_SECONDS = [0, 0.45, 1.0];

  function countWords(text) {
    const cleaned = text
      // Anything the prompter shows as unspoken must not be counted, or the
      // timing model charges you for words you will never say. A stage
      // direction and a pronunciation respelling are both silent.
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/(^|\s)\/{1,2}(?=\s|$)/g, ' ')
      .replace(/==/g, '')
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


  /**
   * Wrap every spoken word in the rendered HTML with <w data-w="N">.
   *
   * This is what gives the prompter word-level addressing: highlighting the
   * word being spoken, clicking a word to annotate it, and mapping a voice
   * match onto a screen position all need a per-word element.
   *
   * Tags are stepped over rather than parsed, so inline formatting survives
   * untouched. Crucially, the count this returns is what the caller uses as
   * the block's word count — the tokenizer that emits the spans is the same
   * one that counts them, so screen positions and the timing model cannot
   * drift apart on an awkward input like un**believable**.
   */

  /**
   * Break a paragraph into sense lines.
   *
   * Broadcast copy has been set this way for sixty years, and the reading
   * research agrees: the eye runs ahead of the voice to the end of the current
   * PHRASE and then waits (Levin & Turner 1968; Laubrock & Kliegl 2015), so
   * the unit the reader buffers is the phrase, not the word. Breaking at the
   * container edge puts breaks in arbitrary places and hands the speaker a
   * phrase boundary only as it arrives — too late to plan intonation or
   * breath, which are specified over the whole phrase.
   *
   * So the structure is made visible in the layout, statically, before the eye
   * gets there. The author can override with an explicit pause mark: "/" for a
   * breath and "//" for a full stop, which is the convention broadcast scripts
   * already use.
   */
  const CONJUNCTION =
    /^(and|but|or|nor|yet|so|because|although|though|while|whilst|when|if|since|unless|until|after|before|whereas|which|who|whom|whose|that)$/i;

  const HARD_CAP = 9; // words; beyond this a line is too long to take in at a glance
  const MIN_GROUP = 2;

  /** Words a line would rather not begin after — break before these instead. */
  const PREPOSITION =
    /^(for|of|in|to|with|on|at|from|by|into|onto|over|under|about|against|between|through|during|without|within|toward|towards|upon)$/i;

  function senseGroups(text) {
    // Keep a bracketed direction atomic: splitting inside it would strand the
    // opening bracket on one line and break its rendering entirely.
    const tokens = (text.match(/\[[^\]]*\]|\S+/g) || []).filter(Boolean);
    const groups = [];
    let cur = [];

    const push = (words, pause) => {
      if (words.length) groups.push({ text: words.join(' '), pause: pause || 0 });
    };
    const close = (pause) => {
      push(cur, pause);
      cur = [];
    };

    /**
     * The hard cap has been reached. Rather than cutting at an arbitrary word,
     * retreat to the last place a phrase would naturally start — before a
     * preposition or a conjunction — so the break still falls on a boundary.
     */
    const capSplit = () => {
      for (let k = cur.length - 1; k >= 3; k--) {
        const bare = cur[k].replace(/[^\p{L}]/gu, '');
        if (PREPOSITION.test(bare) || CONJUNCTION.test(bare)) {
          const head = cur.slice(0, k);
          const tail = cur.slice(k);
          push(head, 0);
          cur = tail;
          return;
        }
      }
      close(0);
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      // Explicit author marks win over everything.
      if (tok === '//' || tok === '/') {
        const pause = tok === '//' ? 2 : 1;
        if (cur.length) close(pause);
        else if (groups.length) {
          // The mark followed a boundary that had already closed a line, so it
          // belongs to that line rather than being dropped on the floor.
          const last = groups[groups.length - 1];
          last.pause = Math.max(last.pause, pause);
        }
        continue;
      }

      const next = tokens[i + 1];
      cur.push(tok);

      const endsSentence = /[.!?;:]["')\]]?$/.test(tok);
      const endsClause = /,["')\]]?$/.test(tok);
      const nextIsConjunction = next && CONJUNCTION.test(next.replace(/[^\p{L}]/gu, ''));

      if (endsSentence) close(0);
      else if (endsClause && (cur.length >= 3 || i === 0)) close(0);
      else if (nextIsConjunction && cur.length >= 4) close(0);
      else if (cur.length >= HARD_CAP) capSplit();
    }
    close(0);

    // A one-word line is a stutter in the layout; fold it back — unless it is
    // a vocative or a discourse marker ("Colleagues," / "However,"), which a
    // speaker genuinely does set off on its own.
    const merged = [];
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      const standsAlone = /,$/.test(g.text);
      if (prev && !prev.pause && !standsAlone && g.text.split(' ').length < MIN_GROUP) {
        prev.text += ' ' + g.text;
        prev.pause = g.pause;
      } else {
        merged.push(g);
      }
    }
    return merged.length ? merged : [{ text, pause: 0 }];
  }

  function wrapWords(html, startIndex) {
    const isWord = (tok) => /[\p{L}\p{N}]/u.test(tok.replace(/&[a-z]+;|&#\d+;/gi, ''));
    let out = '';
    let i = 0;
    let n = 0;
    while (i < html.length) {
      if (html[i] === '<') {
        const close = html.indexOf('>', i);
        const end = close < 0 ? html.length : close + 1;
        const tag = html.slice(i, end);
        // Silent regions are copied through whole: their text is displayed but
        // never spoken, so it must not consume a word index or the screen
        // position and the timing model would drift apart.
        const silent = /^<rt\b/.test(tag)
          ? '</rt>'
          : /^<span class="aside"/.test(tag)
            ? '</span>'
            : null;
        if (silent) {
          const shut = html.indexOf(silent, end);
          const to = shut < 0 ? html.length : shut + silent.length;
          out += html.slice(i, to);
          i = to;
          continue;
        }
        out += tag;
        i = end;
        continue;
      }
      const next = html.indexOf('<', i);
      const stop = next < 0 ? html.length : next;
      out += html.slice(i, stop).replace(/\S+/g, (tok) => {
        if (!isWord(tok)) return tok;
        return '<w data-w="' + (startIndex + n++) + '">' + tok + '</w>';
      });
      i = stop;
    }
    return { html: out, count: n };
  }

  function inline(text) {
    return escapeHtml(text)
      // Word{RESPELLING} — the one live failure rehearsal cannot fix, because
      // the speaker rehearses their own mistake. Ruby is the element that
      // exists for exactly this, and it sets the guide above the word.
      .replace(/(\S+?)\{([^}\n]+)\}/g, '<ruby>$1<rt>$2</rt></ruby>')
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]\n]+)\]/g, '<span class="aside">[$1]</span>');
  }

  /**
   * @returns {{blocks: Array, totalWords: number, sections: Array}}
   */
  function parse(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');

    const blocks = [];
    let buffer = [];
    /** Source ranges of the lines feeding the paragraph being accumulated. */
    let bufferRanges = [];
    let lineStart = 0;

    const flush = () => {
      if (!buffer.length) return;
      const raw = buffer.join(' ');
      blocks.push({
        type: 'p',
        text: raw,
        html: inline(raw),
        words: countWords(raw),
        ranges: bufferRanges,
      });
      buffer = [];
      bufferRanges = [];
    };

    for (const line of lines) {
      const t = line.trim();
      // Where this line's trimmed content begins and ends in the source. Every
      // block keeps these so a rendered word can be traced back to the exact
      // characters that produced it — which is what lets the prompter annotate
      // a word in place without rewriting the script.
      const lead = line.length - line.trimStart().length;
      const contentStart = lineStart + lead;
      const contentEnd = contentStart + t.length;
      const advance = () => {
        lineStart += line.length + 1;
      };

      if (!t) {
        flush();
        advance();
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
        advance();
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
        advance();
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        flush();
        blocks.push({ type: 'rule', text: '', html: '', words: 0 });
        advance();
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
          ranges: [{ start: contentEnd - bullet[1].length, end: contentEnd }],
        });
        advance();
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
          ranges: [{ start: contentEnd - numbered[2].length, end: contentEnd }],
        });
        advance();
        continue;
      }

      buffer.push(t);
      bufferRanges.push({ start: contentStart, end: contentEnd });
      advance();
    }
    flush();

    let running = 0;
    const sections = [];
    blocks.forEach((b, i) => {
      b.index = i;
      b.wordsBefore = running;
      if (b.words > 0) {
        b.senses = senseGroups(b.text);
        b.html = b.senses
          .map((g) => '<span class="sense" data-pause="' + g.pause + '">' + inline(g.text) + '</span>')
          .join(' ');
        const wrapped = wrapWords(b.html, running);
        b.html = wrapped.html;
        // The emitter is the counter: they cannot disagree.
        b.words = wrapped.count;
      }
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

    // Marked pauses are silence the speaker will actually take, so they are
    // charged to the running time. Expressed in words at the current rate they
    // stay inside the one timing identity the product rests on.
    const pauseSeconds = blocks.reduce(
      (sum, b) => sum + (b.senses || []).reduce((n, g) => n + PAUSE_SECONDS[g.pause], 0),
      0
    );

    return { blocks, totalWords: running, sections, pauseSeconds };
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
