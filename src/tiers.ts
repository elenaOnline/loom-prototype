// tiers.ts — semantic zoom: fiber → thread → cloth.
//
// Zoom is supposed to move between LEVELS OF ABSTRACTION (ideation §6.4), not
// shrink one picture. So each band is a different *drawing* of the same card:
//
//   full  (z ≥ 0.55)   FIBER  — the article itself; text is selectable, links
//                              are live. This is the only band where a body
//                              exists on screen.
//   title (0.18–0.55)  THREAD — the sheet stays, only its name is written on
//                              it: serif title + mono ref line + mark count.
//                              Type is counter-scaled by --z so the name is
//                              legible AT SCREEN SCALE while the card shrinks.
//   glyph (z < 0.18)   CLOTH  — the card collapses to a hairline square with a
//                              tiny label. Here the EDGES are the subject, so
//                              the edge layer collapses node rects to their
//                              centres and the weave converges on the squares.
//
// Three rules the feel depends on:
//   · INSTANT — no fade, no transition on a tier swap. A dissolve would read as
//     the card "loading"; the honest cut says "you are at a different altitude".
//   · HYSTERESIS — the band edges are ±5%, so a card sitting exactly on 0.55
//     does not strobe between two drawings while you nudge the trackpad.
//   · CULLING — in the full band, bodies of cards outside the (padded) viewport
//     are display:none. That is the perf strategy: at 40+ open articles the DOM
//     is mostly off-screen prose nobody is reading.
//
// Everything above is a CSS class swap on `.card` (`tier-full` / `tier-title` /
// `tier-glyph` / `card-culled`); the geometry, the model and the card bodies are
// untouched, so text selection in the full band keeps working (fibers, stage 5).

import type { Board } from "./model";
import type { Camera, Bounds } from "./camera";
import type { EdgeLayer } from "./edges";

export type Tier = "full" | "title" | "glyph";

export interface TierLayer {
  tier(): Tier;
  /** the altitude word the metaphor promises — fiber · thread · cloth */
  word(): string;
  /** cloth-range caption policy (see CAPTIONS_AT_CLOTH) — reversible, by design */
  captions(): boolean;
  setCaptions(on: boolean): void;
  destroy(): void;
}

export interface TierLayerOptions {
  viewport: HTMLElement;
  board: Board;
  camera: Camera;
  /** the card layer owns the DOM; tiers only re-dresses it */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  /** at cloth range the edges become the subject — they anchor at node centres */
  edges: EdgeLayer;
  onTier?: (tier: Tier, word: string) => void;
}

/** band edges, tuned by feel: below this a body is unreadable anyway */
const T_TITLE = 0.18;
/** above this the prose is worth rendering; below it the title carries the card */
const T_FULL = 0.55;
/** ±5% either side of a band edge: 10% total dead zone, no boundary strobe */
const HYSTERESIS = 0.1;
const UP = 1 + HYSTERESIS / 2;
const DOWN = 1 - HYSTERESIS / 2;

/** how much viewport-worth of slack around the screen stays un-culled */
const CULL_MARGIN = 0.5;

/**
 * CLOTH-RANGE CAPTION POLICY (critique-ledger item 6, tested here because
 * wave-2 §2 needs an answer to "what is legible at cloth range" before the
 * glyph constellation means anything).
 *
 * Glyph captions collide when cards cluster — observed in the wild, FINDINGS
 * Q4. The candidate is to resolve it BY DESIGN rather than by layout: at cloth
 * altitude a caption is a REGION LABEL, so only cards that belong to a named
 * thread keep theirs and everything else is mute geography. The glyph atoms
 * (glyphs.ts) are unaffected — that is the point of the experiment: with the
 * captions gone, what remains legible on the weave is the constellation.
 *
 * Default is the candidate (suppressed), on the same principle stage 2 used for
 * the topology toggle: the session should react to the hypothesis, not to the
 * control. Reversible from the toolbar (`captions`), per ideation §7's meta-rule.
 */
const CAPTIONS_AT_CLOTH = false;

const TIER_CLASS: Record<Tier, string> = {
  full: "tier-full",
  title: "tier-title",
  glyph: "tier-glyph",
};

const TIER_WORD: Record<Tier, string> = {
  full: "fiber",
  title: "thread",
  glyph: "cloth",
};

/**
 * The band for `z`, given where we already are. The moving edge is the one you
 * are approaching: leaving a band costs 5% more zoom than the nominal number,
 * which is what stops a card on the boundary from flickering.
 */
export function tierFor(z: number, current: Tier): Tier {
  const titleEdge = current === "glyph" ? T_TITLE * UP : T_TITLE * DOWN;
  const fullEdge = current === "full" ? T_FULL * DOWN : T_FULL * UP;
  if (z < titleEdge) return "glyph";
  if (z < fullEdge) return "title";
  return "full";
}

interface Painted {
  tier: Tier | null;
  culled: boolean;
  marks: number;
  /** caption suppressed at cloth range (see CAPTIONS_AT_CLOTH) */
  mute: boolean;
  /** where the reader was in this body when culling took its layout away */
  scroll: number;
}

export function createTierLayer(options: TierLayerOptions): TierLayer {
  const { viewport, board, camera, edges } = options;

  let tier: Tier = tierFor(camera.z, "full");
  let captions = CAPTIONS_AT_CLOTH;
  const painted = new Map<string, Painted>();

  /** every card a NAMED thread holds — the only cards that keep a cloth caption */
  function labelled(): Set<string> {
    const out = new Set<string>();
    for (const thread of board.threads()) {
      for (const id of thread.nodeIds) out.add(id);
    }
    return out;
  }

  // ---- geometry -----------------------------------------------------------

  /** the viewport in world coordinates, padded by half a screen on each side */
  function visibleWorld(): Bounds {
    const r = viewport.getBoundingClientRect();
    const a = camera.screenToWorld(0, 0);
    const b = camera.screenToWorld(r.width, r.height);
    const mx = (b.x - a.x) * CULL_MARGIN;
    const my = (b.y - a.y) * CULL_MARGIN;
    return { minX: a.x - mx, minY: a.y - my, maxX: b.x + mx, maxY: b.y + my };
  }

  function overlaps(
    x: number,
    y: number,
    w: number,
    h: number,
    view: Bounds,
  ): boolean {
    return x < view.maxX && x + w > view.minX && y < view.maxY && y + h > view.minY;
  }

  // ---- the mark count (fibers ride along into the title card) --------------

  function markCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const mark of board.marks()) {
      counts.set(mark.nodeId, (counts.get(mark.nodeId) ?? 0) + 1);
    }
    return counts;
  }

  function setMarks(el: HTMLElement, count: number): void {
    const existing = el.querySelector<HTMLElement>(".card-marks");
    if (count <= 0) {
      existing?.remove();
      return;
    }
    const label = `${count} mark${count === 1 ? "" : "s"}`;
    if (existing) {
      existing.textContent = label;
      return;
    }
    const span = document.createElement("span");
    span.className = "card-marks";
    span.textContent = label;
    el.querySelector(".card-head-stack")?.appendChild(span);
  }

  // ---- culling, without losing the reader's place --------------------------
  // `display: none` destroys a body's layout, and with it its scrollTop. Panning
  // a card off-screen and back would silently jump the article to the top —
  // exactly the regression a long wandering session would trip over. So the
  // position is stashed on the way out and put back on the way in.

  function bodyOf(el: HTMLElement): HTMLElement | null {
    return el.querySelector<HTMLElement>(".card-body");
  }

  /** remember the place before the layout goes away */
  function stashScroll(el: HTMLElement, state: Painted): void {
    const body = bodyOf(el);
    if (body && body.offsetParent !== null && body.scrollTop > 0) {
      state.scroll = body.scrollTop;
    }
  }

  /** put it back once the body has a layout again; the stash is never cleared,
   *  so a body that comes back hidden (zoomed out to the title band) can still
   *  be restored the next time it is genuinely on screen */
  function restoreScroll(el: HTMLElement, state: Painted): void {
    if (state.scroll <= 0) return;
    const body = bodyOf(el);
    if (!body) return;
    const want = state.scroll;
    body.scrollTop = want;
    // the body was display:none a moment ago; if the engine has not re-laid it
    // out yet the assignment silently reads back 0, so try once more next frame
    if (Math.abs(body.scrollTop - want) > 1) {
      requestAnimationFrame(() => {
        if (!body.isConnected || body.offsetParent === null) return;
        body.scrollTop = want;
      });
    }
  }

  function setCulled(el: HTMLElement, state: Painted, culled: boolean): void {
    if (culled) stashScroll(el, state);
    el.classList.toggle("card-culled", culled);
    state.culled = culled;
    if (!culled) restoreScroll(el, state);
  }

  // ---- paint --------------------------------------------------------------

  function paint(): void {
    const next = tierFor(camera.z, tier);
    if (next !== tier) {
      tier = next;
      // at cloth range the cards stop being rectangles you read and become the
      // knots the weave ties; the edges must land on them, not on their ghosts
      edges.setPointAnchors(tier === "glyph");
      options.onTier?.(tier, TIER_WORD[tier]);
    }

    const view = tier === "full" ? visibleWorld() : null;
    const counts = tier === "title" ? markCounts() : null;
    const named = tier === "glyph" && !captions ? labelled() : null;
    const seen = new Set<string>();

    for (const node of board.nodes()) {
      seen.add(node.id);
      const el = options.getCardEl(node.id);
      if (!el) continue;

      let state = painted.get(node.id);
      if (!state) {
        state = { tier: null, culled: false, marks: 0, mute: false, scroll: 0 };
        painted.set(node.id, state);
      }

      if (state.tier !== tier) {
        // leaving the full band hides the body by CSS, which is the same
        // display:none teardown as culling — stash on the way out, restore on
        // the way back, or the culling fix is undone by one zoom-out
        if (state.tier === "full") stashScroll(el, state);
        if (state.tier) el.classList.remove(TIER_CLASS[state.tier]);
        el.classList.add(TIER_CLASS[tier]);
        state.tier = tier;
        if (tier === "full" && !state.culled) restoreScroll(el, state);
      }

      const culled = view ? !overlaps(node.x, node.y, node.width, node.height, view) : false;
      if (culled !== state.culled) setCulled(el, state, culled);

      const mute = named !== null && !named.has(node.id);
      if (mute !== state.mute) {
        if (mute) el.setAttribute("data-mute", "");
        else el.removeAttribute("data-mute");
        state.mute = mute;
      }

      if (counts) {
        const count = counts.get(node.id) ?? 0;
        if (count !== state.marks) {
          setMarks(el, count);
          state.marks = count;
        }
      }
    }

    for (const id of Array.from(painted.keys())) {
      if (!seen.has(id)) painted.delete(id);
    }
  }

  // Camera first: onChange fires once on subscribe, which is the initial paint.
  // Board second: a card spawned at cloth range must be born as a glyph, and
  // the card layer subscribes before this one, so its DOM already exists here.
  const unwatchCamera = camera.onChange(() => paint());
  const unwatchBoard = board.onChange(() => paint());
  options.onTier?.(tier, TIER_WORD[tier]);

  return {
    tier: () => tier,
    word: () => TIER_WORD[tier],
    captions: () => captions,
    setCaptions(on) {
      if (captions === on) return;
      captions = on;
      paint();
    },
    destroy() {
      unwatchCamera();
      unwatchBoard();
      edges.setPointAnchors(false);
      for (const [id, state] of painted) {
        const el = options.getCardEl(id);
        if (!el) continue;
        if (state.tier) el.classList.remove(TIER_CLASS[state.tier]);
        el.classList.remove("card-culled");
        el.removeAttribute("data-mute");
        el.querySelector(".card-marks")?.remove();
      }
      painted.clear();
    },
  };
}
