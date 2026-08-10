// edges.ts — the one SVG layer, under the cards, in world space.
//
// Edge geometry IS state (lace, ARCHITECTURE.md §Interaction conventions):
//   trail  — solid 1px ink hairline, no arrowhead. "I walked here."
//   manual — dashed 1px with a small arrowhead. "I asserted this."
//   tether — a --ghost hairline holding a note to the card it is a note ON.
//            Not a walk and not an assertion: a fainter line for a weaker claim.
//   return — 1.5px in the signal role, routed as a loop that leaves the source
//            backwards, rises, and drops into the target from above.
//            "I came back here." It must be legible as a *different kind of
//            event* at a glance — the whole §7.1 hypothesis is that Wikiboard's
//            mess was a rendering failure, not a topology failure.
//
// Two atoms complete the vocabulary, both 1px-on-screen circles: a FILLED --sig
// atom where a return lands (the revisit), and an OPEN --ink atom at the fork
// where a branch leaves its source (the second and later child of a card). The
// stroke of a branch is an ordinary trail hairline — only its origin is marked.
//
// Redraw is on graph/position change only. The camera moves the whole world;
// edges ride along for free.

import type { Board, EdgeKind, LoomNode } from "./model";
import { branchStartEdgeIds } from "./model";
import type { Point } from "./camera";

const SVG_NS = "http://www.w3.org/2000/svg";
/** world px of slack around content — return loops rise well above their cards */
const PAD = 520;

/** thread selection paints every edge as either part of the thread, or backdrop */
export type EdgeEmphasis = "in" | "out";

export type EdgeClassifier = (edgeId: string) => EdgeEmphasis | null;

export interface EdgeLayer {
  redraw(): void;
  /**
   * Who owns the emphasis. threads.ts installs one closure once and calls
   * `redraw()` when its selection changes — the classifier is read at draw time,
   * so the layer never has to know what a thread is.
   */
  setClassifier(fn: EdgeClassifier | null): void;
  /**
   * Collapse every node rect to its centre. At cloth range (tiers.ts glyph
   * band) a card is drawn as a small square in the middle of its footprint, so
   * anchoring on the footprint's border would leave every edge ending in mid
   * air — at exactly the altitude where the edges are the subject.
   */
  setPointAnchors(on: boolean): void;
  /** rubber band while alt-dragging a manual edge */
  showPending(from: LoomNode, to: Point): void;
  hidePending(): void;
  destroy(): void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function createEdgeLayer(svg: SVGSVGElement, board: Board): EdgeLayer {
  svg.appendChild(defs());
  const group = document.createElementNS(SVG_NS, "g");
  svg.appendChild(group);
  const pending = document.createElementNS(SVG_NS, "path");
  pending.setAttribute("class", "edge edge-pending");
  pending.setAttribute("visibility", "hidden");
  svg.appendChild(pending);

  let raf = 0;
  let classify: EdgeClassifier | null = null;
  let pointAnchors = false;

  /** the shape an edge attaches to: the card, or (at cloth range) its centre */
  function shape(n: LoomNode): Rect {
    const r = rect(n);
    if (!pointAnchors) return r;
    const c = center(r);
    return { x: c.x, y: c.y, w: 0, h: 0 };
  }

  function schedule(): void {
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }

  /**
   * AN EDGE BINDS TO THE CARD; IT DRAWS TO THE NEAREST PLACEMENT (wave-2 §4).
   *
   * Edge endpoints are card ids (model canonicalizes them), so a card with three
   * facets still has exactly the edges it walked. At draw time each end picks the
   * placement of its card that is closest to the other end, so a trail attaches
   * to the window you are actually reading rather than always to the first one.
   *
   * The consequence to feel, logged rather than hidden: moving a facet can now
   * change which placement a trail edge lands on, so the weave's shape answers
   * to where the windows are. The alternative (one edge per facet) multiplies
   * the weave every time a card is opened twice, which is worse.
   */
  function nearestPair(a: LoomNode[], b: LoomNode[]): [LoomNode, LoomNode] | null {
    let best: [LoomNode, LoomNode] | null = null;
    let bestD = Infinity;
    for (const na of a) {
      const ca = center(rect(na));
      for (const nb of b) {
        const cb = center(rect(nb));
        const d = (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [na, nb];
        }
      }
    }
    return best;
  }

  function draw(): void {
    const nodes = board.nodes();
    resize(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // one pass to group placements by card, so the nearest-pair lookup below is
    // a couple of comparisons and not a board query per edge
    const family = new Map<string, LoomNode[]>();
    for (const n of nodes) {
      const root = board.contentRoot(n.id);
      const list = family.get(root);
      if (list) list.push(n);
      else family.set(root, [n]);
    }
    const frag = document.createDocumentFragment();
    // the second and later children of a card are branch starts; marked at the
    // FORK (source side), where a filled return atom marks the LANDING
    const branches = branchStartEdgeIds(board.edges());

    for (const e of board.edges()) {
      const head = byId.get(e.from);
      const tail = byId.get(e.to);
      if (!head || !tail) continue;
      const pair = nearestPair(family.get(e.from) ?? [head], family.get(e.to) ?? [tail]);
      const from = pair?.[0] ?? head;
      const to = pair?.[1] ?? tail;
      // stable ±1 so A→B and B→A bow to opposite sides instead of superimposing
      const d = geometry(e.kind, shape(from), shape(to), e.from < e.to ? 1 : -1);
      const emphasis = classify?.(e.id) ?? null;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", `edge edge-${e.kind}`);
      path.setAttribute("d", d);
      path.setAttribute("data-edge-id", e.id);
      if (emphasis) path.setAttribute("data-thread", emphasis);
      if (e.kind === "manual") path.setAttribute("marker-end", "url(#loom-arrow)");
      frag.appendChild(path);

      if (e.kind === "return") {
        // a filled atom where the return lands: which end is the "came back to"
        const head = anchorTop(shape(to));
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("class", "edge-atom");
        dot.setAttribute("cx", String(head.x));
        dot.setAttribute("cy", String(head.y));
        if (emphasis) dot.setAttribute("data-thread", emphasis);
        frag.appendChild(dot);
      }

      // An OPEN atom where a branch leaves its source: same vocabulary as the
      // filled return atom, opposite fill, opposite end — "the line forked
      // here", not "I came back here". Suppressed at cloth range, where point
      // anchors put every edge of a card on one point and the ring would say
      // nothing about which edge branched.
      if (e.kind === "trail" && branches.has(e.id) && !pointAnchors) {
        const fork = sideAnchor(shape(from), shape(to)).p;
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("class", "edge-fork");
        ring.setAttribute("cx", String(r(fork.x)));
        ring.setAttribute("cy", String(r(fork.y)));
        if (emphasis) ring.setAttribute("data-thread", emphasis);
        frag.appendChild(ring);
      }

      // an invisible fat stroke on top: a 1px hairline is not a click target,
      // and grabbing a thread by its edge is the stage-3 primitive
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("class", "edge-hit");
      hit.setAttribute("d", d);
      hit.setAttribute("data-edge-id", e.id);
      frag.appendChild(hit);
    }

    group.replaceChildren(frag);
  }

  function resize(nodes: LoomNode[]): void {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    let first = true;
    for (const n of nodes) {
      if (first) {
        minX = n.x;
        minY = n.y;
        maxX = n.x + n.width;
        maxY = n.y + n.height;
        first = false;
        continue;
      }
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const x = minX - PAD;
    const y = minY - PAD;
    const w = Math.max(1, maxX - minX + PAD * 2);
    const h = Math.max(1, maxY - minY + PAD * 2);
    svg.style.left = `${x}px`;
    svg.style.top = `${y}px`;
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  const unsubscribe = board.onChange((change) => {
    if (
      change.kind === "content" ||
      change.kind === "meta" ||
      change.kind === "threads" ||
      change.kind === "marks" ||
      // a seal connects cards WITHOUT an edge (wave-4 §2), and a bookmark is a
      // place — neither moves a line
      change.kind === "seals" ||
      change.kind === "bookmarks" ||
      // a restore point being taken or spent moves no card; the moves it causes
      // arrive separately as `position`
      change.kind === "arrange" ||
      // a placement scrolled inside itself; no card moved
      change.kind === "view"
    ) {
      return;
    }
    schedule();
  });

  draw();

  return {
    redraw: schedule,
    setClassifier(fn) {
      classify = fn;
      schedule();
    },
    setPointAnchors(on) {
      if (pointAnchors === on) return;
      pointAnchors = on;
      schedule();
    },
    showPending(from, to) {
      pending.setAttribute("d", curve(center(rect(from)), to, 0.35));
      pending.setAttribute("visibility", "visible");
    },
    hidePending() {
      pending.setAttribute("visibility", "hidden");
    },
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
      unsubscribe();
      svg.replaceChildren();
    },
  };
}

// ------------------------------------------------------------- geometry ----

function rect(n: LoomNode): Rect {
  return { x: n.x, y: n.y, w: n.width, h: n.height };
}

function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function anchorTop(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y };
}

/** the point on `a`'s border facing `b`, plus the outward normal */
function sideAnchor(a: Rect, b: Rect): { p: Point; n: Point } {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) {
    const right = dx >= 0;
    return {
      p: { x: right ? a.x + a.w : a.x, y: ca.y },
      n: { x: right ? 1 : -1, y: 0 },
    };
  }
  const down = dy >= 0;
  return {
    p: { x: ca.x, y: down ? a.y + a.h : a.y },
    n: { x: 0, y: down ? 1 : -1 },
  };
}

/** world px of sideways bow, so a there-and-back pair reads as two edges */
const BOW = 18;

function geometry(kind: EdgeKind, from: Rect, to: Rect, bias: number): string {
  if (kind === "return") return returnLoop(from, to);
  const a = sideAnchor(from, to);
  const b = sideAnchor(to, from);
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const dist = Math.hypot(dx, dy) || 1;
  const pull = Math.max(24, Math.min(180, dist * 0.4));
  const ox = (-dy / dist) * BOW * bias;
  const oy = (dx / dist) * BOW * bias;
  const c1 = { x: a.p.x + a.n.x * pull + ox, y: a.p.y + a.n.y * pull + oy };
  const c2 = { x: b.p.x + b.n.x * pull + ox, y: b.p.y + b.n.y * pull + oy };
  return `M ${r(a.p.x)} ${r(a.p.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.p.x)} ${r(b.p.y)}`;
}

/**
 * Out and back: leave the source's top going *away* from the target, arc high
 * over both cards, come down into the target's top. Reads as a loop even when
 * the two cards are neighbours.
 */
function returnLoop(from: Rect, to: Rect): string {
  const a = anchorTop(from);
  const b = anchorTop(to);
  const span = Math.abs(b.x - a.x);
  const drop = Math.abs(b.y - a.y);
  const lift = 100 + Math.min(240, span * 0.25 + drop * 0.2);
  const away = b.x >= a.x ? -1 : 1;
  const kick = 55 + Math.min(120, span * 0.12);
  const c1 = { x: a.x + away * kick, y: a.y - lift };
  const c2 = { x: b.x - away * kick, y: b.y - lift };
  return `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.x)} ${r(b.y)}`;
}

function curve(a: Point, b: Point, bow: number): string {
  const dx = b.x - a.x;
  const c1 = { x: a.x + dx * bow, y: a.y };
  const c2 = { x: b.x - dx * bow, y: b.y };
  return `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.x)} ${r(b.y)}`;
}

function r(v: number): number {
  return Math.round(v * 10) / 10;
}

function defs(): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "loom-arrow");
  // strokeWidth units: stroke-width is 1/z world px, so the head stays ~7px on
  // screen at every zoom without redrawing on camera change.
  marker.setAttribute("markerUnits", "strokeWidth");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "7.5");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("d", "M 0 0 L 8 3 L 0 6 z");
  head.setAttribute("class", "edge-arrow");
  marker.appendChild(head);
  defs.appendChild(marker);
  return defs;
}
