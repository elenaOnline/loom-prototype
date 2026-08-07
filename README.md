# loom

An infinite-canvas research surface where **the trail draws itself**. Click a link inside a
card and the target blooms beside it, joined by a hairline edge — the board becomes a map of
where your attention has been. A prototype in the lineage of the late
[Wikiboard](https://web.archive.org/web/20260514205142/https://wikiboard.org/), Obsidian
Canvas, and Muse.

Built as a *feel-instrument*: an experiment in a handful of interaction ideas for a native
macOS canvas, prototyped on the web where iteration is cheap. Vanilla TypeScript, no
framework — the only runtime dependencies are `marked` and `dompurify`.

## Run

```
npm install
npm run dev        # http://localhost:5173
```

Wiki mode boots with a "Turing machine" card. Or switch to **folder** mode and open a local
directory of markdown — relative links spawn cards the same way.

## The ideas being tested

**Trail topology (keys `1/2/3`, live-switchable).** What should happen when you follow a
link to a card that's already on the board?
- `1 duplicate` — always spawn a fresh card (what Wikiboard shipped)
- `2 linkback` — draw a trail edge to the existing card (what Wikiboard tried and reverted:
  "boards became messy really quickly")
- `3 returnedge` — no new card; a visibly distinct loop in the accent color records
  *"I came back here"*. Revisits and branches as different kinds of stroke, not different
  topologies — the hypothesis is that Wikiboard's mess was a rendering failure, not a
  topology failure.

**Threads are real objects.** Click a trail edge and the whole run selects as one thing:
its cards invert, the rest of the board recedes. Name it (it persists), pull it taut
(`t` — reversible; non-thread cards never move), hand it off (`c` — the thread's name,
ordered refs, and marks are typed into a composer strip, exactly what a terminal-side agent
would receive as *"here is my line of thought"*).

**Semantic zoom as altitude, not shrinking.** Three tiers with hysteresis: **fiber**
(full article, selectable text), **thread** (title cards), **cloth** (glyphs — the weave
itself becomes the subject). The toolbar names your current altitude.

**Marks are data.** Select text for a pill: **highlight** (persists as an underline,
anchored by quote), **note** (a small tethered card you can type into immediately),
**→ composer** (send the quote onward). Marks ride along with thread handoffs.

**The board is a file.** Everything persists as
[JSON Canvas](https://jsoncanvas.org) (`save…` / `load…`, plus localStorage autosave) with
namespaced `x-powerset` extensions for edge kinds, threads, and marks. The file is
human-readable, git-diffable, opens in Obsidian, and is trivially readable *and writable* by
a coding agent — which is the point. See [examples/sample-board.canvas](examples/sample-board.canvas)
for a real session: a three-card wander, a return loop, a named thread, a highlight, and a
tethered note, all legible in ~90 lines of JSON.

## Keys

`1/2/3` topology mode · `f` zoom-to-fit · double-click paper fits · ctrl/⌘+wheel or pinch
zooms at cursor · wheel pans · drag paper pans · drag a card by its title bar · alt-drag
card→card draws a manual edge · click a trail edge to grab its thread · `t` pull taut /
relax · `n` name · `p` pin (freeze a named thread's membership) · `c` hand off · Esc
deselect · select text in a card for the mark pill.

## Design language

One flat sheet of paper. Five color roles (`paper · ink · sig · s2 · ghost`), 1px hairlines,
serif for prose, monospace for chrome, no shadows, no rounded corners, no gradients. State
is geometry: solid = walked, dashed = asserted, accent loop = returned, faint = held,
filled atom = pinned, dashed chip = a thread that outlived part of its line.

`ARCHITECTURE.md` is the internal build contract the code was written against, deviation
log included.

## Status

A prototype for feeling, not a product: single-page, no tests, no accessibility pass,
Wikipedia articles truncated to their first sections, error handling is best-effort. Built
in a day by a small fleet of Claude agents (five build/evaluate stages plus an adversarial
completeness pass), then walked by hand.

## License

MIT
