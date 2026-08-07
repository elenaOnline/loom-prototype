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
import type { Board, LoomNode, NodeKind, ProvSeed } from "./model";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "./model";
import { freeSpotNear } from "./arrange";
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

  /**
   * Bloom near the source: right edge + GAP, staggered down-then-up until a
   * free slot appears, stepping into a further column only when the first is
   * genuinely full. No drag-to-place ceremony (brief Q3 is exactly this
   * default, put on the table to be felt).
   *
   * The search itself moved to `arrange.freeSpotNear` in wave-2 §4 — a facet
   * blooms beside its source by the same reading of "beside", and two copies of
   * it would have drifted. Only the "everything is full" answer is local: a
   * spawn jitters and overlaps rather than refusing to happen.
   */
  function placeNear(src: LoomNode, w: number, h: number): { x: number; y: number } {
    const found = freeSpotNear(board.nodes(), src, w, h, { gap: GAP, stagger: STAGGER });
    if (found) return found;
    const step = h + STAGGER;
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
    prov: ProvSeed,
  ): LoomNode {
    const w = DEFAULT_CARD_W;
    const h = DEFAULT_CARD_H;
    const at = from ? placeNear(from, w, h) : { x: 0, y: 0 };
    const node = board.addNode({
      kind,
      ref,
      title,
      x: at.x,
      y: at.y,
      width: w,
      height: h,
      prov,
    });
    void hydrate(node.id);
    return node;
  }

  /**
   * `rawHref` is the href as the document wrote it, NOT the resolved ref — a
   * Wikipedia redirect slug reaches a card whose ref is the canonical title,
   * and provenance is the only place the difference can be kept (FINDINGS
   * learning 3: record what was FOLLOWED, canonicalize what was REACHED).
   */
  function follow(sourceId: string, href: string, rawHref: string, text: string): void {
    const source = getSource();
    const from = board.node(sourceId);
    if (!source || !from) return;
    const target = source.resolveLink(href, from.ref, text);
    if (!target) {
      status("that link goes outside this board");
      return;
    }

    // every object born of a link click is a WANDER, from this card, via this href
    const prov: ProvSeed = {
      by: "human",
      how: "wander",
      from: sourceId,
      src: rawHref || href || null,
    };

    const mode = board.topologyMode();
    const existing = board.findByRef(target.kind, target.ref);
    const revisit = existing !== undefined && existing.id !== sourceId;

    // A revisit must answer with a MOVE as well as a ping, or two of the three
    // modes give nothing at all when the card you came back to is off-screen —
    // and the §7.1 comparison would be reading a rendering accident.
    if (revisit && existing && mode === "linkback") {
      board.addEdge(sourceId, existing.id, "trail", { prov });
      options.onPing?.(existing.id);
      nudge(existing);
      status(`linked back → ${existing.title}`);
      return;
    }
    if (revisit && existing && mode === "returnedge") {
      board.addEdge(sourceId, existing.id, "return", { prov });
      options.onPing?.(existing.id);
      nudge(existing);
      status(`return edge → ${existing.title}`);
      return;
    }
    if (existing && existing.id === sourceId && mode !== "duplicate") {
      status("that link points at this card");
      return;
    }

    const node = spawn(target.kind, target.ref, target.title, from, prov);
    board.addEdge(sourceId, node.id, "trail", { prov });
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
    const rawHref = a.getAttribute("href") ?? "";
    follow(sourceId, ref ?? rawHref, rawHref, a.textContent ?? "");
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
        // a root was PUT here (seed, or an explicit open) — nothing was followed
        prov: { by: "human", how: "place", from: null, src: null },
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
