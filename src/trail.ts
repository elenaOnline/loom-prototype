// trail.ts — link click → spawn, and THE TOPOLOGY TOGGLE (brief §2, ideation §7.1).
//
// The prime experiment of the whole prototype. Same board, three live modes:
//
//   duplicate  — always spawn a fresh card, even if the target is already here.
//                (Wikiboard's shipped behavior: honest about the walk, tangles.)
//   linkback   — target already placed? draw a trail edge to it, spawn nothing.
//                (Wikiboard's reverted behavior: compact, loses the walk.)
//   returnedge — spawn fresh normally, but a revisit draws a RETURN edge instead:
//                a distinct 1.5px signal-colored loop recording "I came back
//                here". Branches from mid-thread are ordinary trail edges in all
//                three modes — a branch is not a revisit.
//
// The mode is read at spawn time, never baked into the data, so you can flip it
// mid-wander and keep tangling the same board.
//
// A link click NEVER navigates: capture-phase, preventDefault always.

import type { Camera, Insets } from "./camera";
import type { Board, LoomNode, NodeKind } from "./model";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "./model";
import { LINK_REF_ATTR, LINK_ROLE_ATTR } from "./providers/source";
import type { ContentSource } from "./providers/source";

/** world px between a source card's right edge and its spawn */
const GAP = 60;
/** vertical stagger between siblings in the same spawn column */
const STAGGER = 28;
/** how far a card must be off-screen before the camera admits it exists */
const NUDGE_MARGIN = 24;

export interface Trail {
  /** fetch a node's body through the active source */
  hydrate(id: string): void;
  /** everything still idle — used after a load or a mode switch */
  hydrateAll(): void;
  /** place a first card (the seed, or a manual "open") */
  spawnRoot(ref: string, title: string, at?: { x: number; y: number }): LoomNode | null;
  destroy(): void;
}

export interface TrailOptions {
  board: Board;
  container: HTMLElement;
  camera: Camera;
  getSource: () => ContentSource | null;
  onPing?: (nodeId: string) => void;
  onStatus?: (text: string) => void;
  getInsets?: () => Partial<Insets>;
  viewport: HTMLElement;
}

export function createTrail(options: TrailOptions): Trail {
  const { board, container, camera, getSource, viewport } = options;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- hydration ----------------------------------------------------------

  const loading = new Set<string>();

  async function hydrate(id: string): Promise<void> {
    const node = board.node(id);
    const source = getSource();
    if (!node || !source || node.kind === "note") return;
    if (node.kind !== source.nodeKind) return;
    if (loading.has(id) || node.status === "ready") return;
    loading.add(id);
    board.setContent(id, { status: "loading" });

    if (source.preview) {
      try {
        const peek = await source.preview(node.ref);
        const still = board.node(id);
        if (peek && still && still.status === "loading" && !still.html) {
          board.setContent(id, { html: peek.html, ...(peek.title ? { title: peek.title } : {}) });
        }
      } catch {
        /* preview is a courtesy; the real load reports failure */
      }
    }

    try {
      const body = await source.load(node.ref);
      if (!board.node(id)) return;
      board.setContent(id, {
        html: body.html,
        status: "ready",
        ...(body.title ? { title: body.title } : {}),
      });
    } catch (err) {
      if (!board.node(id)) return;
      board.setContent(id, { status: "error", error: shortError(err) });
    } finally {
      loading.delete(id);
    }
  }

  function hydrateAll(): void {
    const source = getSource();
    if (!source) return;
    const queue = board
      .nodes()
      .filter((n) => n.kind === source.nodeKind && n.status !== "ready" && !n.html);
    let active = 0;
    const pump = (): void => {
      while (active < 4) {
        const next = queue.shift();
        if (!next) return;
        active += 1;
        void hydrate(next.id).finally(() => {
          active -= 1;
          pump();
        });
      }
    };
    pump();
  }

  // ---- placement ----------------------------------------------------------

  function overlaps(x: number, y: number, w: number, h: number): boolean {
    const pad = 12;
    for (const n of board.nodes()) {
      if (
        x < n.x + n.width + pad &&
        x + w + pad > n.x &&
        y < n.y + n.height + pad &&
        y + h + pad > n.y
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Bloom near the source: right edge + GAP, staggered down-then-up until a
   * free slot appears, stepping into a further column only when the first is
   * genuinely full. No drag-to-place ceremony (brief Q3 is exactly this
   * default, put on the table to be felt).
   */
  function placeNear(src: LoomNode, w: number, h: number): { x: number; y: number } {
    const step = h + STAGGER;
    for (let col = 0; col < 4; col += 1) {
      const x = src.x + src.width + GAP + col * (w + GAP);
      for (let i = 0; i < 12; i += 1) {
        const rung = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1); // 0, +1, -1, +2, …
        const y = src.y + rung * step;
        if (!overlaps(x, y, w, h)) return { x, y };
      }
    }
    return { x: src.x + src.width + GAP, y: src.y + (Math.random() * 2 - 1) * step };
  }

  // ---- camera courtesy ----------------------------------------------------

  /** bring a spawn just inside the frame — the smallest pan that works, or none */
  function nudge(node: LoomNode): void {
    const rect = viewport.getBoundingClientRect();
    const partial = options.getInsets?.() ?? {};
    const top = (partial.top ?? 0) + NUDGE_MARGIN;
    const bottom = (partial.bottom ?? 0) + NUDGE_MARGIN;
    const left = (partial.left ?? 0) + NUDGE_MARGIN;
    const right = (partial.right ?? 0) + NUDGE_MARGIN;

    const a = camera.worldToScreen(node.x, node.y);
    const b = camera.worldToScreen(node.x + node.width, node.y + node.height);
    // only chase what can actually fit; a card taller than the frame stays put
    const w = Math.min(b.x - a.x, rect.width - left - right);
    const h = Math.min(b.y - a.y, rect.height - top - bottom);

    let dx = 0;
    let dy = 0;
    if (a.x < left) dx = left - a.x;
    else if (a.x + w > rect.width - right) dx = rect.width - right - w - a.x;
    if (a.y < top) dy = top - a.y;
    else if (a.y + h > rect.height - bottom) dy = rect.height - bottom - h - a.y;

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const cam = camera.state();
    camera.flyToCamera({ x: cam.x + dx, y: cam.y + dy, z: cam.z }, { duration: 240 });
  }

  // ---- spawning -----------------------------------------------------------

  function spawn(
    kind: NodeKind,
    ref: string,
    title: string,
    from: LoomNode | null,
  ): LoomNode {
    const w = DEFAULT_CARD_W;
    const h = DEFAULT_CARD_H;
    const at = from ? placeNear(from, w, h) : { x: 0, y: 0 };
    const node = board.addNode({ kind, ref, title, x: at.x, y: at.y, width: w, height: h });
    void hydrate(node.id);
    return node;
  }

  function follow(sourceId: string, href: string, text: string): void {
    const source = getSource();
    const from = board.node(sourceId);
    if (!source || !from) return;
    const target = source.resolveLink(href, from.ref, text);
    if (!target) {
      status("that link goes outside this board");
      return;
    }

    const mode = board.topologyMode();
    const existing = board.findByRef(target.kind, target.ref);
    const revisit = existing !== undefined && existing.id !== sourceId;

    // A revisit must answer with a MOVE as well as a ping, or two of the three
    // modes give nothing at all when the card you came back to is off-screen —
    // and the §7.1 comparison would be reading a rendering accident.
    if (revisit && existing && mode === "linkback") {
      board.addEdge(sourceId, existing.id, "trail");
      options.onPing?.(existing.id);
      nudge(existing);
      status(`linked back → ${existing.title}`);
      return;
    }
    if (revisit && existing && mode === "returnedge") {
      board.addEdge(sourceId, existing.id, "return");
      options.onPing?.(existing.id);
      nudge(existing);
      status(`return edge → ${existing.title}`);
      return;
    }
    if (existing && existing.id === sourceId && mode !== "duplicate") {
      status("that link points at this card");
      return;
    }

    const node = spawn(target.kind, target.ref, target.title, from);
    board.addEdge(sourceId, node.id, "trail");
    status(revisit ? `duplicate → ${target.title}` : `spawned → ${target.title}`);
    nudge(node);
  }

  // ---- link interception --------------------------------------------------

  function anchorFrom(e: Event): HTMLAnchorElement | null {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    const a = target.closest("a");
    return a instanceof HTMLAnchorElement && container.contains(a) ? a : null;
  }

  function onClickCapture(e: MouseEvent): void {
    const a = anchorFrom(e);
    if (!a) return;
    // a link click is NEVER navigation on this canvas — no exceptions, no
    // modifier escape hatch, nothing that could yank the page out from under
    // the board.
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) return; // alt is the manual-edge gesture

    const card = a.closest<HTMLElement>(".card");
    const sourceId = card?.dataset["nodeId"];
    if (!sourceId) return;

    const role = a.getAttribute(LINK_ROLE_ATTR);
    if (role === "skip") {
      status("anchor link — nothing to spawn");
      return;
    }
    if (role === "external") {
      status("external link — this board only follows its own corpus");
      return;
    }
    if (role === "missing") {
      status("no such file in this folder");
      return;
    }
    const ref = a.getAttribute(LINK_REF_ATTR);
    follow(sourceId, ref ?? a.getAttribute("href") ?? "", a.textContent ?? "");
  }

  function onAuxCapture(e: MouseEvent): void {
    if (anchorFrom(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onDragStart(e: DragEvent): void {
    if (anchorFrom(e)) e.preventDefault();
  }

  container.addEventListener("click", onClickCapture, true);
  container.addEventListener("auxclick", onAuxCapture, true);
  container.addEventListener("dragstart", onDragStart, true);

  return {
    hydrate(id) {
      void hydrate(id);
    },
    hydrateAll,
    spawnRoot(ref, title, at) {
      const source = getSource();
      if (!source) return null;
      const existing = board.findByRef(source.nodeKind, ref);
      if (existing) {
        options.onPing?.(existing.id);
        return existing;
      }
      const node = board.addNode({
        kind: source.nodeKind,
        ref,
        title,
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
      });
      void hydrate(node.id);
      return node;
    },
    destroy() {
      container.removeEventListener("click", onClickCapture, true);
      container.removeEventListener("auxclick", onAuxCapture, true);
      container.removeEventListener("dragstart", onDragStart, true);
    },
  };
}

function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
