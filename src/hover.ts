// hover.ts — THE HOVER LENS (wave-3 §4, owner request 2026-08-08).
//
// The Litmaps gesture: rest the pointer on a node and its NEIGHBOURHOOD comes
// forward — the card, its direct edge-neighbours, the edges between them —
// while everything else falls back to semi-transparent. A viewing aid, not a
// selection: nothing is grabbed, nothing persists, moving off the card puts
// the cloth back exactly as it was.
//
// Where it runs: THREAD and CLOTH range only. At fiber range the pointer lives
// on cards constantly (reading, selecting text, following links) and a lens
// that dimmed the room every time you rested the mouse would make the reading
// surface flinch — reading surfaces are sacred.
//
// Where it yields: a thread or glyph selection already owns the
// recede-the-rest idiom (ink vs ghost). Two dimming systems at once would
// fight about what "everything else" means, so the lens stays off while any
// selection is live.
//
// Disclosure (FINDINGS): this is OPACITY, not the lace-native ghost-role
// recession the selection idioms use. The owner asked for the Litmaps feel by
// name; the prototype is lace-adjacent, and the two treatments side by side
// (selection = recede to ghost, hover = semi-transparent) is itself a useful
// A/B for the native build to judge.

import type { Board } from "./model";

export interface HoverLens {
  destroy(): void;
}

export interface HoverLensOptions {
  board: Board;
  viewport: HTMLElement;
  /** the card layer's container (#cards) — carries the lens class */
  cardsContainer: HTMLElement;
  /** the edge layer's svg (#edges) — carries the lens class */
  edgesSvg: SVGSVGElement;
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  /** "full" | "title" | "glyph" — the lens only runs above the fiber band */
  getTier: () => string;
  /** a live thread/glyph selection owns the stage; the lens waits */
  isSuppressed: () => boolean;
}

/** rest, don't graze: the lens waits for the pointer to settle */
const ENTER_MS = 140;

export function createHoverLens(options: HoverLensOptions): HoverLens {
  const { board, viewport, cardsContainer, edgesSvg } = options;

  let litRoot: string | null = null;
  let enterTimer = 0;

  function neighbourhood(root: string): { cards: Set<string>; edges: Set<string> } {
    const cards = new Set<string>();
    const edges = new Set<string>();
    const claim = (cardId: string): void => {
      for (const p of board.placementsOf(cardId)) cards.add(p.id);
    };
    claim(root);
    for (const e of board.edgesOf(root)) {
      edges.add(e.id);
      claim(e.from === root ? e.to : e.from);
    }
    return { cards, edges };
  }

  function apply(root: string): void {
    litRoot = root;
    const { cards, edges } = neighbourhood(root);
    cardsContainer.classList.add("hover-lens");
    edgesSvg.classList.add("hover-lens");
    for (const n of board.nodes()) {
      const el = options.getCardEl(n.id);
      if (!el) continue;
      if (cards.has(n.id)) el.setAttribute("data-hover", "in");
      else el.removeAttribute("data-hover");
    }
    for (const el of edgesSvg.querySelectorAll<SVGElement>("[data-edge-id]")) {
      const id = el.getAttribute("data-edge-id");
      if (id && edges.has(id)) el.setAttribute("data-hover", "in");
      else el.removeAttribute("data-hover");
    }
  }

  function clear(): void {
    if (enterTimer !== 0) {
      window.clearTimeout(enterTimer);
      enterTimer = 0;
    }
    if (litRoot === null) return;
    litRoot = null;
    cardsContainer.classList.remove("hover-lens");
    edgesSvg.classList.remove("hover-lens");
    for (const el of cardsContainer.querySelectorAll<HTMLElement>("[data-hover]")) {
      el.removeAttribute("data-hover");
    }
    for (const el of edgesSvg.querySelectorAll<SVGElement>("[data-hover]")) {
      el.removeAttribute("data-hover");
    }
  }

  function onPointerOver(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    const card = e.target.closest<HTMLElement>(".card");
    if (!card) {
      clear();
      return;
    }
    if (options.getTier() === "full" || options.isSuppressed()) {
      clear();
      return;
    }
    const nodeId = card.dataset["nodeId"];
    if (!nodeId) return;
    const root = board.contentRoot(nodeId);
    if (root === litRoot) return;
    if (enterTimer !== 0) window.clearTimeout(enterTimer);
    enterTimer = window.setTimeout(() => {
      enterTimer = 0;
      // re-check at fire time: the selection or the altitude may have changed
      // while the pointer was settling
      if (options.getTier() === "full" || options.isSuppressed()) return;
      if (board.node(nodeId)) apply(root);
    }, ENTER_MS);
  }

  function onPointerLeave(): void {
    clear();
  }

  // a drag, a zoom or a grab is never a hover — let go the moment one starts
  function onPointerDown(): void {
    clear();
  }
  function onWheel(): void {
    clear();
  }

  viewport.addEventListener("pointerover", onPointerOver);
  viewport.addEventListener("pointerleave", onPointerLeave);
  viewport.addEventListener("pointerdown", onPointerDown, { capture: true });
  viewport.addEventListener("wheel", onWheel, { passive: true });

  return {
    destroy() {
      clear();
      viewport.removeEventListener("pointerover", onPointerOver);
      viewport.removeEventListener("pointerleave", onPointerLeave);
      viewport.removeEventListener("pointerdown", onPointerDown, { capture: true });
      viewport.removeEventListener("wheel", onWheel);
    },
  };
}
