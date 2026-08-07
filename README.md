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
that. So the rule is simple, and Cueline puts it in front of you once, at the
moment it matters — the first time you float the prompter:

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
| `==stress==` | a word to hit — underlined, blocked or amber, your choice |
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
| `Esc` | close a dialog, or the floating window |

Keys work when the prompter window or the main page has focus. While Zoom has
focus, use the buttons on the floating window, or let voice follow drive it.

## Voice follow

Two modes, because they make opposite trade-offs.

### Pace — the default

The script advances only while you are actually speaking, at the rate you set,
and holds the instant you stop. Pause, take a question, go off on a tangent —
it waits. It cannot know *which* word you are on, so it will not correct drift,
but it never guesses either.

It works by opening the microphone with `getUserMedia` and measuring input
level against an adaptive noise floor. Nothing is transcribed and nothing
leaves your machine. Crucially, `getUserMedia` is designed for concurrent use
and accepts a specific device, so **pace follow will not interrupt your call** —
and you can point it at a different microphone from the one carrying the call
if you want them fully isolated.

### Words — exact tracking, with a real cost

Word-level tracking keeps the line you are actually saying on the reading line.
Speak, and it follows; leave the script, and it stops and waits rather than
guessing; return, and it finds you again.

**It will take the microphone.** Browser speech recognition always opens the
default input, gives no way to choose a device or hand it an existing stream,
and starting it can pull the microphone away from whatever else is using it —
so switching it on mid-call can mute you in Zoom or Meet. Use it to rehearse,
or only when the call audio is on a different device. Speech is also
transcribed by your browser's recognition service, so it leaves your machine.
Cueline says all of this in the settings panel, next to the switch.

Under the noise, three things make word tracking feel calm rather than twitchy:

**Predict and correct.** Confirmations arrive in bursts a second or two apart.
Moving only on confirmation gives a stop-start crawl that is horrible to read
against, so between confirmations Cueline keeps gliding at the pace it measured
from your last few, and each new match is a small correction rather than a jump.

**Lock states and re-acquisition.** When it can no longer place what it hears it
says so, stops moving, and widens its search — first a few sentences, then a few
paragraphs, then the whole script. A tracker that only looks just ahead of
itself strands you the moment you ad-lib.

**Asymmetric trust.** Moving forward on a decent match is cheap to recover from.
Moving backward is not — a repeated phrase throwing you into text you already
read is what makes people abandon voice prompters. Backward jumps need a
near-perfect match.

Set your spoken language in Settings; accuracy falls off badly on the wrong one.
Word mode is Chromium-only (Chrome, Edge, Arc, Brave). Pace mode works anywhere
`getUserMedia` does, including Safari and Firefox.

## Tests

```bash
node test/engine.test.js
```

The app is three browser files with no build step, so the tests lift the real
function bodies out of `app.js` and exercise those rather than a re-implementation
— if a function is renamed the extraction fails, which is itself useful. They
cover the parser, the words-per-minute timing identity, and the voice tracker
(including re-acquisition and the backward-jump guard).

## Browser support

| | Floating always-on-top window | Pace follow | Word follow |
| --- | --- | --- | --- |
| Chrome, Edge, Arc, Brave | yes | yes | yes |
| Safari | no — opens a normal window | yes | no |
| Firefox | no — opens a normal window | yes | no |

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

Asset URLs carry a `?v=` query. **Bump it in `index.html` whenever you deploy a
change**, or returning visitors can end up running a cached `app.js` against
new markup — a state where the page loads without errors and silently does
nothing when clicked.

## Design

The reference is a broadcast prompter console rather than an application, and
two rules do most of the work.

**Saturation means live.** The interface is neutral monochrome. Amber appears
only when the prompter is armed or rolling — the play control, the reading
marks, the progress fill; red exists only as the voice tally lamp. Nothing that
is merely *available* is ever coloured. That is what leaves the reading line as
the most conspicuous thing on screen rather than one of a dozen competing
accents, and it is why the pace readout is an exposure meter — direction by
which side of centre, magnitude by length — instead of a green/amber/red pill.

**Structure is drawn with hairlines.** Square panels, 1px rules, a 4px rhythm,
tabular figures, and instrument labelling: a small tracked field name above a
large value. No card shadows, no gradients, no glass, no pills.

On the reading surface itself: the measure is capped at 17em so a line is five
or six words wide however large the window, because a long line forces the eye
to sweep back and re-find its place. Type auto-fits the window height, holding
roughly six visible lines from a 900px window down to 140px. Already-said text
is dimmed by a mask in viewport space, so the boundary falls exactly on the
reading line — to the pixel, mid-word — and costs nothing per frame. The
full-brightness band is a plateau more than two line-heights tall rather than a
peak at one gradient stop, so the line you are reading is never half-faded.

## Privacy

Your scripts and settings live in `localStorage` in your own browser. There is no
server, no analytics, and no network request of any kind — except the speech
recognition service if you switch voice follow on.

## Licence

MIT — see [LICENSE](LICENSE).
