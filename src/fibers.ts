// fibers.ts — MARKS ARE FILES (brief §5, ideation §6.4: the fiber altitude).
//
// A fiber is the atomic mark: the sentence you kept, the note you left on it.
// This module is the whole gesture, and it is deliberately one gesture:
//
//   SELECT TEXT in a card body at reading range (the FULL tier only — at title
//   or glyph range there is no prose to select) → a small hairline pill rises
//   near the selection with exactly three verbs:
//
//     HIGHLIGHT   persist {nodeId, quote, kind:"highlight"} and draw it: the
//                 first occurrence of the quote gets a --sig hairline under it.
//                 Re-applied after EVERY body render — hydration, reload, tier
//                 swap, un-cull — because a mark that disappears when the card
//                 redraws is not a mark, it is a decoration.
//     NOTE        a small monospace note card blooms beside the source, tethered
//                 by a --ghost hairline, focused for immediate typing. Persists
//                 as a node PLUS a mark {kind:"note", noteNodeId} on the source,
//                 so the note rides along in a thread handoff.
//     → COMPOSER  the quote and its source ref, typed into the strip as a
//                 blockquote line. No mark: this one is a send, not a keep.
//     MARK ▸      (wave-2 §2) opens the five-glyph palette in the pill itself.
//                 One more click stamps the passage into that glyph's
//                 collection — no dialog, no naming step, no edge to draw. The
//                 expander is STICKY for the session, so the second stamp
//                 onward is a SINGLE click: the brief's bar is highlight speed,
//                 and a two-click gesture would not clear it. Clicking a glyph
//                 the passage already carries takes the stamp back off.
//                 (This module only calls board.addGlyph/removeGlyph; glyphs.ts
//                 draws the result, holds the selection, and writes the file.)
//
// Three rules the feel depends on:
//   · The pill NEVER fights the browser's own selection. It does not appear
//     mid-drag (only once the pointer is up), it does not steal focus, and its
//     pointerdown is prevented so clicking a verb cannot collapse the range it
//     is about to act on.
//   · It dismisses the moment the world moves under it — click-away, scroll of
//     a card body, any camera pan or zoom. A pill anchored to stale coordinates
//     is worse than no pill.
//   · Marks anchor by QUOTED TEXT (first occurrence), never by offsets — see
//     ARCHITECTURE.md. Prototype-grade and honest: it survives re-render and
//     re-fetch, and it fails visibly (the mark simply does not draw) rather than
//     silently underlining the wrong words.

import type { Camera, Insets } from "./camera";
import type { Board, Change, GlyphStamp, LoomNode, Mark } from "./model";
import { GLYPH_PALETTE, glyphChar } from "./model";
import type { Host } from "./host";
import { refOf } from "./codec";
import { collapse, unwrapAll, wrapQuote } from "./quotes";

/** world px: a note is a small thing beside a big one */
const NOTE_W = 200;
const NOTE_H = 150;
/** world px of clear air between a source card and the note it holds */
const NOTE_GAP = 40;
/** screen px between the selection and the pill */
const PILL_LIFT = 8;
/** anything shorter is a stray click-drag, not a quote */
const MIN_QUOTE = 2;
/** the status line quotes back what you kept; it is a strip, not a page */
const ECHO = 48;

export interface FiberLayer {
  /** re-draw the marks on one card (or all of them) */
  apply(nodeId?: string): void;
  destroy(): void;
}

export interface FiberLayerOptions {
  board: Board;
  camera: Camera;
  viewport: HTMLElement;
  host: Host;
  /** the card layer owns card DOM; this module only decorates its bodies */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  getInsets?: () => Partial<Insets>;
  onStatus?: (text: string) => void;
}

interface Grab {
  nodeId: string;
  body: HTMLElement;
  quote: string;
  /** the mark this selection is already inside, if any → the verb is "unmark" */
  existing: Mark | null;
  /** the glyph stamps this selection is already inside — those verbs un-stamp */
  stamps: GlyphStamp[];
  rect: DOMRect;
}

export function createFiberLayer(options: FiberLayerOptions): FiberLayer {
  const { board, camera, viewport, host } = options;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  /** what the pill is currently about; declared here because the palette's
   *  first paint (below) re-positions the pill and must be able to read it */
  let grab: Grab | null = null;

  // ---- the pill -----------------------------------------------------------

  const pill = document.createElement("div");
  pill.className = "fiber-pill";
  pill.hidden = true;

  const markButton = verb("highlight", () => onHighlight());
  const noteButton = verb("note", () => onNote());
  const sendButton = verb("→ composer", () => onSend());

  // the fourth action: the meaning-mark palette (wave-2 §2). The expander stays
  // open once opened — a palette you have to re-open is a dialog by another name
  const openButton = verb("mark ▸", () => setPalette(!paletteOpen));
  openButton.classList.add("fiber-open");
  const palette = document.createElement("span");
  palette.className = "fiber-palette";
  const glyphButtons = new Map<string, HTMLButtonElement>();
  for (const glyph of GLYPH_PALETTE) {
    const b = verb(glyphChar(glyph.name), () => onStamp(glyph.name));
    b.classList.add("fiber-glyph");
    b.title = `stamp ${glyph.name} — every passage stamped with it becomes one collection`;
    glyphButtons.set(glyph.name, b);
    palette.appendChild(b);
  }
  let paletteOpen = false;

  function setPalette(open: boolean): void {
    paletteOpen = open;
    palette.hidden = !open;
    openButton.textContent = open ? "mark ▾" : "mark ▸";
    if (grab) position(grab.rect); // the pill just changed width
  }

  pill.append(markButton, noteButton, sendButton, openButton, palette);
  setPalette(false);
  viewport.appendChild(pill);

  function verb(label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    // the pill must not take the selection away from the thing it acts on:
    // preventDefault on pointerdown keeps the range alive and the caret put,
    // and stopPropagation keeps the camera from reading this as paper-drag
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    return b;
  }

  pill.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // ---- reading the selection ----------------------------------------------

  function bodyOf(node: Node | null): HTMLElement | null {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return el?.closest<HTMLElement>(".card-body") ?? null;
  }

  /**
   * The selection, if it is a quote from an article at reading range. Every
   * "no" here is deliberate: outside a card body, across two cards, inside a
   * note you are typing, or on a card drawn as a title/glyph — no pill.
   */
  function read(): Grab | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const body = bodyOf(range.commonAncestorContainer);
    if (!body) return null;
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    if (body.isContentEditable) return null; // a note IS a fiber; it is not marked
    const card = body.closest<HTMLElement>(".card");
    const nodeId = card?.dataset["nodeId"];
    if (!card || !nodeId) return null;
    if (!card.classList.contains("tier-full")) return null;
    // a glyph file card is a RENDERING of the board; marking it would mark a
    // quote that the next regeneration rewrites out from under the mark
    if (board.node(nodeId)?.glyphFile !== undefined) return null;
    const quote = collapse(range.toString());
    if (quote.length < MIN_QUOTE) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      nodeId,
      body,
      quote,
      existing: markAround(range, nodeId),
      stamps: stampsAround(range, nodeId),
      rect,
    };
  }

  /** a selection wholly inside an existing mark offers to take it back off */
  function markAround(range: Range, nodeId: string): Mark | null {
    const el =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const span = el?.closest<HTMLElement>(".fiber-mark");
    const id = span?.dataset["markId"];
    if (!id) return null;
    return board.marksOf(nodeId).find((m) => m.id === id) ?? null;
  }

  /**
   * Every glyph stamp this selection sits inside. Plural on purpose: one passage
   * can carry two glyphs (the spans nest), and each of them must be able to come
   * back off through its own button in the palette.
   */
  function stampsAround(range: Range, nodeId: string): GlyphStamp[] {
    let el: Element | null =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const ids = new Set<string>();
    while (el) {
      const span = el.closest<HTMLElement>(".glyph-mark");
      if (!span) break;
      const id = span.dataset["stampId"];
      if (id) ids.add(id);
      el = span.parentElement;
    }
    if (ids.size === 0) return [];
    return board.glyphsOf(nodeId).filter((s) => ids.has(s.id));
  }

  // ---- show / dismiss ------------------------------------------------------

  function show(next: Grab): void {
    grab = next;
    markButton.textContent = next.existing
      ? next.existing.kind === "note"
        ? "drop note"
        : "unmark"
      : "highlight";
    noteButton.hidden = next.existing?.kind === "note";
    // a glyph this passage already carries inverts: pressing it takes it off
    for (const [name, b] of glyphButtons) {
      const on = next.stamps.some((s) => s.glyph === name);
      if (on) b.setAttribute("data-active", "");
      else b.removeAttribute("data-active");
    }
    pill.hidden = false;
    position(next.rect);
  }

  function position(rect: DOMRect): void {
    const vp = viewport.getBoundingClientRect();
    const partial = options.getInsets?.() ?? {};
    const top = partial.top ?? 0;
    const bottom = partial.bottom ?? 0;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;

    let x = rect.left + rect.width / 2 - vp.left - w / 2;
    x = Math.max(8, Math.min(vp.width - w - 8, x));

    let y = rect.top - vp.top - h - PILL_LIFT;
    // no room above the quote → sit under it rather than over the toolbar
    if (y < top + 4) y = rect.bottom - vp.top + PILL_LIFT;
    y = Math.max(top + 4, Math.min(vp.height - bottom - h - 4, y));

    pill.style.left = `${Math.round(x)}px`;
    pill.style.top = `${Math.round(y)}px`;
  }

  function dismiss(dropSelection = false): void {
    grab = null;
    pill.hidden = true;
    if (dropSelection) window.getSelection()?.removeAllRanges();
  }

  // The pill waits for the pointer to come up: raising it mid-drag would put a
  // click target under the very cursor that is still choosing the words.
  let pointerIsDown = false;
  let settle = 0;

  function maybeShow(): void {
    if (pointerIsDown) return;
    if (settle !== 0) window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      settle = 0;
      const next = read();
      if (next) show(next);
      else dismiss();
    }, 0);
  }

  function onSelectionChange(): void {
    if (pointerIsDown) return;
    maybeShow();
  }

  /** the body holding the live selection, if the selection is a range in one */
  function selectionBody(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    return bodyOf(sel.getRangeAt(0).commonAncestorContainer);
  }

  function onPointerDownAnywhere(e: PointerEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".fiber-pill")) return;
    pointerIsDown = true;
    // A pointer that comes down away from the words themselves IS "never mind",
    // and on paper it is the only gesture a canvas user reaches for. It must be
    // a REAL dismissal, so the range is dropped here rather than left to the
    // browser: the camera preventDefaults a pointerdown on paper to start a pan,
    // which suppresses the default selection-collapse, so the Range would
    // survive and pointerup would raise the same pill again. Landing in another
    // card body still drops it — that click is the start of a new selection, and
    // the pill for it rises on pointerup as usual.
    const body = target?.closest<HTMLElement>(".card-body") ?? null;
    const live = selectionBody();
    dismiss(live !== null && body !== live);
  }

  function onPointerUpAnywhere(): void {
    if (!pointerIsDown) return;
    pointerIsDown = false;
    maybeShow();
  }

  function onScrollCapture(e: Event): void {
    if (pill.hidden) return;
    if (e.target instanceof Element && e.target.closest(".fiber-pill")) return;
    dismiss();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && !pill.hidden) dismiss();
  }

  // ---- the three verbs -----------------------------------------------------

  function onHighlight(): void {
    const g = grab;
    if (!g) return;
    if (g.existing) {
      const kind = g.existing.kind;
      const note = g.existing.noteNodeId;
      board.removeMark(g.existing.id);
      if (note) board.removeNode(note);
      dismiss(true);
      apply(g.nodeId);
      status(kind === "note" ? "note dropped" : "unmarked");
      return;
    }
    board.addMark({ nodeId: g.nodeId, quote: g.quote, kind: "highlight" });
    dismiss(true);
    apply(g.nodeId);
    status(`highlighted "${echo(g.quote)}"`);
  }

  function onNote(): void {
    const g = grab;
    if (!g) return;
    const source = board.node(g.nodeId);
    if (!source) return;
    const spot = noteSpot(source, g.rect);
    dismiss(true);

    // a note is born of a MARK on its source — provenance says so on both the
    // card and the hairline that holds it there
    const prov = { by: "human", how: "mark", from: source.id, src: null } as const;
    const note = board.addNode({
      kind: "note",
      ref: "",
      title: echo(g.quote),
      x: spot.x,
      y: spot.y,
      width: NOTE_W,
      height: NOTE_H,
      text: "",
      status: "ready",
      prov,
    });
    board.addEdge(source.id, note.id, "tether", { prov });
    board.addMark({
      nodeId: source.id,
      quote: g.quote,
      kind: "note",
      noteNodeId: note.id,
    });
    apply(source.id);

    // the card layer built this element synchronously on the graph change, so
    // the note is ready to be typed into the moment it appears
    const body = options.getCardEl(note.id)?.querySelector<HTMLElement>(".card-body");
    body?.focus({ preventScroll: true });
    status(`note on "${echo(g.quote)}" — type it`);
  }

  /**
   * The stamp. One click, no dialog, no naming step — the passage joins that
   * glyph's collection and the glyph's file rewrites itself. Pressing a glyph
   * the passage already carries takes it back off, so the gesture is its own
   * undo and nothing needs a second control.
   *
   * The selection is dropped afterwards for the same reason `highlight` drops
   * it: the body is about to be re-wrapped with the new mark, which would
   * invalidate the Range anyway. The margin atom appearing IS the receipt.
   */
  function onStamp(glyph: string): void {
    const g = grab;
    if (!g) return;
    const already = g.stamps.find((s) => s.glyph === glyph);
    if (already) {
      board.removeGlyph(already.id);
      dismiss(true);
      status(`${glyphChar(glyph)} ${glyph} un-stamped`);
      return;
    }
    board.addGlyph({ glyph, nodeId: g.nodeId, quote: g.quote });
    dismiss(true);
    const n = board.stampsOf(glyph).length;
    status(`${glyphChar(glyph)} ${glyph} — ${n} passage${n === 1 ? "" : "s"} · marks/${glyph}.md`);
  }

  function onSend(): void {
    const g = grab;
    if (!g) return;
    const node = board.node(g.nodeId);
    if (!node) return;
    host.sendToComposer(`> ${g.quote}`);
    host.sendToComposer(`    from ${refOf(node)}`);
    dismiss(true);
    status(`sent to composer: "${echo(g.quote)}"`);
  }

  /**
   * Beside the source, level with the words it is about — and ON SCREEN, always.
   * A note you cannot see is not a note: it cannot be typed into (an off-screen
   * body is culled, and a `display:none` element cannot take focus) and it reads
   * as the gesture having failed. So the search for clear air happens INSIDE the
   * visible frame, and when the frame is full the note overlaps rather than
   * exiling itself down the cloth.
   */
  function noteSpot(source: LoomNode, rect: DOMRect): { x: number; y: number } {
    const view = visibleWorld();
    const anchor = camera.screenToWorld(rect.right, rect.top);

    const right = source.x + source.width + NOTE_GAP;
    const left = source.x - NOTE_GAP - NOTE_W;
    const columns = [right, left, right + NOTE_W + NOTE_GAP]
      .map((x) => clamp(x, view.minX, view.maxX - NOTE_W))
      .map((x) => Math.round(x));

    const home = clamp(anchor.y - 12, view.minY, view.maxY - NOTE_H);
    const step = NOTE_H + 16;

    for (const x of columns) {
      // 0, +1, -1, +2, -2 … so a note lands level with its quote when it can
      for (let i = 0; i < 10; i += 1) {
        const rung = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
        const y = Math.round(home + rung * step);
        if (y < view.minY || y + NOTE_H > view.maxY) continue;
        if (!collides(x, y)) return { x, y };
      }
    }
    return { x: columns[0] ?? Math.round(right), y: Math.round(home) };
  }

  /** the frame the reader is actually looking at, in world coordinates */
  function visibleWorld(): { minX: number; minY: number; maxX: number; maxY: number } {
    const r = viewport.getBoundingClientRect();
    const partial = options.getInsets?.() ?? {};
    const a = camera.screenToWorld(8, (partial.top ?? 0) + 8);
    const b = camera.screenToWorld(r.width - 8, r.height - (partial.bottom ?? 0) - 8);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  function collides(x: number, y: number): boolean {
    const pad = 12;
    for (const n of board.nodes()) {
      if (
        x < n.x + n.width + pad &&
        x + NOTE_W + pad > n.x &&
        y < n.y + n.height + pad &&
        y + NOTE_H + pad > n.y
      ) {
        return true;
      }
    }
    return false;
  }

  function clamp(v: number, lo: number, hi: number): number {
    return hi < lo ? lo : Math.min(hi, Math.max(lo, v));
  }

  // ---- drawing the marks ---------------------------------------------------
  // The body's HTML belongs to the provider and is re-assigned wholesale on
  // every content change, so marks are re-applied rather than kept: unwrap what
  // is there, then wrap the first occurrence of each quote again.

  function apply(nodeId?: string): void {
    if (nodeId === undefined) {
      for (const n of board.nodes()) apply(n.id);
      return;
    }
    const el = options.getCardEl(nodeId);
    const body = el?.querySelector<HTMLElement>(".card-body");
    if (!body || body.isContentEditable) return;
    unwrapAll(body, ".fiber-mark");
    const marks = board.marksOf(nodeId);
    if (marks.length === 0) return;
    for (const mark of marks) draw(body, mark);
  }

  /**
   * The wrapping itself lives in quotes.ts now — wave-2 §2 added a second
   * species of mark that anchors exactly the same way, and two copies of a
   * quote-matcher would have drifted the first time one was fixed.
   */
  function draw(body: HTMLElement, mark: Mark): void {
    wrapQuote(body, mark.quote, () => {
      const span = document.createElement("span");
      span.className = "fiber-mark";
      span.dataset["markId"] = mark.id;
      span.dataset["kind"] = mark.kind;
      return span;
    });
  }

  // ---- wiring --------------------------------------------------------------

  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("pointerdown", onPointerDownAnywhere, true);
  window.addEventListener("pointerup", onPointerUpAnywhere, true);
  window.addEventListener("pointercancel", onPointerUpAnywhere, true);
  window.addEventListener("scroll", onScrollCapture, true);
  window.addEventListener("keydown", onKeyDown);

  // any camera move invalidates the anchor; the pill goes rather than drifts
  const unwatchCamera = camera.onChange(() => {
    if (!pill.hidden) dismiss();
  });

  const unsubscribe = board.onChange((change: Change) => {
    if (
      change.kind === "position" ||
      change.kind === "meta" ||
      change.kind === "threads" ||
      // a glyph stamp never removes a fiber span (glyphs.ts unwraps only its
      // own class), so re-wrapping every body on a stamp would be pure churn
      change.kind === "glyphs"
    ) {
      return;
    }
    // the card layer subscribed first, so its DOM for this change already exists
    if (change.kind === "reset") dismiss();
    // a graph change can invalidate a card OTHER than the one it names: unpinning
    // a note takes its mark with it, and the source card is still drawing it. So
    // the whole cloth is re-checked — for an unmarked card that is one query.
    const ids = change.kind === "content" || change.kind === "marks" ? change.nodeIds : null;
    if (!ids || ids.length === 0) {
      apply();
      return;
    }
    for (const id of ids) apply(id);
  });

  apply();

  return {
    apply,
    destroy() {
      if (settle !== 0) window.clearTimeout(settle);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerdown", onPointerDownAnywhere, true);
      window.removeEventListener("pointerup", onPointerUpAnywhere, true);
      window.removeEventListener("pointercancel", onPointerUpAnywhere, true);
      window.removeEventListener("scroll", onScrollCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      unwatchCamera();
      unsubscribe();
      for (const n of board.nodes()) {
        const body = options.getCardEl(n.id)?.querySelector<HTMLElement>(".card-body");
        if (body) unwrapAll(body, ".fiber-mark");
      }
      pill.remove();
    },
  };
}

function echo(quote: string): string {
  return quote.length > ECHO ? `${quote.slice(0, ECHO - 1)}…` : quote;
}
