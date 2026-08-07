# Cueline

A teleprompter that floats above Zoom.

**→ [Open Cueline](https://ihelfrich.github.io/cueline/)** — no install, no account, no upload.

Paste a script, press **Float over Zoom**, and the prompter moves into a small
always-on-top window you can park directly under your webcam. It stays in front
of Zoom even in full screen, so you read your script while looking at the lens
instead of at the bottom of your screen.

---

## Why this one

Most browser teleprompters are a big scrolling `<div>` you have to keep in front
of you by hand, with a speed slider whose units mean nothing. Cueline is built
around the three things that actually go wrong when you present:

**You lose your place.** The reading line is fixed and marked, text fades away
from it, and lines you have already said are dimmed. Sections are jumpable with
one key.

**You run over time.** Speed is in **words per minute**, so the number means
something real — 700 words at 140 wpm takes five minutes, whatever the font size
or window width. Set a target length and Cueline tells you the wpm that lands it,
then shows live whether you are running ahead or behind.

**You can't reach the controls.** Zoom has focus, so nothing you press reaches
the browser. Cueline answers this two ways: the floating window carries its own
controls, and **voice follow** listens to you and keeps the line you are actually
saying on the reading line — so you can ad-lib, pause, take a question, and it
picks you back up when you return to the script.

## The screen-share question, answered honestly

**A web page cannot hide itself from screen capture.** Only a native app can do
that. So the rule is simple, and Cueline keeps it on screen at all times:

> **In Zoom, share a _window_ or a _Chrome tab_ — not "Entire Screen".**

A window share only ever contains the app you picked, so the floating prompter is
never in it. That is also the sharper-looking choice for your audience. If you
share the entire screen, everything on that screen goes out, prompter included.

If you need a prompter that is invisible even during a full-screen share, that
requires a native macOS app using `NSWindowSharingNone`, which is a different
project.

## Using it

1. **Write or paste your script.** Drag a `.txt` or `.md` file onto the page and
   it loads. Everything is saved in your browser as you type.
2. **Set a target length** if you have one. The editor shows the words-per-minute
   you need to hit it.
3. **Press "Float over Zoom"** and drag the window under your webcam. Keep it
   narrow — the less your eyes travel, the more you look like you are just
   talking.
4. **Share a window or a tab in Zoom**, then start it rolling.

### Script formatting

Plain text, close enough to Markdown that your script stays readable anywhere.

| You write | You get |
| --- | --- |
| `# Heading` | a section you can jump between |
| `> Cue` | a note to yourself — dimmed, never counted in the timing |
| `---` | a divider, e.g. "advance the slide" |
| `**bold**` `*italic*` | emphasis |
| `- item` | a bullet |

Cues and headings are deliberately excluded from the word count, so your timing
reflects what you will actually say out loud.

### Keyboard

| Key | Does |
| --- | --- |
| `Space` | start / stop |
| `↑` `↓` | faster / slower |
| `←` `→` | previous / next section |
| `J` `K` | nudge back / forward one line |
| `R` | back to the top |
| `M` | mirror (for teleprompter glass) |
| `F` | full screen |
| `+` `−` | text size |

Keys work when the prompter window or the main page has focus. While Zoom has
focus, use the buttons on the floating window, or let voice follow drive it.

## Voice follow

Turn it on in Settings. Cueline aligns the tail of what it hears against the next
stretch of script and eases the scroll to match, so it tracks you rather than
jumping. Going off script does nothing until you come back to it.

- Chromium browsers only (Chrome, Edge, Arc, Brave).
- Speech goes to your browser's recognition service, so **leave it off for
  confidential material.** Everything else in Cueline is local.

## Browser support

| | Floating always-on-top window | Voice follow |
| --- | --- | --- |
| Chrome, Edge, Arc, Brave | yes | yes |
| Safari | no — opens a normal window | no |
| Firefox | no — opens a normal window | no |

The always-on-top window uses the [Document Picture-in-Picture API][dpip]. Where
it is unavailable Cueline falls back to an ordinary pop-up window and tells you
it will not stay on top by itself.

[dpip]: https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API

## Running it yourself

It is three static files with no build step and no dependencies.

```bash
git clone https://github.com/ihelfrich/cueline.git && cd cueline && python3 -m http.server 8777
```

Then open `http://localhost:8777`. Deploying it anywhere means copying the files
onto any static host.

## Privacy

Your scripts and settings live in `localStorage` in your own browser. There is no
server, no analytics, and no network request of any kind — except the speech
recognition service if you switch voice follow on.

## Licence

MIT — see [LICENSE](LICENSE).
