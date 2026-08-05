# loom-app — pinned architecture (read before writing any code)

Feel-instrument prototype for a native-app workspace canvas ("the loom"). The product
contract and design-ideation docs live outside this repo (private project notes); the README
summarizes the ideas under test. This file pins the technical shape so sequential build
sessions compose instead of churning. Deviate only with a dated note added at the bottom.

## Rendering: DOM scene graph (no <canvas> for content)

- `#viewport` (fills window, overflow hidden) → `#world` (transformed container).
  Camera applies `transform: translate(x,y) scale(z)` to `#world` alone, via RAF.
- Cards are absolutely-positioned `<div class="card">` inside `#cards`, at world
  coordinates. Real DOM text — text selection must work (fibers stage needs it).
- Edges live in one `<svg id="edges">` sized to the world content bounds, *under* cards,
  in the same transformed space. Redraw edges on graph change, not on camera change
  (camera moves the whole world; edges ride along free).
- Wiki/markdown HTML is sanitized with DOMPurify before insertion. Intercept ALL link
  clicks inside cards (capture-phase listener; `preventDefault` always — links spawn
  cards, never navigate).

## Modules & ownership (one stage = one owner; touch others only for wiring)

- `src/camera.ts` — `{x,y,z}` camera; screen↔world conversion; wheel pan; ctrl/cmd+wheel
  and pinch zoom **around the cursor**; zoom-to-fit(bounds); animated `flyTo`. Exposes
  `onChange(cb)` and current `z` for tiers. No DOM knowledge beyond applying transform.
- `src/model.ts` — types + board state + mutation API + change events. Single source of
  truth. `Node`, `Edge`, `Thread`, `Mark`, `BoardState`, `TopologyMode`.
- `src/codec.ts` — JSON Canvas load/save (see codec rules below). Save debounced on change.
- `src/host.ts` — the `Host` interface (readFile/writeFile/sendToComposer/pickFolder) with
  two impls: File System Access API; localStorage fallback (key `loom:board`). The
  composer strip `#composer` is a visible read-only log of exactly what would be typed
  into PowerSet's composer — appending there IS `sendToComposer`.
- `src/providers/wiki.ts` — Wikipedia REST (`https://en.wikipedia.org/api/rest_v1/page/html/{title}`
  + `.../page/summary/{title}` for spawn previews). Cache fetched HTML in-memory.
- `src/providers/folder.ts` — local folder via FS Access API; markdown via `marked`;
  resolve relative `.md` links within the folder.
- `src/trail.ts` — link-click → spawn logic; the **three-way topology toggle**
  (`duplicate | linkback | returnedge`); placement of spawned cards near source.
- `src/threads.ts` — first-class threads: build from trail selection, name, highlight as
  unit, pull-taut layout gesture, handoff → `host.sendToComposer(...)`.
- `src/tiers.ts` — semantic zoom: swap card body by z band. Bands (tune by feel):
  z ≥ 0.55 full · 0.18 ≤ z < 0.55 title-card (serif title + mono path/status) ·
  z < 0.18 glyph (hairline square + pixel-scale label). CSS class swap on `.card`,
  content lazy-rendered once per tier.
- `src/fibers.ts` — text-selection pill (Highlight · Note · Send to composer); marks
  persist in model; notes are small text cards tethered to their source.
- `src/ui.ts` — toolbar: content mode (wiki/folder), topology toggle, zoom-to-fit,
  save/load, board reset. Keep it one hairline strip.
- `src/main.ts` — bootstrap/wiring only.

## Data model & JSON Canvas codec

File: `board.canvas` (JSON Canvas 1.0 — jsoncanvas.org). Be liberal on read.
- Wiki card → `{id,type:"link",url,x,y,width,height}` + `"x-powerset":{kind:"wiki",title}`
- Folder card → `{type:"file",file:"<relpath>"}` + `"x-powerset":{kind:"doc"}`
- Note → `{type:"text",text}` + `"x-powerset":{kind:"note"}`; the tether to its
  source is a real EDGE, not a node field (stage-5 deviation, logged below)
- Edge → standard fields + `"x-powerset":{kind:"trail"|"manual"|"return"|"tether"}`
- Top level extra: `"x-powerset":{topologyMode,contentMode,threads:[{id,name,nodeIds:[...]}],
  marks:[{id,nodeId,quote,kind:"highlight"|"note",noteNodeId?}]}`
Marks anchor by quoted text (first occurrence), not offsets — survives re-render, fine for
a prototype.

## Interaction conventions

- Left-drag on paper = pan (and marquee later — alt-drag reserved for marquee).
  Left-drag on card = move card. Wheel = pan; ctrl/cmd+wheel & pinch = zoom-at-cursor.
  Double-click paper = zoom-to-fit. `1`..`3` set topology mode; `f` zoom-to-fit.
- Spawn placement: new card at source's right edge + 60px, vertically staggered to avoid
  overlap with siblings; **spawn = bloom near source**, no drag-to-place ceremony (brief Q3
  gets answered by feel-testing this default).
- Edge geometry is state (lace): trail = solid 1px hairline; manual = dashed; return =
  1.5px in the accent role, routed as a visible loop (curve out and back). No arrowheads on
  trails; arrowheads allowed on manual edges.

## Style (lace-adjacent, not certification-grade)

Five CSS custom props only — already defined in `styles.css`: `--paper` (ground), `--ink`
(text/hairlines), `--sig` (accent — return edges, selection), `--s2` (muted ink), `--ghost`
(faint hairline/grid). Use these; never hardcode hex in modules. **No box-shadow, no border-radius, no gradients,
no blur, no tint washes.** Hairlines are `1px solid`. Type: serif for titles/prose
(Iowan Old Style/Palatino stack), monospace for paths/status (SF Mono/Menlo stack).
Selected card: invert title bar (ink bg, paper text), never a glow.

## Verification (every stage, before handing off)

```
cd ~/Intelligence/02-General/08-04-2026_loom_prototype/loom-app
npm run build        # tsc --noEmit && vite build — must pass clean
npx vite --port 5199 # then exercise the running app in a browser
```

## Deviation log

**2026-08-04 — stage 1 (camera).**

- **Dot grid moved out of `#world`.** Pinned shape said "CSS background on `#world` in world
  units". `#world` is a zero-size transform container, so a background on it paints nowhere;
  giving it a huge box would move the world origin. Also, the usual dot-grid trick is a
  `radial-gradient`, and gradients are banned by the style rules. Implemented instead as a
  viewport-sized `<svg id="grid">` inserted *before* `#world` inside `#viewport`, containing
  one `<pattern>` of one `<circle fill: var(--ghost)>`; the camera's `onChange` re-parameterises
  the pattern (tile size = `step * z`, offset = `camera.{x,y} mod tile`) so the dots read as
  world-fixed and scale with zoom, at bounded cost. The step halves/doubles by zoom decade to
  hold on-screen spacing in ~[40, 80]px — a fixed world step collapses into a grey wash at
  z=0.05.
- **New module `src/grid.ts`** (not in the module list). ~70 lines, owns only the above.
  `main.ts` wires it.
- **Camera publishes `--z`** on `#world` alongside the transform. World-space rules divide by
  it (`border-width: calc(1px / var(--z, 1))`) so hairlines stay 1px *on screen* instead of
  thickening to 3px at z=3 and vanishing at z=0.1. Without this, cards were invisible at fit
  zoom. Tiers (stage 4) can rely on `--z` being present.
- **Camera owns the `f` key and double-click-fit**, not `ui.ts` — it needs viewport geometry
  anyway. It stays content-agnostic via an injected `getContentBounds()`; `ui.ts` can later
  add a toolbar button that calls `camera.zoomToFit()`.
- **Fit never zooms in past z=1** (`MAX_FIT_Z`), so framing two small cards doesn't magnify
  them. Fit also respects injected `getInsets()` so the toolbar/composer strips don't cover
  the framed content.
- **Not done, deliberately:** Safari `gesturestart/gesturechange` pinch (Chrome's ctrl+wheel
  path covers the target browser); momentum/inertia on drag-release (the brief's feel bar says
  no rubber-banding, and trackpad wheel streams already carry OS momentum); marquee on
  alt-drag (reserved, stage 2+).

**2026-08-04 — stage 2 (cards, spawning, topology toggle).**

- **Three new modules.** The pinned list assigned card rendering to no one and gave `trail.ts`
  both spawning and drawing. Split instead: `src/cards.ts` (model → card DOM; title-bar drag,
  unpin, selection, alt-drag manual edges), `src/edges.ts` (the SVG layer and all edge
  geometry), and `src/providers/source.ts` (the `ContentSource` seam both providers implement,
  plus the shared DOMPurify pass). `trail.ts` keeps only link interception, the topology
  toggle, placement, and hydration — which is what makes it readable as the experiment.
- **`#edges` is sized to content bounds + 520px of pad, with a matching `viewBox`.** The pinned
  shape said "sized to the world content bounds"; the tempting shortcut (zero-size root `<svg>`
  with `overflow: visible`) is fragile across engines. Return loops rise well above their
  cards, hence the large pad.
- **Edges bow sideways by 18 world px, signed by node-id order.** Found by feel-testing: a
  linkback edge B→A drew exactly under the outbound trail A→B and read as one line, which would
  have silently sabotaged the §7.1 comparison. Now a there-and-back pair reads as two.
- **Return edges also drop a filled `--sig` atom on the card they land on** — the loop alone
  doesn't say which end is the "came back to".
- **`camera.ts` gained one option, `shouldIgnoreWheel`.** Reading a long article means
  scrolling a card, not panning the cloth. The camera hands the wheel to a `.card-body` that
  can still scroll in that direction and takes it back at the ends. Zoom (ctrl/cmd) always wins.
- **Wiki bodies are truncated to the first 8 Parsoid sections** and stripped of infoboxes,
  images/figures, reference apparatus and navboxes. Full articles are DOM-heavy and the stripped
  furniture is noise once an article is a card; ~77 live links survive on a typical article,
  which is more than enough to tangle a board.
- **Wiki node identity is the article title parsed from the href, never the link text.** Two
  links reading "universal machine" and "Turing machine" must be one identity or `linkback` /
  `returnedge` would never recognise a revisit. Redirects are *not* resolved (that would make
  the toggle wait on a network round trip before it could decide) — a redirect title therefore
  reads as a distinct card. Note it if it shows up in a session.
- **`LoomNode.html` is transient and never serialized**; boards re-hydrate from the provider on
  load, with in-memory caches per session. `board.canvas` stays readable, which was the point.
- **Default topology mode is `returnedge`** (the owner's sketch) — the toggle starts on the
  hypothesis under test, not on the control.
- **`c` sends the selected card to the composer strip.** A stage-3 primitive landed early so
  `host.sendToComposer` is exercised rather than merely implemented.
- **Folder mode cannot survive a reload**: FS Access handles aren't persisted (no IndexedDB in
  this prototype), so a reloaded folder board shows its cards with a "re-open the folder"
  status rather than pretending. Honest about the platform; revisit only if it bites.
- **Not done, deliberately:** threads/tiers/fibers (stages 3–5); the `note` node kind exists in
  the model and codec but nothing creates one yet; edge hit-testing and selection (stage 3
  wants to click an edge to grab a thread — paths carry `data-edge-id` already); marquee on
  alt-drag over paper; drag-to-place on spawn (brief Q3 — the bloom default is deliberately the
  only behavior on offer, so the session can react to it).

**2026-08-04 — stage 3 (threads as real objects).**

- **`src/threads.ts` owns all four verbs** (grab / name / pull / hand off) as the pinned shape
  said. Everything else was wiring: `model.ts` gained the thread mutation API and `marksOf()`;
  `edges.ts` gained hit targets and an emphasis classifier; `ui.ts` gained the thread group;
  `main.ts` wires and routes handoff. No new module beyond `threads.ts`.
- **A new `ChangeKind`, `"threads"`.** Naming a thread must not be laundered through `meta`, or
  the edge layer and the card layer cannot tell "the topology toggle moved" from "a name was
  kept". `edges.ts` ignores it (nothing geometric changed); `cards.ts` already no-ops on kinds
  it does not recognise; autosave picks it up like any other change, so names persist for free.
- **Edges got an invisible 12px-on-screen `.edge-hit` twin.** A 1px hairline is not a click
  target, and grabbing a thread by its edge is *the* stage-3 primitive. `#edges` keeps
  `pointer-events: none`; only the hit strokes re-enable it (`pointer-events: stroke`).
  `main.ts` now passes `isPaper` to the camera so an edge grab or a nameplate click does not
  also drag the cloth.
- **Emphasis is a classifier, not a mutation.** `edges.setClassifier(fn)` is installed once by
  `threads.ts` and read at draw time, so the edge layer never learns what a thread is and a
  selection change costs one redraw rather than a DOM walk.
- **The primary chain is creation order.** `board.edges()` is insertion-ordered, so "the first
  child a card ever spawned continues its line, later ones are branches" needs no extra state.
  Clicking a branch edge starts the downstream walk *at that edge's target*, which is what makes
  a branch click give the branch's line instead of every descendant.
- **The nameplate rides in SCREEN space, not world space** (`#viewport`, repositioned on
  `camera.onChange`). A name is chrome *about* a thread; in world space it would be unreadable
  at fit zoom and enormous at z=3.
- **The nameplate does NOT autofocus on selection.** Autofocus would swallow `t` and `c` — the
  two gestures the stage exists to test. It shows the kept name (or invites one), click or `n`
  to type, Enter commits, Escape reverts. Clearing the name and pressing Enter *un-names* the
  thread: it drops out of the model and the toolbar list and goes back to being a run.
- **Pull taut preserves the thread's own heading.** The arc is centred on the thread's current
  centroid and aimed root→tip, bowed by `min(200, length × 0.1)` — so it reads as *tidying what
  is there* rather than teleporting it. Even spacing is `max(mean card width + 56, current
  span / (n-1))`, so pulling never crushes a long thread into an overlap.
- **A pulled thread will cross the cards it did not move** — that is the spec ("WITHOUT moving
  non-thread cards") working as written, and it is a finding for the session, not a bug. To keep
  the thread reading as one object while it crosses, `threads.ts` borrows each selected card's
  `z-index` (100000 + trail index) and hands the old value straight back on deselect.
- **Pull memory is in-memory only.** Pulled positions are real `moveNode`s and therefore persist
  to `board.canvas`; the stash that makes the pull reversible does not survive a reload. A reload
  mid-pull silently strands the layout. Persisting it would mean writing a "lens" concept into
  the file format before the design session has decided a pull is worth keeping — deliberately
  not done, but note it if a session reloads mid-experiment.
- **Handoff asks the model for marks per node** (`board.marksOf(nodeId)`), indenting each under
  its card, so stage 5 (fibers) needs to change nothing here. Verified end-to-end by seeding a
  mark into the persisted board and re-reading it through the codec.
- **`c` widens its grasp**: a selected thread hands off whole (name + ordered refs + marks);
  otherwise it falls back to the stage-2 single-card behavior.
- **Toolbar buttons got `white-space: nowrap` and `#toolbar` got `overflow: hidden`.** With the
  thread group added the strip was wrapping its own button labels at narrow widths; the strip is
  supposed to be one hairline line, so it clips instead.
- **Not done, deliberately:** editing a thread's membership by hand (add/remove a card from a
  kept thread — the model API is there, no gesture is); merging and splitting threads (ideation
  §7.4 lists them as open, and inventing gestures for them before the session would be baking in
  UX); multi-thread selection; a card belonging visibly to two threads (the last selection wins
  the paint); tiers/fibers (stages 4–5).
- **Observed, not fixed (stage-2 territory):** a protocol-relative Wikipedia media link
  (`//upload.wikimedia.org/.../En-us-algorithm.ogg.mp3`) is classified `internal` by
  `providers/wiki.ts` and spawns a card that 404s. Worth a line in `wiki.ts`'s `tagAnchor`.

**2026-08-04 — stage 4 (semantic zoom tiers).**

- **Bands as shipped: `full` z ≥ 0.55 · `title` 0.18 ≤ z < 0.55 · `glyph` z < 0.18** — the
  brief's starting points survived feel-testing unchanged. Hysteresis is ±5% on each edge
  (10% dead zone): leaving a band costs `T × 1.05`, re-entering `T × 0.95`, so a card parked
  on a boundary cannot strobe between two drawings. The whole rule is one pure function,
  `tierFor(z, current)`, exported for reading and testing.
- **`tiers.ts` re-dresses cards, it never rebuilds them.** Swap of one class on `.card`
  (`tier-full` / `tier-title` / `tier-glyph`), plus `card-culled`; the model, the geometry and
  the card bodies are untouched. That is what keeps text selection alive in the full band
  (verified in-browser: triple-click still yields a Range) — fibers, stage 5, needs it.
- **"Lazy" is display-culling, not deferred `innerHTML`.** The stage brief prescribed
  `display:none` on bodies outside the viewport in the full band, so that is what shipped:
  card bodies whose node rect misses the viewport (padded by half a screen each way) get
  `.card-culled`. Verified at z≈3 on a 6-card board: 4 of 6 bodies dropped. Deferring the
  provider HTML itself would have to live in `cards.ts` and is a bigger change than the
  measured problem. **Known cost:** un-culling resets a card body's scroll position.
- **`edges.ts` gained `setPointAnchors(on)` — the one cross-module change.** At glyph range a
  card is drawn as a 22px-on-screen square in the *middle* of its footprint, so border
  anchoring would leave every edge stopping ~25 screen px short, in mid-air, at exactly the
  altitude where the brief says the edges are the subject. With point anchors on, node rects
  collapse to their centres and the weave converges on the squares. `tiers.ts` toggles it on
  the glyph transition — one redraw per band crossing, not per frame.
- **The glyph IS the card head.** No new DOM: at glyph tier the `.card` box goes transparent
  and `pointer-events: none`, and `.card-head` is absolutely centred as the hairline square
  with `pointer-events: auto`. Consequences, all wanted: the square is still the drag handle,
  selection/ping/thread-in still invert it into a filled ink atom (re-stated at glyph
  specificity, since the tier rules would otherwise win the background), and — the reason for
  `pointer-events: none` — the empty paper *between* glyphs drags the cloth again instead of
  being swallowed by 380×460 invisible footprints.
- **Type counter-scales by `--z`.** Title-card type is `min(80px, 17px/z)` serif + `min(46px,
  10px/z)` mono, so a title stays ~17px on screen through the band and only stops growing when
  it would outgrow its own card at the bottom of it. Glyph labels are a flat `8.5px/z` in a
  `84px/z` box (first pass was 120px wide and 9px: on a dense board the captions collided into
  each other, so they were narrowed and now ellipsize instead). Glyph labels are
  `pointer-events: none` — a caption must not eat a drag on paper it overhangs.
- **`tiers.ts` must be constructed after `cards.ts` and after `ui.ts`.** Board listeners fire in
  subscription order, so the card layer has already built the DOM for a spawn by the time the
  tier layer paints it; and the first `onTier` callback fires synchronously at construction,
  which would hit `ui`'s TDZ if it were built earlier. Noted in `main.ts`.
- **The zoom readout names the altitude** (`44% · thread`): fiber / thread / cloth, from the
  ideation §6.4 vocabulary. Question 4 of the brief is "does semantic zoom carry meaning or
  read as mere shrinking?" — naming the band in the chrome is how a session can answer that
  out loud instead of gesturing at it.
- **Mark counts are already wired.** The title card writes `n marks` in the signal role when
  `board.marksOf()` has any; nothing creates marks until stage 5, but a `board.canvas` with
  marks in it renders them today.
- **Fix, same day (title-band legibility).** The first cut capped title type at a flat `80px`
  and counter-scaled the head padding (`10px/z 12px/z`). Both are wrong at the bottom of the
  band: at z=0.19 a 380px card is ~72px wide *on screen* and ~24 of those were padding, so
  16 of 18 wiki titles were clipped mid-word by `.card { overflow: hidden }` with no ellipsis
  ("Thermod", "Statistica mechani"). Three changes, CSS only: head padding is now flat WORLD
  units (`12px 14px`) — a margin should shrink with its sheet; `.card` became a size container
  (`container-type: inline-size`, which is `contain: layout inline-size style` — **not** paint,
  so the glyph tier's overhanging label still draws outside the card); and the title cap is now
  `min(17px/z, 11.5cqw)`, i.e. bounded by *this card's own width* instead of a number that knows
  nothing about the measure it must fit. `overflow-wrap: break-word` + `hyphens: auto` are the
  last resort for a word longer than the card. Consequence, accepted: below z≈0.37 the title
  stops being screen-constant and shrinks with the sheet (17px → ~8px on screen at z=0.18).
  The whole name stays written; it just gets further away. Verified with the evaluator's own
  predicate — zero of 18 titles overflow at z = 0.55/0.45/0.39/0.30/0.27/0.22/0.19/0.18, and
  11.5cqw is the largest cap tested at which no title in the repro set needs a mid-word break
  ("Gödel's incompleteness theorems" takes an honest hyphen; at 12cqw "Thermodynamics" starts
  breaking).
- **Not done, deliberately:** collision/priority rules for glyph labels (hide-on-overlap wants
  a quadtree, and the design session should first say whether labels belong at cloth range at
  all); a "loading" drawing distinct per tier; culling the whole card element rather than its
  body at glyph range (a glyph is a square and a caption — the DOM cost is already near zero);
  animating the tier swap (banned by the stage brief — the instant cut is the honest one).

**2026-08-04 — stage 5 (fibers: marks are files).**

- **`src/fibers.ts` owns the pill and the mark drawing**, as the pinned shape said. Everything
  else was wiring: `model.ts` gained `addMark`/`removeMark`, a `"marks"` `ChangeKind` and a
  `"tether"` `EdgeKind`; `codec.ts` reads/writes the tether and now exports the shared `refOf`;
  `cards.ts` makes a note body editable; `threads.ts` prints marks under each ref; `edges.ts`
  ignores `"marks"` and styles the tether; `main.ts` builds the layer last.
- **The note tether is an EDGE, not the `x-powerset.tether` node field the codec section
  pinned.** The stage brief asks for "a 1px `--ghost` hairline edge", and `edges.ts` already
  draws, hit-tests, bows and re-anchors edges; a node field would need a second, parallel
  drawing path for one line. The file stays readable either way. `threads.ts` refuses to grab
  a thread by a tether (as it already refused `manual`) — a note is not a step in a walk.
- **A new `ChangeKind`, `"marks"`.** Keeping a fiber is not a `content` change: `content`
  re-assigns the card body's `innerHTML`, and laundering marks through it would blow away the
  live text selection and scroll position of every card on a highlight. `edges.ts` ignores it;
  `tiers.ts` picks up the mark count for free; autosave writes it like any other change.
- **Marks are re-applied, never kept.** Provider HTML is re-assigned wholesale on hydration and
  on reload, so `apply(nodeId)` unwraps every `.fiber-mark` and re-wraps the first occurrence
  of each quote. Matching is on the body's text with whitespace collapsed, over a char→text-node
  map, so a quote crossing `<a>`/`<i>` boundaries wraps once per text node and still reads as
  one continuous hairline (verified: a Wikipedia paragraph with five inline links → 9 spans).
  A quote that no longer occurs draws NOTHING rather than underlining the wrong words.
- **A `graph` change re-checks every card, not just the ones it names.** Unpinning a note takes
  its mark with it, and the card still drawing that mark is the *source*, which the change never
  mentions. For an unmarked card the re-check is one `querySelectorAll`, so this is cheap.
- **`removeNode` now also drops marks whose `noteNodeId` is the removed node.** A note card is
  half of a mark; without this, unpinning one leaves the source underlining a card that is gone.
- **The pill waits for the pointer to come up, and dies when the world moves.** It is raised on
  `selectionchange` only while no pointer is down (never mid-drag, or the click target lands
  under the cursor still choosing words), and dismissed on click-away, on any `scroll` (capture,
  since card-body scroll does not bubble) and on any camera change — pan included. Its own
  `pointerdown` is `preventDefault`ed and `stopPropagation`ed, which both keeps the selection
  alive under the click and stops the camera reading the pill as paper to drag. Click-away is
  the pill DROPPING THE RANGE ITSELF — see the same-day fix below; the first cut only hid the
  pill and it came straight back on paper.
- **The pill refuses three cases on purpose:** a selection outside a `.card-body`, one whose two
  ends are in different cards, and one inside a note (a note IS a fiber; it is not marked). It
  also requires the card to be at the FULL tier — at title/glyph range there is no prose.
- **Geometry-as-state for the two mark kinds:** highlight = solid 1px `--sig` under the words,
  note anchor = the same hairline dashed. The dash says "there is a card on the other end".
- **A selection inside an existing mark turns the first verb into `unmark` / `drop note`.**
  Without it an accidental highlight would be unremovable and would persist into `board.canvas`.
  It was cheaper than inventing a click-to-select-a-mark gesture, and it reuses the same pill.
- **Notes are placed INSIDE the visible frame, always.** The first cut walked down from the
  quote's world Y looking for clear air; on a 17-card board that exiled the note ~2500px below
  the fold, where `tiers.ts` culls its body — and a `display:none` element cannot take focus, so
  "focused for immediate typing" silently failed. Now the search runs over three columns (right
  of the source, left of it, then one further right) and rungs 0,+1,−1,+2,−2… clamped to the
  visible world rect; if nothing is free the note overlaps rather than exiling itself.
- **A note body is `contenteditable` (`plaintext-only` where the engine has it) and types
  straight through to the model**, so it persists to `board.canvas` on the same debounce as
  everything else. `cards.ts` skips re-writing the text whenever the body holds focus — the
  content change it is reacting to is almost always that very keystroke coming back around.
- **Handoff format** (the seam stage 3 left): under each card's ref, `> quote` per mark, and for
  a note a second line `note: <the note's text>`. Verified end-to-end in the browser: grab a
  thread by an edge, press `c`, and the strip carries three refs, one highlight and one note.
- **Fix, same day (click-away on paper really dismisses).** As first shipped, a click on empty
  paper hid the pill for an instant and then raised it again in the same place with the text
  still selected — the one gesture a canvas user reaches for to say "never mind" did nothing.
  Cross-module cause, not a typo: `camera.ts`'s `onPointerDown` calls `preventDefault()` on
  paper to start a pan, which suppresses the browser's own selection-collapse, so the Range
  survived the click and `onPointerUpAnywhere → maybeShow()` re-read it and re-raised the pill.
  (Clicking chrome dismissed cleanly, because nothing prevents the default there — which is why
  it read as working.) Fixed in `fibers.ts` alone: `onPointerDownAnywhere` now compares the
  pointer's `.card-body` (if any) against the body holding the live selection, and when they
  differ it calls `dismiss(true)` — dropping the range itself rather than trusting a default
  that paper has already cancelled. Landing in ANOTHER card body drops the old range too: that
  click is the start of a new selection, and its own pill rises on pointerup as before. Landing
  in the SAME body leaves the browser to collapse (it is not prevented there), so triple-click
  and drag-select are untouched. `camera.ts` is unchanged — the pan needs its `preventDefault`.
- **Known, not fixed:** a triple-click selecting a WHOLE marked paragraph does not offer
  `unmark` — the Range's `commonAncestorContainer` is the `<p>`, not a `.fiber-mark`, so
  `markAround` finds nothing. Selecting any fragment inside the mark always works, so the
  escape hatch exists; widening it would mean intersecting the range with the mark spans.
- **Not done, deliberately:** editing or re-anchoring a mark after the fact (drag the ends,
  re-quote); a marks list / index anywhere in the chrome (the title-card count from stage 4 is
  the only readout); marks on note cards; a keyboard route to the pill (it is a mouse gesture by
  construction — the brief's verb is "select text"); tethering an existing note to a second
  source; and any attempt to survive a quote that the provider re-words on re-fetch.

**2026-08-04 — completeness pass (seven gaps, after the five stages).**

- **A revisit now MOVES the camera, not only the ping** (`trail.ts`). The `linkback` and
  `returnedge` arms call the same `nudge()` the spawn path uses. Before this, two of the three
  topology modes answered a click with nothing visible whenever the card you came back to was
  off-screen — so the §7.1 comparison would have been measuring a rendering accident, not a
  topology. Verified in-browser: a linkback to a card at screen (1045, 2531) flies the camera the
  minimum distance that puts it inside the frame (lands at 24, 61 — the nudge margin and the
  toolbar inset).
- **Branch starts are a distinct edge kind at their origin** (`model.ts` + `edges.ts` + CSS).
  New pure predicate `branchStartEdgeIds(edges)` in `model.ts` — insertion order is the primary
  chain (the same reading `threads.ts` already walks by), so every trail edge after a card's
  FIRST is a branch start. `edges.ts` draws an **open `--ink` atom at the fork** (source side),
  the exact counterpart of the filled `--sig` atom the return edge drops where it LANDS: filled
  = "I came back here", open = "the line forked here". The stroke of a branch is an ordinary
  trail hairline — only its origin is marked, so nothing about the existing weave changes. The
  predicate lives in `model.ts` rather than `edges.ts` because it is a statement about the graph,
  not about drawing, and the thread walk is its other natural consumer.
  - **Suppressed at cloth range.** With `setPointAnchors(true)` every edge of a card starts at
    that card's centre, so all its fork rings would pile on one point and say nothing about which
    edge branched. The ring is a reading-range distinction; at glyph tier it is omitted.
- **Board files OPEN, not just export** (`host.ts`, `ui.ts`, `main.ts`). A `load…` button beside
  `save…` reads a `.canvas` through `showOpenFilePicker` and `codec.parse` (already liberal), then
  `board.load` → `hydrateAll` → `zoomToFit`. Feature-detected: no picker, no button (`main.ts`
  passes `canLoadFromDisk`, so `ui.ts` stays ignorant of the platform).
  - **A board file can now be BOUND.** `Host` grew `bindFile(handle)` / `boundFile()`; both the
    open and the save path hand their `FileSystemFileHandle` to the host, and `writeFile` then
    writes that real file on the autosave debounce. The picker is asked for `readwrite` up front
    so the same handle carries the writes; a read-only grant still opens the board, it just does
    not bind. **localStorage is written first and always** — it is the copy that survives a reload
    with no re-pick and a browser with no picker, and a board that lived only in a file would
    vanish on refresh. A write-through that fails **unbinds and throws**, so the save readout says
    the file went away instead of quietly lying. This is what makes the hand-edit-the-JSON and
    agent-round-trip stories real, which was the whole reason the format is JSON Canvas.
  - `saveTextToDisk` now returns `{ok, handle}` instead of a bare boolean (the download fallback
    has no handle to give, and says so in the status line).
- **The instrument is pinned** (`styles.css`). `.tb-zoom` is absolutely positioned at the right
  edge of `#toolbar` on its own `--paper` with the existing hairline, and `#toolbar` reserves
  `padding-right: 7.5rem` so the flowing groups do not slide under it. The strip still clips —
  that is the stage-3 decision, one hairline line at any width — but it now clips its left-hand
  groups instead of eating the altitude readout, which is the one thing a feel session reads out
  loud. Verified at 700px and at 350px: `25% · thread` sits flush right and fully visible.
- **The fit has a floor, and refuses a viewport it cannot measure** (`camera.ts`). `MIN_FIT_Z =
  0.25` joins `MAX_FIT_Z`: a fit never lands below the title band, so a fresh two-card board
  cannot open as a speck in cloth tier. A genuinely huge board is allowed to land AT the floor and
  overflow the frame — cropped and legible beats complete and illegible. Separately, a fit asked
  for while the frame measures under 50px in either axis (first layout, hidden pane, headless) is
  **deferred**, not computed: it is held in `pendingFit` and run on the first non-degenerate
  layout tick. A `ResizeObserver` on `#viewport` feeds that alongside `window.resize`, because a
  first layout does not always arrive as a window resize.
- **The status readout counts the residue** (`ui.ts`): `n cards · n threads · n marks`, live from
  the model. Brief Q5 (the entropy question) asks what 30 minutes of wandering LEAVES; it deserves
  numbers rather than an impression — cards is the walk, threads is what was kept of it, marks is
  what was kept of them. (The counter still hides under 860px, as before.)
- **Culling no longer costs the reader their place** (`tiers.ts`) — the known cost logged in
  stage 4 is now fixed, and the culling itself is untouched. A body's `scrollTop` is stashed
  before `display:none` and restored when it comes back; the stash is never cleared, so a body
  that returns still hidden can be restored the next time it is genuinely on screen. Two honest
  details: the restore re-tries once on the next frame when the engine has not re-laid the body
  out yet (the first assignment silently reads back 0), and the same stash covers the **tier**
  swap out of and back into the full band — leaving the full band hides the body by CSS, which is
  the identical teardown, and without that one zoom-out would undo the fix. Verified in-browser:
  scrollTop 250 → dragged off-screen (culled, `display: none`) → dragged back → scrollTop 250.
- **Not done, deliberately:** persisting the bound file handle across a reload (IndexedDB, the
  same call stage 2 made for folder handles — a reloaded board falls back to localStorage and the
  user re-picks); an "unbind" gesture (the only way to stop writing a file is `load…`/`save…`
  elsewhere, or a failed write); a fork ring on `manual` edges (an asserted edge has no primary
  chain to branch from); and any change to the culling policy itself.
