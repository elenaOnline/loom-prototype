// facets.ts — PLACEMENTS WITH A VIEWPORT (wave-2 §4, ideation §7.7).
//
// The owner's third critique: "multiple instances of the same card feel near-
// necessary — I want to compare two sections of one article side by side."
// Ideation §3.1 already said a card on the cloth is a PLACEMENT, not the thing
// itself; §7.7 refines it to placement = (card, position, viewport). This module
// is that refinement, made real, plus the outline affordance that turned out to
// be the natural way to ASK for one.
//
// Three verbs and one rule:
//
//   SPLIT    `s`, or `⊞` in the card head. A second window on the same card:
//            its own position, its own size, its own scroll. Not a copy — the
//            model stores it as `facetOf`, so content, marks, glyph stamps,
//            trail edges and thread membership all stay bound to the CARD.
//            Highlight in one, it draws in both, because there is only one
//            highlight (see `model.addMark` / `board.contentRoot`).
//   OUTLINE  `o`, or `≡`. The headings of the rendered article, read out of the
//            body's own DOM — no parsing, no second source of truth. Click one
//            and this window scrolls there; ALT-click and a new facet is born
//            already parked at that section. That is the table-stakes outline
//            critique and the facet mechanic answered by the same gesture, which
//            is what the brief asked for.
//   PARK     a placement remembers where it is looking, as the HEADING TEXT it
//            is parked at (`viewAnchor`) — never a pixel offset. Same discipline
//            marks obey (quotes.ts): provider HTML is re-fetched and re-laid-out
//            constantly, so an offset rots silently while a heading either
//            matches or does not. Tracked on scroll, restored on every re-render
//            and on reload.
//
// TRAIL EDGES BIND TO THE CARD, AND RENDER TO THE NEAREST PLACEMENT (the brief's
// decide-by-building call). The alternative — an edge per facet — multiplies the
// weave every time you open a second window, which is the opposite of what
// facets are for. edges.ts picks the nearest pair; the consequence to watch is
// that a trail's shape now changes when you MOVE a facet, which is logged in
// ARCHITECTURE.md and is the thing the session should react to.

import type { Camera, Insets } from "./camera";
import type { Board, Change, LoomNode } from "./model";
import { freeSpotNear } from "./arrange";
import { collapse } from "./quotes";

/** ms to settle a scroll before it becomes a persisted anchor */
const PARK_DEBOUNCE = 500;
/** ms during which our own scrolling must not be read back as the reader's */
const PARK_QUIET = 350;
/** more than this and the panel is a document, not an affordance */
const MAX_HEADINGS = 200;
/** world px of clear air between a card and the facet it splits off */
const FACET_GAP = 44;

export interface FacetLayer {
  /** a second window on this card; `anchor` parks it at a heading */
  split(nodeId: string, anchor?: string): LoomNode | null;
  /** show/hide the headings panel on one placement */
  toggleOutline(nodeId: string): void;
  destroy(): void;
}

export interface FacetLayerOptions {
  board: Board;
  camera: Camera;
  viewport: HTMLElement;
  /** the cards container — this module delegates its clicks off it */
  container: HTMLElement;
  /** the card layer owns card DOM; this module only decorates and reads it */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  /** which card the pointer last claimed, for the keyboard verbs */
  getSelected: () => string | null;
  select?: (nodeId: string) => void;
  /** a facet of a card that never loaded still has to fetch its body */
  onHydrate?: (nodeId: string) => void;
  getInsets?: () => Partial<Insets>;
  onStatus?: (text: string) => void;
}

interface Heading {
  level: number;
  text: string;
  el: HTMLElement;
}

export function createFacetLayer(options: FacetLayerOptions): FacetLayer {
  const { board, camera, viewport, container } = options;

  /** placement ids whose outline panel is open */
  const open = new Set<string>();
  /** placements that want to be parked but have had no layout to park in yet */
  const pending = new Set<string>();
  let parkTimer = 0;
  let parkTarget: string | null = null;
  let quietUntil = 0;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- reading the article's own headings ----------------------------------
  // Out of the body's DOM, not out of the source text: the body is what the
  // reader is looking at, and it has already been sanitized, truncated and
  // link-tagged by the provider. A second parse would be a second truth.

  function bodyOf(nodeId: string): HTMLElement | null {
    return options.getCardEl(nodeId)?.querySelector<HTMLElement>(".card-body") ?? null;
  }

  function headingsOf(body: HTMLElement): Heading[] {
    const out: Heading[] = [];
    for (const el of Array.from(body.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))) {
      const text = collapse(el.textContent ?? "");
      if (!text) continue;
      out.push({ level: Number(el.tagName.slice(1)) || 2, text, el });
      if (out.length >= MAX_HEADINGS) break;
    }
    return out;
  }

  /** the heading a stored anchor names, by text, first occurrence */
  function headingFor(body: HTMLElement, anchor: string): HTMLElement | null {
    const want = collapse(anchor);
    for (const h of headingsOf(body)) {
      if (h.text === want) return h.el;
    }
    return null;
  }

  // ---- parking (this placement's own scroll) --------------------------------

  function scrollTo(body: HTMLElement, target: HTMLElement): boolean {
    // A body with no LAYOUT cannot be scrolled: `display:none` (the tier layer's
    // culling, or any band below `full`) gives every rect a zero and the
    // assignment silently reads back 0. This is not theoretical — it is what
    // happens on every reload, because the cards are still culled when their
    // article arrives. So the failure is DETECTED and the park is re-queued
    // rather than being quietly lost.
    if (body.scrollHeight === 0 || body.offsetParent === null) return false;
    const delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    quietUntil = performance.now() + PARK_QUIET;
    body.scrollTop = Math.max(0, Math.round(body.scrollTop + delta - 4));
    return true;
  }

  /** the last heading at or above the top of the visible body */
  function anchorAt(body: HTMLElement): string | undefined {
    if (body.scrollTop <= 2) return undefined;
    const top = body.getBoundingClientRect().top;
    let found: string | undefined;
    for (const h of headingsOf(body)) {
      if (h.el.getBoundingClientRect().top - top > 6) break;
      found = h.text;
    }
    return found;
  }

  /**
   * Put a placement back where it was looking. Called after every re-render of a
   * body — hydration, a tier swap back into the full band, a reload — because a
   * facet that forgets its section on the first fetch was never a second
   * viewport, only a second card.
   */
  function park(nodeId: string): void {
    const node = board.node(nodeId);
    const body = bodyOf(nodeId);
    if (!node || !body || node.viewAnchor === undefined) {
      pending.delete(nodeId);
      return;
    }
    const target = headingFor(body, node.viewAnchor);
    // a heading the provider no longer serves scrolls NOWHERE rather than to a
    // guessed offset — the same honest failure a quote that no longer occurs
    // makes. A heading that IS there but cannot be reached yet is a different
    // thing entirely, and it waits its turn.
    if (!target) {
      // the body may simply not have been fetched yet; keep the intent alive
      if (body.scrollHeight === 0) pending.add(nodeId);
      else pending.delete(nodeId);
      return;
    }
    if (scrollTo(body, target)) pending.delete(nodeId);
    else pending.add(nodeId);
  }

  /**
   * The queue of placements that wanted to park and could not, with two ways to
   * be drained — and it needs both:
   *
   *   · a CAMERA change, because a body's layout is a function of the camera
   *     (culling and the tier band both are), so un-culling a card is the
   *     moment it becomes parkable.
   *   · a short RAF ladder, because on a reload the article arrives from the
   *     network AFTER the opening fit, and nothing moves the camera again. A
   *     bounded ladder (not a permanent watcher) because a body that is still
   *     display:none half a second later is genuinely off-screen, and the
   *     camera hook above will catch it when it is not.
   */
  function drain(): void {
    if (pending.size === 0) return;
    for (const id of Array.from(pending)) park(id);
  }

  let drainRaf = 0;
  let drainTries = 0;

  function scheduleDrain(): void {
    if (drainRaf !== 0 || pending.size === 0) return;
    drainRaf = requestAnimationFrame(() => {
      drainRaf = 0;
      drainTries += 1;
      drain();
      if (pending.size > 0 && drainTries < 30) scheduleDrain();
    });
  }

  function onScrollCapture(e: Event): void {
    if (!(e.target instanceof Element)) return;
    const body = e.target.closest<HTMLElement>(".card-body");
    const id = body?.closest<HTMLElement>(".card")?.dataset["nodeId"];
    if (!body || !id) return;
    if (performance.now() < quietUntil) return;
    parkTarget = id;
    if (parkTimer !== 0) window.clearTimeout(parkTimer);
    // debounced hard: a scroll is a continuous gesture and a persisted anchor is
    // a discrete fact, so only the heading you STOPPED at is written
    parkTimer = window.setTimeout(() => {
      parkTimer = 0;
      const target = parkTarget;
      parkTarget = null;
      if (!target) return;
      const live = bodyOf(target);
      if (!live) return;
      board.setViewAnchor(target, anchorAt(live));
    }, PARK_DEBOUNCE);
  }

  // ---- the outline panel ---------------------------------------------------

  function paintOutline(nodeId: string): void {
    const el = options.getCardEl(nodeId);
    if (!el) return;
    const body = el.querySelector<HTMLElement>(".card-body");
    const existing = el.querySelector<HTMLElement>(":scope > .card-outline");
    const headings = body ? headingsOf(body) : [];

    // the affordance exists only where there is something to outline
    if (headings.length === 0) el.removeAttribute("data-headings");
    else el.setAttribute("data-headings", String(headings.length));

    if (!open.has(nodeId) || headings.length === 0) {
      existing?.remove();
      el.removeAttribute("data-outline");
      return;
    }
    el.setAttribute("data-outline", "");
    const panel = existing ?? document.createElement("nav");
    if (!existing) {
      panel.className = "card-outline";
      el.insertBefore(panel, body);
    }
    const frag = document.createDocumentFragment();
    const parked = board.node(nodeId)?.viewAnchor;
    for (const h of headings) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "card-outline-entry";
      b.textContent = h.text;
      b.dataset["anchor"] = h.text;
      b.style.setProperty("--lvl", String(Math.max(0, Math.min(4, h.level - 1))));
      if (parked !== undefined && collapse(parked) === h.text) b.setAttribute("data-parked", "");
      b.title = "click to scroll here · alt-click to split a facet parked here";
      frag.appendChild(b);
    }
    panel.replaceChildren(frag);
  }

  function toggleOutline(nodeId: string): void {
    if (!board.node(nodeId)) return;
    if (open.has(nodeId)) {
      open.delete(nodeId);
      paintOutline(nodeId);
      return;
    }
    open.add(nodeId);
    paintOutline(nodeId);
    const el = options.getCardEl(nodeId);
    if (!el?.hasAttribute("data-headings")) {
      open.delete(nodeId);
      status("no headings in this card — nothing to outline");
    }
  }

  // ---- split ---------------------------------------------------------------

  /** the frame the reader is actually looking at, in world coordinates */
  function visibleWorld(): { minX: number; minY: number; maxX: number; maxY: number } {
    const r = viewport.getBoundingClientRect();
    const partial = options.getInsets?.() ?? {};
    const a = camera.screenToWorld(8, (partial.top ?? 0) + 8);
    const b = camera.screenToWorld(r.width - 8, r.height - (partial.bottom ?? 0) - 8);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  /**
   * A facet is for COMPARING, so it wants to land beside its source and inside
   * the frame you are reading in. Failing that it takes the first free air
   * anywhere beside the source; failing that it overlaps, because a split that
   * silently does not happen is worse than one you have to drag apart.
   */
  function facetSpot(src: LoomNode): { x: number; y: number } {
    const nodes = board.nodes();
    const opts = { gap: FACET_GAP, stagger: 24, left: true };
    const framed = freeSpotNear(nodes, src, src.width, src.height, {
      ...opts,
      within: visibleWorld(),
    });
    if (framed) return framed;
    const anywhere = freeSpotNear(nodes, src, src.width, src.height, opts);
    if (anywhere) return anywhere;
    return { x: Math.round(src.x + src.width + FACET_GAP), y: Math.round(src.y + 24) };
  }

  function split(nodeId: string, anchor?: string): LoomNode | null {
    const src = board.node(nodeId);
    if (!src) {
      status("select a card first — s splits a second window on it");
      return null;
    }
    const spot = facetSpot(src);
    const node = board.addNode({
      kind: src.kind,
      ref: src.ref,
      title: src.title,
      x: spot.x,
      y: spot.y,
      width: src.width,
      height: src.height,
      // the model flattens this to the ROOT placement, so splitting a facet
      // gives a third window on one card, never a chain
      facetOf: board.contentRoot(nodeId),
      ...(anchor === undefined ? {} : { viewAnchor: anchor }),
      ...(src.text === undefined ? {} : { text: src.text }),
      ...(src.glyphFile === undefined ? {} : { glyphFile: src.glyphFile }),
      ...(src.html === undefined ? {} : { html: src.html }),
      status: src.status,
      // a facet is PLACED, deliberately, from the window you were reading —
      // nothing was followed, so it is not a wander
      prov: { by: "human", how: "place", from: nodeId, src: null },
    });
    if (!node.html && node.kind !== "note") options.onHydrate?.(node.id);
    paintAll();
    if (anchor !== undefined) park(node.id);
    options.select?.(node.id);
    const n = board.placementsOf(node.id).length;
    status(
      anchor === undefined
        ? `facet ${n} of "${src.title}" — same card, its own place and its own scroll`
        : `facet ${n} of "${src.title}" — parked at "${anchor}"`,
    );
    return node;
  }

  // ---- painting the family -------------------------------------------------

  /**
   * `data-facet="2/3"` on every placement of a card that has more than one. The
   * kind line reads it through CSS (`content: attr(...)`) rather than through a
   * text node, which keeps it out of the quote index both mark species use.
   */
  function paintAll(): void {
    const family = new Map<string, string[]>();
    for (const n of board.nodes()) {
      const root = board.contentRoot(n.id);
      const list = family.get(root);
      if (list) list.push(n.id);
      else family.set(root, [n.id]);
    }
    for (const ids of family.values()) {
      ids.forEach((id, i) => {
        const el = options.getCardEl(id);
        if (!el) return;
        if (ids.length < 2) {
          el.removeAttribute("data-facet");
          el.style.removeProperty("--facet");
          return;
        }
        const label = `${i + 1}/${ids.length}`;
        el.setAttribute("data-facet", label);
        // the marker is drawn by CSS off a custom PROPERTY, not off the
        // attribute: `attr()` can only read the pseudo-element's own element,
        // and the attribute has to sit on the card (the selector needs it) while
        // the marker is written on the kind line inside it. Custom properties
        // inherit; attributes do not. Same trick the glyph atom uses.
        el.style.setProperty("--facet", JSON.stringify(label));
      });
    }
    for (const id of Array.from(open)) {
      if (!board.node(id)) open.delete(id);
    }
  }

  // ---- input ---------------------------------------------------------------

  function nodeIdFor(target: Element): string | null {
    return target.closest<HTMLElement>(".card")?.dataset["nodeId"] ?? null;
  }

  function onClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;

    const entry = e.target.closest<HTMLElement>(".card-outline-entry");
    if (entry) {
      e.preventDefault();
      e.stopPropagation();
      const id = nodeIdFor(entry);
      const anchor = entry.dataset["anchor"];
      if (!id || anchor === undefined) return;
      // ALT-CLICK IS THE WHOLE POINT: the same list that navigates this window
      // opens a second one, so "compare two sections" is one gesture from the
      // affordance you were already using to find them.
      if (e.altKey) {
        split(id, anchor);
        return;
      }
      const body = bodyOf(id);
      const target = body ? headingFor(body, anchor) : null;
      if (!body || !target) {
        status(`"${anchor}" is no longer in this card`);
        return;
      }
      scrollTo(body, target);
      board.setViewAnchor(id, anchor);
      paintOutline(id);
      return;
    }

    const facetBtn = e.target.closest(".card-facet-btn");
    if (facetBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = nodeIdFor(facetBtn);
      if (id) split(id);
      return;
    }

    const outlineBtn = e.target.closest(".card-outline-btn");
    if (outlineBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = nodeIdFor(outlineBtn);
      if (id) toggleOutline(id);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    if (e.key !== "s" && e.key !== "S" && e.key !== "o" && e.key !== "O") return;
    const id = options.getSelected();
    if (!id) {
      status(
        e.key === "s" || e.key === "S"
          ? "click a card first — s splits a second window on it"
          : "click a card first — o lists its headings",
      );
      return;
    }
    e.preventDefault();
    if (e.key === "s" || e.key === "S") split(id);
    else toggleOutline(id);
  }

  container.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown);
  // card bodies do not bubble their scroll, so this listens in the capture phase
  window.addEventListener("scroll", onScrollCapture, true);

  const unsubscribe = board.onChange((change: Change) => {
    // a parked anchor moving is this module's own writing coming back around
    if (change.kind === "view") {
      for (const id of change.nodeIds ?? []) paintOutline(id);
      return;
    }
    if (
      change.kind === "position" ||
      change.kind === "meta" ||
      change.kind === "threads" ||
      change.kind === "marks" ||
      change.kind === "glyphs" ||
      // sealing a card changes nothing about its placements, and a bookmark
      // involves no card — re-parking the whole cloth for either is pure churn
      change.kind === "seals" ||
      change.kind === "bookmarks" ||
      change.kind === "arrange"
    ) {
      return;
    }
    if (change.kind === "reset") open.clear();
    paintAll();
    // the card layer subscribed first, so the bodies this reads already exist
    const ids = change.nodeIds ?? null;
    const targets = ids && ids.length > 0 ? ids : board.nodes().map((n) => n.id);
    for (const id of targets) {
      if (!board.node(id)) continue;
      park(id);
      paintOutline(id);
    }
    // a body that arrived while its card was culled gets its chance next frame
    drainTries = 0;
    scheduleDrain();
  });

  // a camera move is when a culled body comes back and a tier band changes:
  // exactly the two ways a placement that could not be parked becomes parkable
  const unwatchCamera = camera.onChange(() => {
    drainTries = 0;
    drain();
  });

  paintAll();
  for (const n of board.nodes()) park(n.id);
  scheduleDrain();

  return {
    split,
    toggleOutline,
    destroy() {
      if (parkTimer !== 0) window.clearTimeout(parkTimer);
      if (drainRaf !== 0) cancelAnimationFrame(drainRaf);
      unwatchCamera();
      unsubscribe();
      container.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollCapture, true);
      for (const id of open) {
        options.getCardEl(id)?.querySelector(".card-outline")?.remove();
        options.getCardEl(id)?.removeAttribute("data-outline");
      }
      open.clear();
    },
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
