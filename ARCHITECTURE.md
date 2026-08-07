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
  unit, pin (freeze membership), handoff → `host.sendToComposer(...)`, and the gestures for
  the three ENTROPY VERBS plus their shared inverse (`t` pull/put back · `b` comb · `r`
  relax). Thread IDENTITY (tip-tracking, branch, break) is `model.ts`'s: `growthForEdge` and
  `resolveThreadForRun` are pure predicates there; this module only applies them.
- `src/arrange.ts` — the entropy verbs as PURE geometry (wave-2 §3): `relaxSpots` (back to
  `prov.x0/y0`), `combSpots` (straighten + space the run, minimal motion), `tautSpots` (the
  even arc, moved here from `threads.ts`), and `scopeKey`. Every function takes an array of
  nodes and returns positions for ids drawn only from that array — which is how "a verb never
  moves a card outside the selection" is enforced rather than promised. No DOM, no board, no
  animation: `threads.ts` owns the gesture, the ease and the restore point.
- `src/tiers.ts` — semantic zoom: swap card body by z band. Bands (tune by feel):
  z ≥ 0.55 full · 0.18 ≤ z < 0.55 title-card (serif title + mono path/status) ·
  z < 0.18 glyph (hairline square + pixel-scale label). CSS class swap on `.card`,
  content lazy-rendered once per tier.
- `src/fibers.ts` — text-selection pill (Highlight · Note · Send to composer · Mark ▸);
  marks persist in model; notes are small text cards tethered to their source. The pill's
  fourth action stamps a GLYPH (wave-2 §2) by calling `board.addGlyph` — the drawing,
  selection and file belong to `glyphs.ts`.
- `src/glyphs.ts` — MEANING-marks, the second species of thread: a five-glyph palette
  stamped on passages, drawn per tier (margin · card head · cloth constellation),
  selectable as a unit with the thread inversion idiom, handable with `c`, and accruing
  `marks/<name>.md` through the Host seam. No edges — the set IS the binding (ideation §9.3).
- `src/quotes.ts` — the shared quote anchor: collapse, index a body's text, wrap the first
  occurrence, unwrap by class. Both mark species use it so they cannot drift apart.
  **Anything a decorator inserts into a body must contribute NO text nodes** or it corrupts
  the other species' index (glyph atoms carry their character in CSS `content:`). It also
  owns `elide` / `ECHO` — the one pill length every echo of a quote uses (status line, note
  title, composer handoff), so the chrome cannot disagree with itself about how much of a
  passage it shows.
- `src/facets.ts` — PLACEMENTS WITH A VIEWPORT (wave-2 §4): `split` (a second window on the
  same card, `s` / `⊞`), the article OUTLINE (`o` / `≡`, click = scroll here, alt-click =
  split a facet parked at that section), and PARKING (a placement remembers the heading it
  is looking at, in `LoomNode.viewAnchor`, restored after every re-render). It reads the
  card bodies the card layer owns and never rebuilds them.
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
- Top level extra: `"x-powerset":{topologyMode,contentMode,threads:[{id,name,nodeIds:[...],prov}],
  marks:[{id,nodeId,quote,kind:"highlight"|"note",noteNodeId?}],
  glyphs:[{id,glyph,nodeId,quote,prov}]}`
- **`glyphs` is a collection PARALLEL to `marks`** (wave-2 §2): a fiber is a passage kept
  where it was found, a glyph is a passage claimed by a thought that recurs elsewhere. The
  key is omitted entirely on a board with no stamps. The glyph NAME is never narrowed to the
  five-glyph palette — a file may carry a sixth, and it rides through and draws as its own
  initial. A glyph-file card is an ordinary `text` node carrying
  `"x-powerset".glyphFile:"<glyph>"`; it renders `marks/<glyph>.md` and is read-only.
- **Every node and edge carries `"x-powerset".prov`** (wave-2 §0):
  `{at:ISO-8601-UTC|null, by:"human"|"agent", how:"wander"|"place"|"capture"|"mark"|"reply",
  from:nodeId|null, src:url-or-path|null, x0,y0}` — `x0/y0` = world coords at birth, nodes only.
  A **thread entry** carries the same object as a plain TOP-LEVEL `prov` field (it has no
  `x-powerset` block to nest one in). Written at creation, backfilled on load, preserved verbatim.
- **A restore point** is `"x-powerset".arrangements:[{key,verb,at,spots:[{id,x,y}]}]`
  (wave-2 §3) — where a set of cards stood immediately before an arrangement verb moved them.
  `key` is the scope (`board` · `thread:<id>` · `run:<id>|<id>…`), `verb` is `pull|comb|relax`.
  Wave 1 kept this in a module-local Map, so a reload mid-pull made the arc permanent; it is
  board state now, so un-arranging survives a reload. The key is omitted on a board nobody has
  arranged. One entry per scope, first-writer-wins (a comb on top of a pull still puts back to
  where the HAND left the cards), and a wider verb retires the narrower points it wholly
  subsumes. Spots naming a card the board no longer has are pruned on load, and an entry left
  with nothing to restore is dropped.
- **A thread entry** is `{id,name,nodeIds,pinned?,broken?,prov}` (wave-2 §1). `pinned: true`
  freezes membership; `broken: {at, missing:[{id,index,title}]}` records cards an edit took away.
  Both are written ONLY when present, so an ordinary thread's entry is the wave-1 shape.
- **A FACET is a second placement of one card** (wave-2 §4): `"x-powerset".facetOf:"<nodeId>"`
  plus an optional `"x-powerset".viewAnchor:"<heading text>"`. Both are written only when
  present, so a board with one placement per card is byte-identical to wave 1's. `facetOf`
  always names a ROOT placement — `makeNode` and `load` flatten a facet-of-a-facet, drop a
  self-reference, break a cycle, and demote a facet whose card is not in the file.
  **What binds to the card**: content (`setContent` writes through to every placement),
  marks, glyph stamps, trail edges, thread membership — all stored under the ROOT id, and
  `load` rewrites a file that named a facet instead. **What binds to the placement**: `x/y`,
  `width/height`, `viewAnchor`, and `prov` (including `x0/y0`, so relax treats windows
  separately). A `viewAnchor` is a HEADING TEXT, never a pixel offset, for the same reason a
  mark is a quote: provider HTML is re-fetched constantly and an offset rots silently.
- **Unknown fields are preserved verbatim** on every object and at board level — additive schema
  discipline. A hand-edit, a plugin's key, or an agent's extension survives a round trip.
- **An empty `title` is read as a missing one.** P0 convention gap #2: the agent wrote
  `"title": ""`, `??` never fired, and four cards captioned themselves "untitled". Blank now
  falls back to `model.fallbackTitle` (first line of a note's text; the ref's tail otherwise),
  which `makeNode` also applies, so neither a file nor a creation site can produce one.
Marks anchor by quoted text (first occurrence), not offsets — survives re-render, fine for
a prototype.

## Interaction conventions

- Left-drag on paper = pan (and marquee later — alt-drag reserved for marquee).
  Left-drag on card = move card; drag the corner grip = resize it (grid-free, floor 120×80).
  Wheel = pan; ctrl/cmd+wheel & pinch = zoom-at-cursor.
  Double-click paper = zoom-to-fit. `1`..`3` set topology mode; `f` zoom-to-fit.
- Facets (wave-2 §4): `s` (or `⊞` in the card head) splits a second window on the selected
  card; `o` (or `≡`) toggles its outline; an outline entry scrolls this window there and
  ALT-clicking one splits a facet already parked at that section.
- **Composer handoffs are keyed BLOCKS, not appended lines** (wave-2 §4, critique-ledger
  item 7). `host.sendBlock(key, lines)`: the same key with the same lines COLLAPSES (the
  block already there is marked `×n` — pressing `c` twice says "yes, that one" rather than
  saying it twice); the same key with different lines REPLACES (the stale copy goes, the new
  one lands at the end, because the strip is read from the bottom); a new key appends. Keys
  are `thread:<id>` / `run:<ids>` / `glyph:<name>` / `card:<id>` / `fiber:<card>:<quote>`.
  Quotes inside a handoff are elided at pill length with counts beside them, since the full
  text is already in the board file and in `marks/<glyph>.md`.
- Entropy verbs (wave-2 §3): `t` pull the selected thread taut — or, whenever a restore point
  is held for the current scope, put every card back where the hand left it. `b` comb the
  selected thread. `r` relax: scope FOLLOWS THE SELECTION (a thread if one is grabbed, the
  whole cloth if not); `shift-r` (or shift-click `relax`) forces the whole cloth and lets go
  of the thread first, so the scope acted on is always the scope the chrome is showing.
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

**2026-08-06 — wave 2, stage 0 (the provenance substrate).**

No new module and no new UI: `model.ts` gains the vocabulary, `codec.ts` gains the read/write,
and the four creation sites (`trail.ts`, `fibers.ts`, `cards.ts`, `threads.ts`) each say one
honest thing about how the object they make came to be.

- **`prov` lives INSIDE `x-powerset`, not beside it — but the brief's literal key is READ.**
  The wave-2 brief writes the block as `"powerset:prov"`, but wave 1 already shipped the
  `x-powerset` namespace and the P0 agent already wrote into it. A second namespace on the same
  object would be two conventions to explain to the next agent, so what this build *writes* is
  `"x-powerset": { kind, title, ref, prov: {…} }` on nodes and `"x-powerset": { kind, prov: {…} }`
  on edges. A deviation on the write side must not become a deviation on the read side, though:
  a top-level `"powerset:prov"` — the shape the brief specifies, and the shape its Appendix tells
  the next agent experiment to write (`powerset:prov.by = "agent"`) — is read as first-class
  provenance by `readNode`, `readEdge` and `readThreads`, and is **consumed** rather than
  replayed as a foreign key, so the object never carries two copies that can drift. Precedence:
  `x-powerset.prov` (or a thread's top-level `prov`) · `powerset:prov` · the P0 agent's nested
  block. Fixed 2026-08-06 in the wave-2 fix pass; before it, a file written exactly as the brief
  specifies loaded as `human · wander` with its real provenance inert in the leftovers.
- **A thread entry carries `prov` at its TOP LEVEL** — this is P0 convention gap #1, closed. A
  thread has no `x-powerset` block of its own to nest anything in; the P0 agent, told "inside
  every x-powerset block you write", reasonably invented one. `readThreads` **migrates** that
  nested `prov` up to the top level and drops the now-empty husk, so the P0 board opens and
  re-saves with exactly one copy. Any *other* key in that nested block is kept.
- **`prov` records `x0`/`y0`: the world coordinates a card was BORN at.** Not in the brief's
  field list, added by it in prose — and it is the whole reason stage 3's `relax` can exist. It
  is written by `makeNode` for every node from the spawn position, so no creation site can
  forget it; a loaded card that lacks it takes its current position (the only honest guess).
  Edges and threads have no position and carry neither key.
- **The `how` verbs, as assigned by this stage** (the enum is the brief's; the mapping is a
  decision): link click → `wander` (the spawned card, its trail edge, and a `linkback`/`return`
  edge on a revisit) · seed or explicit open (`spawnRoot`) → `place` · alt-drag manual edge →
  `place` (an assertion, not a walk) · fiber note card and its tether → `mark` · naming a
  thread → `capture` (the moment a run becomes an object). `reply` is written by agents only,
  never by this build.
- **`src` on a trail is the href AS THE DOCUMENT WROTE IT**, not the resolved ref. `follow()`
  gained a `rawHref` parameter for exactly this: a Wikipedia redirect slug
  (`/wiki/Computer_algorithm`) reaches a card whose ref is the canonical title, and provenance
  is the only place that difference can now be kept — FINDINGS learning 3 ("record what was
  *followed*, canonicalize what was *reached*") is answered by the substrate rather than argued
  about.
- **Unknown fields now survive the round trip, everywhere.** New `Foreign` type
  (`{ top?, ext? }`) on nodes, edges, threads and the board snapshot, plus a flat
  `Record` on marks and an index signature on `Prov` itself. On read, every key this build does
  not own is set aside; on write it is replayed, and a foreign key can never clobber an owned
  one. So a JSON Canvas `color`, a plugin's block, a future wave's field, or an agent's extra
  `prov` key all come back out byte-equal.
  - **`fromSide`/`toSide` are deliberately NOT owned.** The renderer picks sides from live
    geometry and only synthesizes advisory ones for foreign readers; treating them as foreign
    means a file that states its own sides keeps them, and a file that does not still gets ours.
  - **Marks get no `prov` this stage** (the brief scopes §0 to nodes, edges and thread entries)
    — but a `prov` a file carries on a mark rides through verbatim, so the glyph stage can start
    writing one without a format change.
- **The codec is a FIXPOINT from the first save onward, not from the file.** The first save of a
  wave-1 board legitimately adds the backfilled `prov` (that is the deliverable); every save
  after that is value-identical. Verified against the real `Out/sample-board.canvas` and the P0
  agent board: `load(save(x)) === save(x)`, and a structural diff ignoring `prov` shows the two
  boards come back *identical* apart from the P0 thread's emptied nested block.
- **Backfill is `{ by: "human", how: "wander", at: null, from: null, src: null }`**, per the
  brief, uniformly — including for threads, which are never literally wandered into being.
  `at: null` is deliberately distinguishable from a real stamp so a later prov lens can grey out
  what it does not know instead of inventing a file mtime.
  - One asymmetry worth knowing: an **absent** `from` key takes a sensible fallback (an edge's
    source node, a thread's root), but an **explicit** `from: null` means null. Without that
    distinction the codec is not idempotent — it writes `null` and reads back the fallback.
- **`by` and `how` are narrowed to their unions on read.** A value outside them is a schema
  violation the renderer cannot act on, so it is coerced to `human` / `wander`. This is the one
  place the codec is not verbatim, and it only bites files that were already wrong.
- **API changes, all contained:** `addEdge(from, to, kind, spec?)` — the old positional `label`
  became `spec.label` (five call sites, none of which passed a label);
  `addThread(name, nodeIds, prov?)`; `NodeSpec` gained `prov?`/`foreign?`.
- **Not done, deliberately:** any UI (no prov lens, no agent-made badge, no "created" readout —
  §8.3 is explicitly out of wave 2); prov on marks; a `pinned` field on threads (stage 1's, and
  it already round-trips as a foreign key today); reading a file's mtime as the backfill stamp
  (`null` is the honest answer and the file may be a copy); and rewriting the P0 folder's
  `BOARD-CONVENTION.md` to the new thread-`prov` spot — that file lives outside this repo and
  belongs to whoever runs the next agent experiment.

**2026-08-06 — wave 2, stage 1 (thread identity: tip-tracking + pin).**

Wave 1 identified a thread by exact-run equality, so a named thread silently lost its name the
moment the trail grew by one spawn (FINDINGS Q2, observed live on the owner's board). The
replacement is two rules that are deliberately NOT the same rule, plus one invariant.

- **Growth is an EVENT; resolution is a MATCH.** `model.growthForEdge(threads, edges, edge)` is
  a pure predicate that says which threads a newly-arrived trail edge extends;
  `threads.ts` applies it from its board listener and does nothing else with it.
  `model.resolveThreadForRun(threads, run, edge?)` decides which stored thread a walked run just
  grabbed. Both live in `model.ts` beside `branchStartEdgeIds` for the same reason stage 3 gave:
  they are statements about the graph, not about drawing — and it makes them testable off-DOM.
- **Growth never fires on a load.** `board.load()` emits `reset`, never `graph`, so a membership
  a FILE declared is respected exactly as written; only what happens next, in front of the user,
  can extend it. This is additive-schema discipline applied to threads, and it is what keeps an
  agent's declared reply from being quietly annexed the first time the board is opened.
- **The invariant: a named thread's selection IS its stored membership.** The walked run only
  decides *which* thread you grabbed. Without it, "grab" and "grow" fight over the same state
  every time a run reaches past a thread. It also made `commitName` drop its `setThreadNodes`
  call — a rename must not annex whatever the walk reached, and must not walk through a pin.
- **Branches fall out of the existing "primary chain" reading.** A thread extends only when the
  new edge is its tip's FIRST outgoing trail edge (or its root's first incoming one) — the same
  insertion-order reading `branchStartEdgeIds` and the thread walk already share. A second spawn
  from the same card is a branch: the name stays with the spine, the branch is born unnamed. No
  new state, and the three surfaces cannot disagree about what a branch is.
  - Consequence, verified and accepted: unpinning does **not** retroactively swallow what the
    trail did while the thread was frozen. If the tip spawned during the freeze, that first
    outgoing edge is spent, and the next one reads as a branch. Unpinning hands the thread back
    to its own tip, not to the trail's.
- **Growth from the ROOT end is supported** (the brief says "either endpoint"), and it is the
  shape an agent's anchor edge takes. It is `graph`-event-gated like tip growth, so the P0 board
  — whose anchor edge is already in the file — is unaffected by it.
- **The P0 anchor-edge case (FINDINGS "P0", convention gap 3) is answered by CONTAINMENT, not by
  extension.** The P0 agent declared a 6-card reply and anchored it with a trail edge from the
  owner's own margin note, so the walk yields 7 cards and no equality test can ever match.
  `resolveThreadForRun` matches the declared 6 as a contiguous block of the 7: **the name
  resolves from either the anchor edge or any inner edge, and the membership is left exactly as
  the agent wrote it.** Deciding the other way (extend to fit) would annex a human's note into an
  agent's thread merely because the walk passed through it, and would rewrite a file's
  declaration on first open. The anchor stays visible as what it is — the card the reply hangs
  from — and the status line says so (`the run reaches 1 card further`).
- **A name never detaches silently** — the brief's one hard constraint, and wave 1 broke it two
  ways. `removeNode` used to filter the id out of every thread and *delete* any thread that hit
  zero cards. Now the loss is recorded on the thread (`broken: {at, missing:[{id,index,title}]}`),
  the surviving membership stays in order, and a thread that loses every card **keeps its name
  and its whole loss list**. The title is captured at removal time because it is the only
  readable trace a deleted card leaves.
  - Resolution tier 2 exists for exactly this: a broken thread's survivors are matched as an
    order-preserving SUBSEQUENCE of the run (gaps allowed), so grabbing the run after a
    mid-thread deletion still hands back the name — marked broken — instead of "unnamed".
  - The break draws itself with no extra code: `edgesOfRun` finds no edge across the gap, so the
    selected thread has a visible hole in the weave.
  - `mendThread` is the only way to clear a break, and it is an explicit click on the readout.
    It clears the record, never the name and never the membership.
- **State is geometry, on both surfaces.** Nameplate: an 8px open atom = "still follows its tip",
  the same atom filled = pinned; the plate's frame goes dashed and grows a `n lost` button when
  broken. Toolbar chip: a 6px filled `currentColor` atom for pinned (so it survives the chip's
  inversion when active), `border-style: dashed` for broken. No tint, no badge colour, no glow.
- **New verb `pin`** — key `p`, a toolbar button that flips to `unpin`, and the nameplate atom.
  Only a NAMED thread can be pinned: a pin freezes a name's membership, and an unnamed run has
  no name to freeze. Reversible by construction (ideation §7 meta-rule).
- **The pull stash is keyed by thread identity now** (`threadId ?? run:<ids>`), not by the
  membership string. A thread that follows its tip while pulled would otherwise change key
  mid-pull and strand its own undo — the same failure wave 1 already logs for reloads. This is
  also the only form of the key that can survive the reload stage 3 has to fix.
- **Handoff tells the truth about a broken or pinned thread**: `· pinned` on the header line, and
  one `(missing: <title> — was card N)` line per loss. An agent on the other end is told what the
  line lost rather than handed a shorter line as if it were whole.
- **Verified.** `npm run build` clean. A compiled-to-node harness (49 assertions) over the real
  `Out/p0-agent-thread/board.canvas` and `Out/sample-board.canvas` plus synthetic boards: the P0
  name resolves from both the anchor edge and an inner edge with membership untouched; the two
  human threads on that board do not claim the reply run; `load(save(x)) === save(x)` still holds
  with pins and breaks present, and unpinned/unbroken threads gain no new keys. Then in-browser
  against the OWNER'S REAL 28-card board: pin by `p` (status, plate atom, chip atom, button flip,
  `pinned:true` persisted to the file), a 5-card named thread grown to 6 and re-grabbed **by
  name** (the wave-1 bug, gone), spine-vs-branch, pin freezing growth, a mid-thread delete
  surfacing as a dashed plate + `1 lost` + dashed chip, and a thread that lost every card keeping
  its name in the toolbar. The board was restored to 28 cards / 28 edges / 5 marks / 2 unpinned,
  unbroken threads afterwards.
- **Not done, deliberately:** merging/splitting threads and hand-editing membership (still
  ideation §7.4 open questions — the gestures would be invented, not felt); a card belonging
  visibly to two threads (the last selection still wins the paint); multi-thread selection;
  auto-mending a break when the deleted card is re-spawned (a new card is a new placement, and
  pretending otherwise is the silent behaviour the constraint forbids); persisting the pull stash
  (stage 3's, and the key is now ready for it); any prov UI (§8.3 is out of wave 2).

**2026-08-06 — wave 2, stage 2 (glyph marks: the meaning-thread palette).**

The brief's biggest unknown, built choreography-first. A trail records MOVEMENT (where
attention went, drawn as edges); a glyph records MEANING (one thought recurring in several
places, drawn as a stamp wherever it recurred). Two new modules — `src/glyphs.ts` (the
species) and `src/quotes.ts` (the anchor both species share) — plus the model/codec
vocabulary and one new verb on the fiber pill.

- **The palette is five, named for their shapes, and the NAME is the file name**:
  `dot ●` · `ring ○` · `lozenge ◆` · `prism ◇` · `star ✳`. Filled/open pairs plus the
  asterisk, so the vocabulary reads as geometry rather than as five arbitrary icons; no
  colour role beyond ink. `prism` rather than the obvious "facet" because wave-2 §4 already
  spends that word on a second placement of a card.
- **Stamping is one click, and that took a decision.** The brief asks for a fourth pill
  action "Mark ▸ [glyph]", which is two clicks — and its own bar is *highlight speed*. So
  the expander is STICKY: it opens once and stays open for the session, and from the second
  stamp onward the gesture is a single click on the glyph. Pressing a glyph the passage
  already carries takes the stamp back off, so the gesture is its own undo and no second
  control had to be invented.
- **`src/quotes.ts` is an extraction, not a new idea.** There are now two mark species
  anchoring by quoted text, and two copies of a quote matcher would have drifted the first
  time one was fixed. `fibers.ts`'s `index`/`draw`/`unwrap` moved there wholesale and both
  layers call `wrapQuote`/`unwrapAll`. Each unwraps ONLY its own class, so the two decorate
  the same body without fighting and their order is a preference rather than a contract.
  - **The one hard rule it creates: a decorator may not add TEXT to a body.** Both layers
    index the body's text to find their quotes, and a stray "●" in the flow would shift
    every later match by one character. Glyph atoms therefore carry their character in a
    CSS `content:` fed by a custom property (`--glyph-char`), never as a text node. Verified
    live: with four stamps drawn, the two pre-existing fiber marks still wrapped exactly.
- **A marginal mark hangs beside the BLOCK, not beside the line.** Tying it to the exact
  line would need measurement and would move on every reflow of a card being resized or
  scrolled; tied to the paragraph it is stable and it is what a marginal mark has always
  been. A card widens its own left gutter (`[data-glyphs] .card-body { padding-left }`) only
  when it carries stamps, so unmarked prose keeps its full measure. Measured in-browser at
  z=0.64: atom spans screen x 86–90, body edge 81, text starts 97 — clear of both.
- **One element, three drawings, no third rendering path.** `.card-glyphs` lives in the card
  head and CSS re-dresses it per tier exactly as the card itself is re-dressed: a quiet row
  beside the title at reading range, counter-scaled with the title card at thread range, and
  at cloth range lifted above the knot as **the constellation**. Verified at z=0.05: the
  atoms sit above each square, screen-constant, and the answer to "where did this thought
  appear?" is legible without reading anything.
- **Cloth captions are now a policy, and it is toggleable** (`tiers.ts CAPTIONS_AT_CLOTH`,
  toolbar `captions`). Glyph-caption collision was already a known cosmetic failure
  (FINDINGS Q4); critique-ledger item 6 proposed resolving it by design — at cloth altitude
  a caption is a REGION LABEL, so only cards a named thread holds keep one. Default is the
  candidate (suppressed), on the same principle stage 2 used for the topology toggle: the
  session should react to the hypothesis, not to the control. The glyph atoms are drawn
  either way, which is the actual §7.6 experiment.
- **Selection is the thread inversion idiom, deliberately identical** (critique-ledger item
  8 asked for that idiom to be canonical). Clicking any stamp — margin, head, or toolbar
  chip — lights every card holding that glyph and recedes the rest. A chip click also frames
  the constellation; a click on a stamp in a card does not move the camera, because you are
  reading. **A glyph selection and a thread selection are mutually exclusive** and clear each
  other through two wiring lines in `main.ts`: they claim the same inversion, and two lit
  selections would be two answers to one question.
- **No edges from a glyph to its cards.** Ideation §7.6 floats them; §9.3 answers it — "the
  tie of the edge" is the anti-pattern at scale. The set IS the binding and selection is how
  you see it. Twenty edges from one card would bury the trail the board is about.
- **The glyph file is written through the Host seam on a 220ms debounce**:
  `host.writeFile("marks/star.md", …)`, which under the localStorage host lands at the key
  `loom:marks/star.md` — that IS the file seam in this prototype (`host.ts storageKey`); on
  a File System Access host it is a real file and nothing in `glyphs.ts` changes. Content is
  ordered quotes with source refs, in STAMP order (the order the thought accrued, not
  grouped by card — the recurrence across places is the point). Regenerated wholesale rather
  than patched, and a glyph whose last stamp is removed gets a final write saying so rather
  than being left stale.
- **The glyph file IS placeable, and it cost one modeled field.** `LoomNode.glyphFile` marks
  a note-shaped card as a *rendering* of `marks/<name>.md`; `cards.ts` leaves it read-only
  (a note is editable, a rendering is not — typing into a file that is about to be
  overwritten is a lie), `glyphs.ts` rewrites its text whenever the collection changes, and
  the fiber pill refuses to mark it. That was the whole cost, so the brief's "only if it
  drops out nearly free" was met; without the read-only field it would not have been.
- **`removeNode` drops a card's stamps without ceremony** — deliberately unlike a thread. A
  thread is an ordered line whose NAME must survive a hole (wave-2 §1's hard constraint); a
  glyph is an unordered set, so losing one of its places leaves the rest meaning exactly what
  it meant. The file regenerates one entry shorter. No break record.
- **Codec.** `glyphs` is a collection parallel to `marks`, not a widened `Mark.kind`: one
  list would have made both queries scan the other's rows and would have put two species
  under one word. The key is omitted entirely when empty, so a board that never used the
  palette keeps its exact shape and the fixpoint holds (absent reads as `[]`, `[]` writes as
  absent). A stamp with no `prov` backfills to `how:"mark"` — `readProv` gained a `how`
  fallback for exactly this, applied only when the file did not say.
  - **A foreign glyph name is NOT coerced into the palette.** Coercing would silently merge
    two collections and dropping would be the one un-additive act in the codec; it rides
    through, draws as its own initial, and gets its own toolbar chip.
  - A stamp whose `nodeId` is not on the board is kept (marks behave the same; edges do not,
    because an edge with no ends cannot be drawn at all).
- **Verified.** `npm run build` clean. A compiled-to-node harness (**47 assertions**, all
  pass) over the real `Out/p0-agent-thread/board.canvas` and `Out/sample-board.canvas` plus a
  hostile synthetic board: both wave-1 boards load unchanged and gain no `glyphs` key; the
  codec is still a fixpoint with stamps, foreign glyph names, foreign prov keys, foreign
  top-level keys and a `glyphFile` node present; an agent-authored stamp keeps `by:"agent"`.
  Then in-browser on the sample board: stamped four passages across three cards through the
  pill (single click from the second on), margin atoms and head badges drawn, fiber marks
  untouched, `loom:marks/star.md` and `loom:marks/lozenge.md` written and rewritten on every
  change, glyph selected as a unit (thread selection cleared, note and file card receded),
  `c` handed off the whole collection, `file…` placed a read-only `marks/star.md` card that
  then grew with the next stamp, cloth range showed the constellation with captions muted for
  the two cards outside the named thread, the `captions` toggle put them back and took them
  away again, un-stamping emptied a glyph and rewrote its file honestly, and a reload restored
  every stamp, mark and drawing with zero console errors. The pane's board was cleared back
  to its fresh seed afterwards.
- **Not done, deliberately:** dedup of two identical glyph atoms in one paragraph (two stamps
  are two locations, and the stack tells the truth); a glyph RENAME or a sixth glyph from the
  UI (the palette is a fixed vocabulary under test — the codec tolerates more, the chrome
  offers five); stamping from the keyboard (the gesture is "select text", a mouse gesture by
  construction, exactly as the fiber pill is); marks or stamps on a glyph-file card; composer
  elision for glyph quotes (wave-2 §4 owns the elision convention — this handoff prints full
  quotes, consistent with the thread handoff it sits beside); any prov UI (§8.3 stays out of
  wave 2); and the ideation §9.3 "skein" reading of glyph-as-set — the set is an
  implementation fact here, not a surfaced concept.

**2026-08-06 — wave-2 stage 3 (entropy verbs: relax + comb + a persistent restore point).**

- **New module `src/arrange.ts`** (not in the pinned module list). The three verbs are pure
  functions of the nodes handed in — no DOM, no board, no animation — so the brief's actual
  question ("does comb ever move a card outside the thread?") is answered by construction and
  checkable without a browser. `threads.ts` lost its private `tautSpots`, `TAUT_GAP`, `SAG_*`.
- **Wave-1's pull-taut promise held.** `tautSpots` only ever named ids from the array it was
  given, and the caller only ever gave it `selection.nodeIds`. Verified rather than believed
  (harness + a live comb with two non-thread cards watched: neither moved by a pixel).
- **RELAX is a restore, never an invention.** Targets come only from `prov.x0/y0`; a card
  whose birthplace the board never recorded is left where it is and COUNTED, and the status
  line says which of the three reasons "nothing happened" applies — including the one that
  matters for old boards: *"the cloth predates provenance: every birthplace was backfilled on
  first open, so this IS the as-wandered arrangement"*. A wave-1 board relaxes to nothing, and
  says so. Inventing a tidy layout there is exactly the auto-sort this rung exists to avoid.
- **COMB is minimal-motion, not a second pull.** It fits the run's own least-squares axis
  (not the root→tip heading pull uses — a run whose ends happen to sit close together still
  has a direction), drops each card's perpendicular offset, then walks the run in trail order
  pushing a card forward ONLY where it would crowd its predecessor, and re-centres on the
  centroid so combing twice does not walk the thread across the cloth. It therefore keeps the
  walk's RHYTHM — a long pause between two cards stays a long gap — where pull discards it
  on purpose. Comb is idempotent; a straight, well-spaced thread reports *"already combed"*
  and moves nothing.
- **The restore point moved into the board** (`x-powerset.arrangements`), which is what makes
  wave 1's known issue go away: pull, reload, and the toolbar still says `put back`. Design
  decisions inside it:
  - **One entry per scope, first-writer-wins.** A comb applied on top of a pull does not
    redefine the restore point as "before the comb", or two verbs in a row would become
    unreversible one verb at a time.
  - **A wider verb retires the narrower points it wholly subsumes.** Found live, not
    reasoned: pull a thread, then relax the whole cloth, and the thread still offered `put
    back` — to positions from before a move that had since happened to every one of its
    cards. Overlap alone does not retire (two threads sharing a card is ordinary); only total
    containment makes the older point meaningless.
  - **Relax takes a restore point too**, so the deeper undo is itself undoable. Nothing here
    is a one-way door, which is the §7 meta-rule applied to layout.
  - `removeNode` prunes a card out of every entry and drops one left empty; `load` prunes
    spots naming cards the file no longer has (the same rule edges already follow).
- **`board.moveNodes(spots)`** — new, and load-bearing for a whole-cloth relax: 30 cards
  animating would otherwise emit 30 changes a frame and make every layer downstream redraw 30
  times for one visible motion. `edges.ts`, `fibers.ts` and `glyphs.ts` also learned to
  early-return on the new `arrange` change kind (a restore point moves nothing).
- **The ease is decoration; the move is not.** A throttled or hidden tab starves
  `requestAnimationFrame`, and the restore point is spent the moment the verb runs — so an
  animation that never gets a frame would consume the undo without moving anything. Observed
  in the Browser pane, fixed with a `setTimeout` net that lands the cards on their targets if
  the ease has not finished by `PULL_MS + 250`.
- **Chrome: a new `arrange` toolbar group** holding `pull taut` / `comb` / `relax`, and the
  pull button now carries its own inverse (`put back`, inverted) rather than the wave-1 label
  `relax` — which the entropy verb has now taken, and which meant something different.
  `comb` is disabled without a selection; `relax` never is, because without a selection it
  means the whole cloth. `ui.setActiveThread` lost its `pulled` argument to a separate
  `setArrange(restore, hasSelection)`, since a whole-board relax changes what may be offered
  without changing what is selected (`threads.ts` gained `onArrange` for the same reason).
- **Verified.** `npm run build` clean; an off-DOM harness (**56 assertions**, all pass) over
  `Out/p0-agent-thread/board.canvas`, `Out/sample-board.canvas` and synthetic boards: both
  real boards load unchanged and gain no `arrangements` key, the codec is still a fixpoint
  with restore points present, an unknown verb narrows to `pull`, an entry's unknown keys ride
  through, dead spots are pruned, and *pull → serialize → reload → put back* lands the cards
  back on their pre-pull coordinates. Then in-browser on a tangled 6-card board with a named
  4-card thread: whole-cloth relax restored the as-wandered staircase; a full page reload
  still offered `put back` and un-relaxing worked (the wave-1 bug, gone); comb straightened
  the thread and left the two non-thread cards untouched to the pixel; un-comb restored the
  tangle exactly; thread-scoped relax moved only its four; `shift-r` let go of the thread and
  relaxed the cloth; pull-taut's arc and comb's line were visibly different verbs; and
  relaxing an already-relaxed cloth said so instead of doing nothing quietly. Zero console
  errors; the pane's board was restored to its original seed and no `window.__loom`-style
  source hook was ever added.
- **Not done, deliberately:** ideation §7.5 rung (c), arrangement memory — named layout
  snapshots you can return to. The restore points are one unnamed snapshot per scope, which is
  the machinery rung (c) needs but not the surface; naming them is a feature with a UI, and
  the brief scoped rungs (a)–(b). Also not done: any collision avoidance against non-thread
  cards (comb can now leave a thread lying across a card it does not own — that is the price
  of "never moves what you did not select", and the session should say whether it hurts); an
  animation for relax that differs from pull's (one ease, one reading of "these move as one");
  and any garbage collection of restore points by age.

**2026-08-06 — wave-2 stage 4 (facets, the outline, and four from the critique ledger).**

The owner's third critique: "multiple instances of the same card feel near-necessary — I want
to compare two sections of one article side by side." Ideation §3.1 already said a card on the
cloth is a PLACEMENT rather than the thing; §7.7 refines it to placement = (card, position,
viewport). One new module (`src/facets.ts`), one new modeled relation (`facetOf`), one new
per-placement field (`viewAnchor`), and the small chrome the ledger asked for.

- **THE SPLIT IS IN THE MODEL, NOT IN A COPY.** A facet is a `LoomNode` with
  `facetOf: <root id>`. The line that decides everything else: **content, marks, glyph
  stamps, trail edges and thread membership bind to the CARD; position, size, scroll anchor
  and provenance bind to the PLACEMENT.** `board.contentRoot(id)` is the one hop that
  expresses it, and `addMark`/`addGlyph`/`addEdge`/`addThread` canonicalize through it on the
  way in while `marksOf`/`glyphsOf` canonicalize on the way out. So "highlight in one facet,
  see it in both" is not a synchronisation feature — there is only ever one highlight, and
  two windows drawing it. `setContent` is the mirror image: it writes through to every
  placement and names them all in the change, so a note typed into one facet appears in the
  other with no observer anywhere.
- **`facetOf` is always FLAT.** A facet of a facet, a facet of itself, a two-node cycle, a
  facet of a card the file does not contain — `makeNode` and `load` each reduce all four to
  "a root placement on this board, or nothing". Every reader downstream is allowed to assume
  one hop, which is why `contentRoot` is cheap enough to call inside the edge draw loop.
- **Trail edges bind to the card and DRAW to the nearest placement** — the brief's
  decide-by-building call, made and logged. Following a link out of a facet records the walk
  once, from the card (`prov.from` still names the window you were actually reading, which is
  the honest thing to keep and costs nothing). At draw time each end picks the placement
  closest to the other end. **The consequence to feel, and the reason this is logged rather
  than hidden: moving a facet now changes which window a trail lands on, so the weave's shape
  answers to where the windows are.** The alternative — an edge per facet — multiplies the
  weave every time a card is opened twice, which is the opposite of what facets are for.
  Verified live: split at a section, click a link in the FACET, and the new card blooms beside
  the facet with the trail drawn from it, while the file records one edge from the card.
- **Removing a placement is not removing a card.** `removeNode` used to be unambiguous;
  with facets it has two arms. Removing the root while other placements survive PROMOTES the
  eldest survivor and re-points every reference to it — siblings' `facetOf`, edges, marks,
  stamps, and **thread membership, which is re-pointed rather than broken**, because the card
  is still on the board. Only when the LAST placement goes does the wave-2 §1 break record
  fire. Verified live: unpinning the root of a two-facet card kept both marks, the trail edge,
  the thread and the survivor's own `viewAnchor`, all through a reload.
- **A placement remembers where it is LOOKING, as a heading.** `viewAnchor` is heading TEXT,
  never a scroll offset — the same discipline marks obey and for the same reason. It is
  tracked on scroll (500 ms debounce, so only the heading you stopped at is written) and
  restored after every body re-render.
  - **Found in the browser, not reasoned about:** on a reload the article arrives from the
    network *after* the opening fit, and the card is still CULLED at that instant — a
    `display:none` body reports every rect as zero, so the scroll assignment silently read
    back 0 and every facet opened at the top. `park` now DETECTS the failure (a body with no
    layout) and queues it, draining on camera changes (culling and the tier band are both
    functions of the camera) plus a bounded RAF ladder. This class of bug — "the assignment
    silently reads back 0" — is the third time this codebase has hit it (see stage 4's
    culling fix and the completeness pass); it is worth knowing about.
- **The outline is read out of the body's own DOM**, not out of the source text: the body is
  what the reader is looking at, and it has already been sanitized, truncated and link-tagged
  by the provider. A second parse would be a second truth. **Alt-click on an outline entry
  splits a facet parked there** — the brief asked for the table-stakes outline critique and
  the facet mechanic in one gesture, and this is it: the list you are already using to find
  two sections is the thing that opens the second window on one of them.
- **Card resize** (ledger item 4) is a corner grip in `cards.ts`: two hairlines, counter-scaled
  so the target survives zoom, grid-free (a card is a sheet of paper, not a cell), floored by
  `sizeNode`'s existing 120×80. Per-placement, like position. Hidden below the full band,
  where there is nothing to size for.
- **Highlight readability** (ledger item 4) is three geometry changes in `styles.css` and NO
  change to any text: the mark's rule is 2px rather than a sub-pixel hairline; an anchor's own
  ghost rule steps aside under a mark so a marked link carries ONE line and not two; and a card
  receded by a GLYPH selection now takes its marks back with it, as a thread selection already
  did (before, an off-selection card's `--sig` underline stayed louder than its own prose — a
  contrast inversion, the quiet thing shouting). The passage itself stays pure ink on pure
  paper at full contrast, same size, same weight. No wash was ever on the table.
- **Composer elision** (ledger item 7) is two changes that have to go together. Quotes echo at
  PILL LENGTH with counts (`quotes.elide`, one constant shared by the status line, note titles
  and every handoff), because the strip is a strip and the full text is already kept in the
  board file and in `marks/<glyph>.md`. And a handoff is now ONE KEYED BLOCK
  (`host.sendBlock`), replace-or-collapse: `c` pressed twice marks the block `×2` instead of
  typing the thread twice, and handing off a thread that has since grown replaces the stale
  copy rather than sitting beside it. Verified live: three `c` presses on a card → one line and
  `×3`; a thread handed off, then marked, then handed off again → one block, "replaced the
  earlier copy".
- **P0 gap #2, closed at both ends.** The agent wrote `"title": ""` on its note cards; an empty
  string is not a missing key, so the codec's `??` never fired and the cards captioned
  themselves "untitled" at every altitude. `model.fallbackTitle` is now shared by the codec and
  by `makeNode`, and blank is treated as absent, so neither a file nor a creation site in this
  build can make an untitled card. (One subtlety the fixpoint check caught: the note fallback
  trims AFTER the 60-char cut, not before — a slice ending on a space would be written with it
  and read back trimmed, and the codec would oscillate for ever.)
- **`arrange.freeSpotNear`** — trail's private `placeNear` generalized rather than copied. A
  facet blooms beside its source by the same reading of "beside" a spawn does; only the
  "everything is full" answer differs (a spawn jitters and overlaps; a facet prefers the
  visible frame, then anywhere, then overlaps).
- **New `ChangeKind`, `"view"`.** A placement parking itself is not a `content` change —
  laundering it through one would re-assign every body's `innerHTML` on a scroll. Every
  decorating layer early-returns on it; `cards.ts` skips its reconcile entirely.
- **Verified.** `npm run build` clean; an off-DOM harness (**80 assertions**, all pass;
  esbuild's exit code confirmed 0 first, per stage 2's warning) over
  `Out/p0-agent-thread/board.canvas`, `Out/sample-board.canvas` and synthetic boards: both real
  boards still round-trip as a fixpoint and gain no `facetOf`/`viewAnchor` key; the P0 board's
  two blank-titled notes take their first line and nothing else about it changes; content
  fan-out, mark/stamp/edge/thread canonicalization, per-placement position/size/anchor,
  promotion-on-removal, and a hostile file carrying a dangling facet, a self-facet, a cycle, an
  edge naming a facet end and an edge that folds onto its own card. Then in-browser (dev server
  5199): the outline panel, alt-click splitting a parked facet, a highlight made in one facet
  drawn in both and stored once, a trail edge from a facet, the grip resizing one placement and
  not its twin, `c`×3 collapsing to `×3`, a re-handoff replacing, `s` splitting from the
  keyboard, and promotion on unpinning a root — all with zero console errors on a clean load.
  The pane's localStorage was cleared back to its fresh single-card seed afterwards and no
  `window.__loom`-style source hook was ever added.
- **Not done, deliberately:** any UI that says a card HAS facets other than the `facet n/m`
  marker on its kind line (no "all placements" list, no jump-to-sibling — the session should
  say whether it wants one); collision avoidance when a facet lands (it prefers the visible
  frame, then anywhere beside the source, then overlaps); a facet of a facet as a distinct
  concept (flattened, and the flattening is the design); an outline for `note` cards (a note is
  its own outline); scroll-position memory finer than a heading (there is no honest way to keep
  a pixel offset across a re-fetch); and edges drawn per-facet, which is the decision this
  stage was asked to make by building it.

**2026-08-06 — wave-2 fix pass (six defects from the parallel review).**

No new feature and no new key on the wire; six rules the earlier stages stated but did not
hold. Each is a rule, not a patch, so it is written down as one:

- **A broken thread is resolvable from EITHER piece of itself** (`model.resolveThreadForRun`).
  Tier 2 only matched a run that still *spanned* the hole — but a card deleted mid-thread takes
  both of its trail edges, so no walk can ever produce such a run. A→B→C→D→E losing C left two
  runs, `[A,B]` and `[D,E]`, and grabbing either printed *"thread unnamed — 2 cards"*: the exact
  wave-1 wording §1's hard constraint exists to eliminate. A run that is a **fragment** of a
  broken thread's membership (every card of the run, in order, inside the membership) now
  resolves to the name, selects all the survivors, and says it is broken. Only a thread with a
  recorded break may claim a fragment — an intact thread claiming a two-card piece of itself
  would annex every run passing through it. Tier bases are now `4000` contiguous · `800`
  scattered · `400` fragment.
- **A membership naming a card that is not on the board is a BREAK, recorded at load**
  (`model.load`). Edges and arrangements were already pruned against the node set; threads were
  not, so a file could load `nodeIds: ["a","ghost"]` — and `threads.ts` then flipped the
  selection between the model's answer and the alive-filtered one on *every* board change,
  redrawing the edge layer, the cards and the plate each time. Pruned now, and the loss goes
  into `broken.missing` with `at` left as the file had it (`null` if it never said — dating the
  break to the moment it was noticed would be a lie). The oscillation is *also* closed at the
  source: `threads.ts`'s change handler makes **one** comparison, against the membership already
  filtered to what exists.
- **The pull-taut undo follows the name across a rename of its scope** (`board.rekeyArrangement`,
  called from `threads.commitName`). `scopeKey` switches from `run:<ids>` to `thread:<id>` the
  instant a run is named, and the restore point was left under a key nothing could reach — the
  next pull then retired it (subset rule) and the pre-pull hand positions were gone for good.
  Naming re-keys forward, un-naming re-keys back *before* `removeThread`, and `removeThread`
  itself now drops any `thread:<id>` point it would otherwise strand in the saved file.
  First-writer-wins holds across a re-key: an existing point at the destination stays.
- **A promoted heir inherits the old root's restore spot** (`model.removeNode`). The heir branch
  re-pointed edges, marks, stamps and thread membership but *filtered* arrangement spots, so
  unpinning a root placement silently shrank a live restore point and "put back" moved one card
  fewer without saying so. It is re-pointed like everything else — unless the entry already
  names the heir, in which case the heir's own spot wins and the root's goes (a restore point
  never names a placement twice).
- **The link always wins over a glyph stamp** (`glyphs.onClick`). `wrapQuote` wraps per text
  node, so stamping a sentence containing an `<a>` puts a `.glyph-mark` *inside* the anchor;
  the glyph handler is capture-phase on `#viewport`, an ancestor of `#cards`, so its
  `stopPropagation()` ate the click before `trail.onClickCapture` ever saw it — a stamped
  passage killed the prototype's prime loop, and the two mark species diverged (fiber marks
  install no handler and stayed clickable). A click on a `.glyph-mark` inside an `<a>` is now
  passed through: the glyph is reachable from its head atom, the toolbar chip and any unlinked
  character of the stamp; the spawn is reachable from nowhere else.
- **Verified.** `npm run build` clean; an off-DOM harness over the six repros (each reproduced
  *before* the fix, then re-run after), plus `Out/p0-agent-thread/board.canvas` (34 nodes, 3
  threads) and `examples/sample-board.canvas` still loading with every membership live and
  `load(save(x)) === save(x)`. Also checked: an intact thread still refuses a fragment, tier-1
  containment still resolves the P0 anchor case, and a file carrying the brief's literal
  `powerset:prov` on a node, an edge and a thread round-trips as a fixpoint with one copy of
  its provenance.
