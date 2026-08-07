// cards.ts — model → DOM. Real elements, real text (fibers will need selection).
//
// A card is: a title bar (serif title + mono kind/path line + up to three
// controls) and a body of sanitized provider HTML. The title bar is the drag
// handle, so dragging never fights text selection in the body. Alt-drag anywhere
// on a card pulls a manual edge to another card, and a corner grip resizes it
// (grid-free, `sizeNode`'s own floor is the only limit).
//
// The unpin control removes the PLACEMENT, not the thing: the card leaves the
// cloth, the article still exists and can be re-spawned — and since wave-2 §4 a
// card can have SEVERAL placements, so unpinning one facet leaves the others,
// their marks and their edges exactly where they were (`model.removeNode`).
//
// The two other head controls (`≡` outline, `⊞` split a facet) are BUILT here
// because they are card chrome, and HANDLED in facets.ts by delegation — this
// module knows what a card looks like, not what an outline is.
//
// One card kind is written rather than fetched: a `note` body is contenteditable
// and types straight through to the model, so a note fibers.ts just created can
// be typed into the instant it appears.

import type { Camera } from "./camera";
import type { Board, Change, LoomNode } from "./model";
import type { EdgeLayer } from "./edges";
import type { ContentSource } from "./providers/source";

export interface CardLayer {
  selected(): string | null;
  select(id: string | null): void;
  /** brief inversion of a card's title bar — "your click landed *here*" */
  ping(id: string): void;
  element(id: string): HTMLElement | undefined;
  /**
   * EVERY placement of the card this id belongs to (wave-2 §4). Decorating
   * layers (fibers, glyphs) draw per CARD, so they ask for all its windows —
   * that is the whole of "highlight in one facet, see it in both" on the DOM
   * side, exactly as `board.marksOf` is on the model side.
   */
  elements(id: string): HTMLElement[];
  destroy(): void;
}

export interface CardLayerOptions {
  container: HTMLElement;
  viewport: HTMLElement;
  board: Board;
  camera: Camera;
  edges: EdgeLayer;
  getSource: () => ContentSource | null;
}

const PING_MS = 750;

export function createCardLayer(options: CardLayerOptions): CardLayer {
  const { container, viewport, board, camera, edges } = options;
  const els = new Map<string, HTMLElement>();
  const pings = new Map<string, number>();
  let selectedId: string | null = null;
  let topZ = 1;

  // ---- reconcile ----------------------------------------------------------

  function sync(change?: Change): void {
    const seen = new Set<string>();
    for (const node of board.nodes()) {
      seen.add(node.id);
      let el = els.get(node.id);
      if (!el) {
        el = build(node);
        els.set(node.id, el);
        container.appendChild(el);
        geometry(el, node);
        content(el, node);
        continue;
      }
      // narrow the work: an edge appearing must not re-render every body (it
      // would eat scroll position and text selection on 40 cards at once)
      const kind = change?.kind ?? "reset";
      // a placement's own scroll anchor moved; nothing about the card did
      if (kind === "view") continue;
      if (kind === "graph") continue;
      const ids = change?.nodeIds;
      if (ids && !ids.includes(node.id)) continue;
      if (kind === "position" || kind === "reset") geometry(el, node);
      if (kind === "content" || kind === "reset") content(el, node);
    }
    for (const [id, el] of Array.from(els)) {
      if (seen.has(id)) continue;
      el.remove();
      els.delete(id);
      if (selectedId === id) selectedId = null;
    }
  }

  function build(node: LoomNode): HTMLElement {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset["nodeId"] = node.id;
    el.dataset["kind"] = node.kind;
    if (node.glyphFile !== undefined) el.dataset["glyphFile"] = node.glyphFile;
    el.style.zIndex = String(++topZ);

    const head = document.createElement("header");
    head.className = "card-head";

    const stack = document.createElement("div");
    stack.className = "card-head-stack";
    const title = document.createElement("h2");
    title.className = "card-title";
    const kind = document.createElement("span");
    kind.className = "card-kind";
    stack.append(title, kind);

    const controls = document.createElement("span");
    controls.className = "card-controls";

    // the outline is a reading affordance, so it exists only where there is an
    // article to have headings — a note is its own outline
    if (node.kind !== "note") {
      const outline = document.createElement("button");
      outline.className = "card-outline-btn";
      outline.type = "button";
      outline.title = "o — headings · click one to scroll there, alt-click to split a facet at it";
      outline.textContent = "≡";
      controls.appendChild(outline);
    }

    const facet = document.createElement("button");
    facet.className = "card-facet-btn";
    facet.type = "button";
    facet.title = "s — split a facet: a second window on this same card";
    facet.textContent = "⊞";
    controls.appendChild(facet);

    const close = document.createElement("button");
    close.className = "card-unpin";
    close.type = "button";
    close.title = "unpin this placement (the article stays out there)";
    close.textContent = "×";
    controls.appendChild(close);

    head.append(stack, controls);

    const body = document.createElement("div");
    body.className = "card-body";
    // a note is written, not fetched: its body IS the editor (fibers, stage 5).
    // A GLYPH FILE card is the exception — it is a note-shaped *rendering* of
    // `marks/<glyph>.md`, rewritten from the board whenever the collection
    // changes, so typing into it would be typing into a file that is about to
    // be overwritten. It stays readable and stays read-only (wave-2 §2).
    if (node.kind === "note" && node.glyphFile === undefined) makeEditable(body);

    // the resize grip: two hairlines in the corner, grid-free (critique-ledger
    // item 4). It is a corner of the SHEET, not a widget — no handle box, no
    // shadow, and it counter-scales so it stays grabbable at any zoom.
    const grip = document.createElement("div");
    grip.className = "card-grip";
    grip.title = "drag to resize this placement";

    el.append(head, body, grip);
    return el;
  }

  /** plaintext-only where the engine has it; plain contenteditable otherwise */
  function makeEditable(body: HTMLElement): void {
    try {
      body.contentEditable = "plaintext-only";
    } catch {
      body.contentEditable = "true";
    }
    if (!body.isContentEditable) body.contentEditable = "true";
    body.spellcheck = false;
  }

  function geometry(el: HTMLElement, node: LoomNode): void {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
  }

  function content(el: HTMLElement, node: LoomNode): void {
    const title = el.querySelector<HTMLElement>(".card-title");
    const kind = el.querySelector<HTMLElement>(".card-kind");
    const body = el.querySelector<HTMLElement>(".card-body");
    if (!title || !kind || !body) return;

    title.textContent = node.title || node.ref || "untitled";
    const source = options.getSource();
    const label =
      node.glyphFile !== undefined
        ? `glyph file · ${node.glyphFile}`
        : node.kind === "note"
        ? "note"
        : source && source.nodeKind === node.kind
          ? source.label(node.ref)
          : `${node.kind} · ${node.ref}`;
    kind.textContent = node.status === "loading" ? `${label} · loading…` : label;
    el.dataset["status"] = node.status;

    if (node.kind === "note") {
      // never re-write the text under a live caret — the model change that got
      // us here is almost always this very keystroke coming back around
      if (document.activeElement !== body) body.textContent = node.text ?? "";
      return;
    }
    if (node.html) {
      // already sanitized at the provider boundary
      body.innerHTML = node.html;
      return;
    }
    body.replaceChildren(placeholder(node));
  }

  function placeholder(node: LoomNode): HTMLElement {
    const p = document.createElement("p");
    p.className = "card-placeholder";
    p.textContent =
      node.status === "error"
        ? (node.error ?? "could not load")
        : node.status === "loading"
          ? "fetching…"
          : "not loaded";
    return p;
  }

  // ---- selection ----------------------------------------------------------

  function select(id: string | null): void {
    if (selectedId === id) return;
    if (selectedId) els.get(selectedId)?.removeAttribute("data-selected");
    selectedId = id;
    if (id) els.get(id)?.setAttribute("data-selected", "");
  }

  function ping(id: string): void {
    const el = els.get(id);
    if (!el) return;
    const prev = pings.get(id);
    if (prev !== undefined) window.clearTimeout(prev);
    el.setAttribute("data-ping", "");
    pings.set(
      id,
      window.setTimeout(() => {
        el.removeAttribute("data-ping");
        pings.delete(id);
      }, PING_MS),
    );
  }

  function raise(el: HTMLElement): void {
    el.style.zIndex = String(++topZ);
  }

  // ---- pointer ------------------------------------------------------------

  type Drag =
    | { kind: "move"; id: string; pointer: number; startX: number; startY: number; originX: number; originY: number }
    | { kind: "size"; id: string; pointer: number; startX: number; startY: number; originW: number; originH: number }
    | { kind: "edge"; id: string; pointer: number; moved: boolean };

  let drag: Drag | null = null;

  function nodeIdFor(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const card = target.closest<HTMLElement>(".card");
    return card?.dataset["nodeId"] ?? null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const id = nodeIdFor(e.target);
    if (!id) return;
    const el = els.get(id);
    if (!el) return;
    raise(el);
    select(id);

    // the head controls are buttons, not drag handles: let the click through
    if (
      e.target instanceof Element &&
      e.target.closest(".card-unpin, .card-facet-btn, .card-outline-btn, .card-outline")
    ) {
      return;
    }

    if (e.target instanceof Element && e.target.closest(".card-grip")) {
      const node = board.node(id);
      if (!node) return;
      drag = {
        kind: "size",
        id,
        pointer: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originW: node.width,
        originH: node.height,
      };
      el.setPointerCapture(e.pointerId);
      el.setAttribute("data-sizing", "");
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.altKey) {
      drag = { kind: "edge", id, pointer: e.pointerId, moved: false };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!(e.target instanceof Element) || !e.target.closest(".card-head")) return;
    const node = board.node(id);
    if (!node) return;
    drag = {
      kind: "move",
      id,
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: node.x,
      originY: node.y,
    };
    el.setPointerCapture(e.pointerId);
    el.setAttribute("data-dragging", "");
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || drag.pointer !== e.pointerId) return;
    if (drag.kind === "move") {
      const z = camera.z || 1;
      board.moveNode(
        drag.id,
        Math.round(drag.originX + (e.clientX - drag.startX) / z),
        Math.round(drag.originY + (e.clientY - drag.startY) / z),
      );
      return;
    }
    if (drag.kind === "size") {
      // grid-free on purpose: a card is a sheet of paper, not a cell. The floor
      // is model.sizeNode's own (120×80) — below that the head has no measure.
      const z = camera.z || 1;
      board.sizeNode(
        drag.id,
        Math.round(drag.originW + (e.clientX - drag.startX) / z),
        Math.round(drag.originH + (e.clientY - drag.startY) / z),
      );
      return;
    }
    const from = board.node(drag.id);
    if (!from) return;
    drag.moved = true;
    const p = camera.eventPoint(e);
    edges.showPending(from, camera.screenToWorld(p.x, p.y));
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || drag.pointer !== e.pointerId) return;
    const current = drag;
    drag = null;
    const el = els.get(current.id);
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    el?.removeAttribute("data-dragging");
    el?.removeAttribute("data-sizing");

    if (current.kind === "move" || current.kind === "size") return;

    edges.hidePending();
    if (!current.moved) return;
    const dropped = dropTarget(e, current.id);
    if (dropped) {
      // an alt-drag edge is an assertion, not a walk: nothing was followed
      board.addEdge(current.id, dropped, "manual", {
        prov: { by: "human", how: "place", from: current.id, src: null },
      });
      ping(dropped);
    }
  }

  function dropTarget(e: PointerEvent, sourceId: string): string | null {
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of stack) {
      const card = el.closest<HTMLElement>(".card");
      const id = card?.dataset["nodeId"];
      if (id && id !== sourceId) return id;
    }
    return null;
  }

  function onClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const unpin = e.target.closest(".card-unpin");
    if (!unpin) return;
    const id = nodeIdFor(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    board.removeNode(id);
  }

  /** typing in a note writes straight through to the model (and so to disk) */
  function onInput(e: Event): void {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("card-body")) return;
    const id = nodeIdFor(target);
    if (!id) return;
    const node = board.node(id);
    if (!node || node.kind !== "note") return;
    board.setContent(id, { text: target.innerText });
  }

  function onPaperDown(e: PointerEvent): void {
    if (e.target instanceof Element && e.target.closest(".card")) return;
    select(null);
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);
  container.addEventListener("click", onClick);
  container.addEventListener("input", onInput);
  viewport.addEventListener("pointerdown", onPaperDown);

  const unsubscribe = board.onChange((change) => sync(change));
  sync();

  return {
    selected: () => selectedId,
    select,
    ping,
    element: (id) => els.get(id),
    elements(id) {
      const out: HTMLElement[] = [];
      for (const n of board.placementsOf(id)) {
        const el = els.get(n.id);
        if (el) out.push(el);
      }
      return out;
    },
    destroy() {
      unsubscribe();
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      container.removeEventListener("click", onClick);
      container.removeEventListener("input", onInput);
      viewport.removeEventListener("pointerdown", onPaperDown);
      for (const el of els.values()) el.remove();
      els.clear();
    },
  };
}
