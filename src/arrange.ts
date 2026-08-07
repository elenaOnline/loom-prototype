// arrange.ts — THE ENTROPY VERBS, as pure geometry (wave-2 §3, ideation §7.5).
//
// The owner's board tangles: repeated `pull taut` alone degrades it, and the
// felt want was "some kind of reset or auto sort". The ideation ladder answers
// truthfulness-first — (a) relax, (b) comb, (c) arrangement memory, (d) auto
// sort — and this module holds rungs (a) and (b) plus the arithmetic (c) needs.
//
// Everything here is a PURE function of the nodes handed in. No DOM, no board,
// no animation, no status text: threads.ts owns the gesture, the ease and the
// stash; this file owns only "where should these cards be". That split is what
// lets the harness check the one property the brief actually asks about —
// **a verb must never move a card that was not handed to it** — without a
// browser, and it is why comb can be argued about without arguing about UI.
//
// The three verbs, stated as claims about truth:
//
//   RELAX  restores each card to `prov.x0/y0` — where the WANDER put it. It
//          invents nothing; a card whose birthplace was never recorded is left
//          exactly where it is and counted, never guessed at.
//   COMB   is minimal-motion, local tidying: straighten the selected thread
//          onto its own best-fit line and open just enough clear air between
//          consecutive cards. It keeps the walk's RHYTHM (a long pause between
//          two cards stays a long gap) and never touches a card outside the
//          run.
//   PULL   (wave 1, moved here intact) gathers the run onto an even arc — equal
//          steps, a little sag. It is a LENS: it discards the rhythm on purpose
//          so the line reads as one object, and it is reversible or it is a lie.
//
// Comb and pull are deliberately different answers to the same question. If the
// session finds it only ever wants one of them, that is a finding — and the
// cheapest possible way to learn it is to ship both and watch which is pressed.

import type { LoomNode } from "./model";

/** a world position; the id lives in the Map key */
export interface Spot {
  x: number;
  y: number;
}

/** world px of clear air between cards on a taut thread */
export const TAUT_GAP = 56;
/** a taut thread still hangs: bow as a fraction of its length, capped */
const SAG_RATIO = 0.1;
const SAG_MAX = 200;
/**
 * Comb's clear air. Smaller than TAUT_GAP on purpose: comb is the conservative
 * verb, and its promise is "I moved as little as I could get away with".
 */
export const COMB_GAP = 40;

/** the arrangement scope for "no thread selected — the whole cloth" */
export const SCOPE_BOARD = "board";

/**
 * The key an arrangement's restore point is filed under. A NAMED thread is
 * keyed by identity, never by membership: an unpinned thread follows its tip
 * (wave-2 §1), so a membership key would change mid-pull and strand the stash —
 * the exact irreversibility wave 1 logged. An unnamed run has nothing but its
 * membership to be keyed by, and accepts that.
 */
export function scopeKey(threadId: string | null, nodeIds: readonly string[]): string {
  return threadId ? `thread:${threadId}` : `run:${nodeIds.join("|")}`;
}

/** centre of a card in world space */
function centre(n: LoomNode): Spot {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
}

/** how far a card reaches from its centre along `u` (axis-aligned box support) */
function halfExtent(n: LoomNode, ux: number, uy: number): number {
  return (Math.abs(ux) * n.width + Math.abs(uy) * n.height) / 2;
}

function topLeft(c: Spot, n: LoomNode): Spot {
  return { x: Math.round(c.x - n.width / 2), y: Math.round(c.y - n.height / 2) };
}

// ------------------------------------------------------------------ relax ----

export interface RelaxResult {
  /** node id → where the wander left it; only cards that actually have to move */
  targets: Map<string, Spot>;
  /** cards whose birthplace this board never recorded — left alone, not guessed */
  unknown: number;
  /**
   * cards whose `x0/y0` were BACKFILLED on first open (`prov.at === null`), so
   * their "birthplace" is only where they stood when provenance arrived. Relax
   * is honest about the difference: a wave-1 board relaxes to nothing, and says
   * why, rather than pretending the current tangle is the wander.
   */
  backfilled: number;
}

/**
 * Rung (a). A truthful restore, not an invention: every target is a coordinate
 * the board itself recorded at creation (stage 0's `prov.x0/y0`).
 */
export function relaxSpots(nodes: readonly LoomNode[]): RelaxResult {
  const targets = new Map<string, Spot>();
  let unknown = 0;
  let backfilled = 0;
  for (const n of nodes) {
    const x0 = n.prov.x0;
    const y0 = n.prov.y0;
    if (typeof x0 !== "number" || typeof y0 !== "number") {
      unknown += 1;
      continue;
    }
    if (n.prov.at === null) backfilled += 1;
    if (Math.round(x0) === Math.round(n.x) && Math.round(y0) === Math.round(n.y)) continue;
    targets.set(n.id, { x: Math.round(x0), y: Math.round(y0) });
  }
  return { targets, unknown, backfilled };
}

// ------------------------------------------------------------------- comb ----

/**
 * The run's own axis, by least squares through the card centres — NOT the
 * first→tip heading pull uses. A thread whose ends happen to sit close together
 * still has a direction, and asking the whole run for it is what makes comb
 * read as "straighten what is there" instead of "aim at the tip".
 *
 * The principal angle of the 2×2 covariance: θ = ½·atan2(2·Sxy, Sxx − Syy).
 * The fit has no sign, so the reading direction (root→tip) chooses it.
 */
function principalAxis(nodes: readonly LoomNode[]): { ux: number; uy: number } {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  let mx = 0;
  let my = 0;
  for (const n of nodes) {
    const c = centre(n);
    mx += c.x;
    my += c.y;
  }
  mx /= nodes.length;
  my /= nodes.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const n of nodes) {
    const c = centre(n);
    const dx = c.x - mx;
    const dy = c.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  let ux = 1;
  let uy = 0;
  if (sxx + syy > 1e-6) {
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    ux = Math.cos(theta);
    uy = Math.sin(theta);
  }
  if (first && last) {
    const hx = last.x + last.width / 2 - (first.x + first.width / 2);
    const hy = last.y + last.height / 2 - (first.y + first.height / 2);
    if (ux * hx + uy * hy < 0) {
      ux = -ux;
      uy = -uy;
    }
  }
  return { ux, uy };
}

/**
 * Rung (b). Straighten and space the run, LOCAL and never global:
 *
 *   1. fit the run's own line through its own centroid;
 *   2. drop each card's perpendicular offset (this is the "straighten");
 *   3. walk the run in trail order and push a card forward ONLY if it would
 *      otherwise crowd its predecessor (this is the "space") — a gap that is
 *      already generous is left exactly as the hand left it;
 *   4. re-centre the result on the centroid, so combing a thread twice does not
 *      walk it across the cloth.
 *
 * Every id in the returned map came from `nodes`, so a caller that hands it the
 * selected thread cannot move anything else. That is the brief's constraint,
 * enforced by construction rather than by promise.
 */
export function combSpots(nodes: readonly LoomNode[]): Map<string, Spot> {
  const out = new Map<string, Spot>();
  if (nodes.length < 2) return out;

  const { ux, uy } = principalAxis(nodes);
  let mx = 0;
  let my = 0;
  for (const n of nodes) {
    const c = centre(n);
    mx += c.x;
    my += c.y;
  }
  mx /= nodes.length;
  my /= nodes.length;

  // signed distance along the axis from the centroid; mean is 0 by construction
  const t = nodes.map((n) => {
    const c = centre(n);
    return (c.x - mx) * ux + (c.y - my) * uy;
  });

  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    const before = t[i - 1];
    const here = t[i];
    if (!prev || !cur || before === undefined || here === undefined) continue;
    const minStep = halfExtent(prev, ux, uy) + halfExtent(cur, ux, uy) + COMB_GAP;
    if (here < before + minStep) t[i] = before + minStep;
  }

  let drift = 0;
  for (const v of t) drift += v;
  drift /= t.length;

  nodes.forEach((n, i) => {
    const along = (t[i] ?? 0) - drift;
    out.set(n.id, topLeft({ x: mx + ux * along, y: my + uy * along }, n));
  });
  return out;
}

// ------------------------------------------------------------------- pull ----

/**
 * Wave 1's pull, moved here unchanged in behaviour. An even arc through the
 * run's own centroid, aimed along its own root→tip heading, so a pull reads as
 * *tidying what is there* rather than teleporting it somewhere new.
 */
export function tautSpots(nodes: readonly LoomNode[]): Map<string, Spot> {
  const out = new Map<string, Spot>();
  if (nodes.length < 2) return out;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) return out;

  let ux = last.x + last.width / 2 - (first.x + first.width / 2);
  let uy = last.y + last.height / 2 - (first.y + first.height / 2);
  let span = Math.hypot(ux, uy);
  if (span < 1) {
    ux = 1;
    uy = 0;
    span = 1;
  }
  ux /= span;
  uy /= span;

  let widthSum = 0;
  let cx = 0;
  let cy = 0;
  for (const n of nodes) {
    widthSum += n.width;
    cx += n.x + n.width / 2;
    cy += n.y + n.height / 2;
  }
  cx /= nodes.length;
  cy /= nodes.length;

  const step = Math.max(widthSum / nodes.length + TAUT_GAP, span / (nodes.length - 1));
  const total = step * (nodes.length - 1);
  const startX = cx - (ux * total) / 2;
  const startY = cy - (uy * total) / 2;
  // perpendicular, rotated so the bow rises against the reading direction
  const px = uy;
  const py = -ux;
  const sag = Math.min(SAG_MAX, total * SAG_RATIO);

  nodes.forEach((n, i) => {
    const frac = i / (nodes.length - 1);
    const bow = Math.sin(Math.PI * frac) * sag;
    out.set(n.id, {
      x: Math.round(startX + ux * step * i + px * bow - n.width / 2),
      y: Math.round(startY + uy * step * i + py * bow - n.height / 2),
    });
  });
  return out;
}
