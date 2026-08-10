// beam.ts — THE CLOTH-BEAM TIME MACHINE (wave-3 §3, ideation §9.2).
//
// Temporal compression was deferred because "it needs longitudinal use to
// feel". This is the cheat: provenance stamps `at` on everything, so a debug
// slider can pretend the board is older than it is and let the owner feel a
// six-week-old cloth this afternoon. At 0 the feature does not exist.
//
// THE RULES (all reversible, nothing written):
//   · a card's age runs from its `prov.at` to the SIMULATED now (real now +
//     the slider's offset). A backfilled `at: null` never said when it was
//     born, so it ages exactly as fast as the pretence: its age IS the offset —
//     the unknown board compresses in step with the slider instead of
//     collapsing entirely at +1 day.
//   · compression is per CONNECTED NEIGHBOURHOOD, not per lone card: a region
//     ages with its NEWEST member, so activity anywhere on a thread keeps the
//     whole thread warm, and one old card inside a live wander cannot pock the
//     cloth. Edges of every kind bind a neighbourhood; so does membership in a
//     named thread — and, since wave 4, so does sharing a seal.
//   · cold regions RECEDE, they do not move. Positions never change — this is
//     the anti-auto-sort promise: the beam compacts what exists and invents
//     nothing. The drawing changes only at cloth range (reading surfaces are
//     sacred): ink recedes toward ghost at COLD, and the knot itself shrinks
//     and loses its caption at DEEP.
//
// Rendering is data attributes on the card elements (`data-beam="cold|deep"`);
// styles.css owns what they look like, tiers.ts owns when a card is at cloth
// range. This module owns only the arithmetic.

import type { Board } from "./model";

export interface Beam {
  offsetDays(): number;
  setOffsetDays(days: number): void;
  destroy(): void;
}

export interface BeamOptions {
  board: Board;
  getCardEl: (nodeId: string) => HTMLElement | undefined;
}

const DAY_MS = 86_400_000;
/** two weeks untouched: the ink recedes */
export const COLD_DAYS = 14;
/** six weeks untouched: the knot compresses and goes mute */
export const DEEP_DAYS = 45;

export function createBeam(options: BeamOptions): Beam {
  const { board } = options;
  let days = 0;

  // ---- neighbourhoods (union–find over cards) ------------------------------

  function paint(): void {
    if (days <= 0) {
      for (const n of board.nodes()) options.getCardEl(n.id)?.removeAttribute("data-beam");
      return;
    }
    const simNow = Date.now() + days * DAY_MS;

    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let x = a;
      while ((parent.get(x) ?? x) !== x) x = parent.get(x) ?? x;
      parent.set(a, x);
      return x;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    // edges bind (they already live on card roots), and so does sharing a
    // named thread — a membership is a neighbourhood even where a deletion
    // took the connecting edges with it
    for (const e of board.edges()) union(e.from, e.to);
    for (const t of board.threads()) {
      for (let i = 1; i < t.nodeIds.length; i += 1) {
        const a = t.nodeIds[i - 1];
        const b = t.nodeIds[i];
        if (a !== undefined && b !== undefined) union(a, b);
      }
    }
    // a shared seal binds too (wave-4 §2): the whole reason the species exists
    // is to keep distant cards warm together without an edge, and a lens that
    // let one member of a live seal group go cold would un-say that
    const sealHead = new Map<string, string>();
    for (const s of board.seals()) {
      const head = sealHead.get(s.glyph);
      if (head === undefined) sealHead.set(s.glyph, s.nodeId);
      else union(head, s.nodeId);
    }

    // a region is as young as its newest member; every placement counts
    const youngest = new Map<string, number>();
    const ageOf = (at: string | null): number => {
      if (at === null) return days * DAY_MS; // unknown ages with the pretence
      const t = Date.parse(at);
      return Number.isFinite(t) ? Math.max(0, simNow - t) : days * DAY_MS;
    };
    for (const n of board.nodes()) {
      const key = find(board.contentRoot(n.id));
      const age = ageOf(n.prov.at);
      const held = youngest.get(key);
      if (held === undefined || age < held) youngest.set(key, age);
    }

    for (const n of board.nodes()) {
      const el = options.getCardEl(n.id);
      if (!el) continue;
      const age = youngest.get(find(board.contentRoot(n.id))) ?? 0;
      const level = age >= DEEP_DAYS * DAY_MS ? "deep" : age >= COLD_DAYS * DAY_MS ? "cold" : null;
      if (level === null) el.removeAttribute("data-beam");
      else el.setAttribute("data-beam", level);
    }
  }

  // ages only change when objects (or the pretence) do — never on camera
  // moves. "seals" is a repaint kind because sealing rewires neighbourhoods
  // exactly as threading does (the union pass above reads both).
  const unsubscribe = board.onChange((change) => {
    if (days <= 0) return;
    if (
      change.kind === "graph" ||
      change.kind === "reset" ||
      change.kind === "threads" ||
      change.kind === "seals"
    ) {
      paint();
    }
  });

  return {
    offsetDays: () => days,
    setOffsetDays(next) {
      const clamped = Math.max(0, Math.round(next));
      if (clamped === days) return;
      days = clamped;
      paint();
    },
    destroy() {
      unsubscribe();
      days = 0;
      for (const n of board.nodes()) options.getCardEl(n.id)?.removeAttribute("data-beam");
    },
  };
}
