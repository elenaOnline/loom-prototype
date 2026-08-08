// weave.ts — LIVE AGENT WEAVING (wave-3 §2).
//
// P0 proved the append works; this module makes it visible WHILE IT HAPPENS.
// When the board is bound to a real file (host.bindFile), the file is polled —
// there is no watch API in the browser, and a feel instrument does not need
// one — and anything that appeared in it since we last looked ARRIVES on the
// board live: no reload, no reset, nothing else disturbed.
//
// The merge is APPEND-ONLY BIASED, which is exactly the shape the convention
// file demands of an agent: new nodes, edges, threads, marks and stamps are
// adopted with the ids, provenance and foreign fields the file declared;
// removals and edits of objects this board already holds are conservatively
// ignored (and counted to the console — the convention forbids them, and a
// merge that "helpfully" applied them would let any writer rewrite the board).
//
// ARRIVAL IS GEOMETRY (lace: state is never a tint). An agent-authored card
// (`prov.by === "agent"`) lands as a DASHED plate that settles to solid after a
// beat; a human-authored external arrival (another window, a hand edit) settles
// instantly. Edges simply draw — in file order, which is reading order — and a
// thread the file declares appears in the toolbar like any other.
//
// KNOWN, DISCLOSED RACE: autosave writes the whole file, so an agent append
// that lands between our read and our next write is clobbered for up to one
// poll interval. The poll is deliberately shorter than a human's edit cadence;
// the honest fix (a merge-on-write) is native-build work, not prototype work.
//
// The debug seam (`inject`) runs the same merge on a text handed to it — the
// automation pane cannot grant file handles, and a demo should not need an
// agent on a keyboard. main.ts exposes it as `window.loomWeave`.

import type { Board, BoardSnapshot, LoomNode } from "./model";
import type { Host } from "./host";
import { parse } from "./codec";

export interface Weave {
  /** merge external board text as if the bound file had changed; returns how many objects arrived */
  inject(text: string): number;
  destroy(): void;
}

export interface WeaveOptions {
  board: Board;
  host: Host;
  /** the card layer owns the DOM; arrivals only re-dress it */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  /** fetch a new card's body the way the trail would (trail.hydrate) */
  hydrate: (nodeId: string) => void;
  onStatus?: (text: string) => void;
  pollMs?: number;
}

/** how long an agent's plate stays dashed before it settles to solid */
const SETTLE_MS = 1400;
const ARRIVE_CLASS = "card-arriving";
/** shorter than a human edit cadence; long enough not to churn the tab */
const POLL_MS = 1000;

interface MergeReport {
  nodes: number;
  edges: number;
  threads: string[];
  marks: number;
  glyphs: number;
  /** objects the file changed/dropped that the merge refused to touch */
  ignored: number;
  /** how many of the arriving nodes were agent-authored */
  byAgent: number;
}

export function createWeave(options: WeaveOptions): Weave {
  const { board, host } = options;
  const pollMs = options.pollMs ?? POLL_MS;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- arrival choreography ------------------------------------------------

  const settling = new Map<string, number>();

  function arrive(nodeId: string, agent: boolean): void {
    if (!agent) return; // a human's external edit settles instantly
    // the card layer builds DOM synchronously on the add's change event, so
    // the element exists by now. Applied synchronously, NOT under rAF: a
    // throttled or backgrounded tab starves rAF (the standing harness caveat),
    // and an agent weaving onto a board you are not currently looking at is
    // exactly the backgrounded case — the dash must already be there when you
    // come back, mid-settle or not.
    const el = options.getCardEl(nodeId);
    if (!el) return;
    el.classList.add(ARRIVE_CLASS);
    const old = settling.get(nodeId);
    if (old !== undefined) window.clearTimeout(old);
    settling.set(
      nodeId,
      window.setTimeout(() => {
        settling.delete(nodeId);
        options.getCardEl(nodeId)?.classList.remove(ARRIVE_CLASS);
      }, SETTLE_MS),
    );
  }

  // ---- the merge -----------------------------------------------------------

  function merge(snapshot: Partial<BoardSnapshot>): MergeReport {
    const report: MergeReport = {
      nodes: 0,
      edges: 0,
      threads: [],
      marks: 0,
      glyphs: 0,
      ignored: 0,
      byAgent: 0,
    };

    // Nodes first, roots before facets — `addNode` validates `facetOf` against
    // the board, so a facet arriving alongside its root must queue behind it.
    const incoming = (snapshot.nodes ?? []).filter((n) => !board.node(n.id));
    const ordered: LoomNode[] = [
      ...incoming.filter((n) => n.facetOf === undefined),
      ...incoming.filter((n) => n.facetOf !== undefined),
    ];
    for (const n of ordered) {
      const added = board.addNode({
        id: n.id,
        kind: n.kind,
        ref: n.ref,
        title: n.title,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        ...(n.text === undefined ? {} : { text: n.text }),
        ...(n.facetOf === undefined ? {} : { facetOf: n.facetOf }),
        ...(n.viewAnchor === undefined ? {} : { viewAnchor: n.viewAnchor }),
        ...(n.glyphFile === undefined ? {} : { glyphFile: n.glyphFile }),
        prov: n.prov,
        ...(n.foreign === undefined ? {} : { foreign: n.foreign }),
      });
      report.nodes += 1;
      const agent = n.prov.by === "agent";
      if (agent) report.byAgent += 1;
      arrive(added.id, agent);
      if (added.kind !== "note") options.hydrate(added.id);
    }

    // Edges in file order — reading order, which is the order growth events
    // should fire in. An id collision or an already-present triple dedupes
    // inside addEdge; only genuinely new connections count.
    for (const e of snapshot.edges ?? []) {
      if (board.edge(e.id)) continue;
      if (!board.node(e.from) || !board.node(e.to)) {
        report.ignored += 1;
        continue;
      }
      if (board.findEdge(e.from, e.to, e.kind)) continue;
      const added = board.addEdge(e.from, e.to, e.kind, {
        id: e.id,
        ...(e.label === undefined ? {} : { label: e.label }),
        prov: e.prov,
        ...(e.foreign === undefined ? {} : { foreign: e.foreign }),
      });
      if (added) report.edges += 1;
    }

    // Threads the file declares that this board has never heard of. Membership
    // is taken verbatim (addThread prunes to cards that exist — same rule as
    // load); an existing thread whose entry the file altered is left alone.
    for (const t of snapshot.threads ?? []) {
      if (board.thread(t.id)) continue;
      const added = board.addThread(t.name, t.nodeIds, t.prov, {
        id: t.id,
        ...(t.pinned ? { pinned: true } : {}),
        ...(t.foreign === undefined ? {} : { foreign: t.foreign }),
      });
      if (added.nodeIds.length > 0) report.threads.push(added.name);
    }

    const markIds = new Set(board.marks().map((m) => m.id));
    for (const m of snapshot.marks ?? []) {
      if (markIds.has(m.id)) continue;
      if (!board.node(m.nodeId)) {
        report.ignored += 1;
        continue;
      }
      board.addMark({
        id: m.id,
        nodeId: m.nodeId,
        quote: m.quote,
        kind: m.kind,
        ...(m.noteNodeId === undefined ? {} : { noteNodeId: m.noteNodeId }),
        ...(m.foreign === undefined ? {} : { foreign: m.foreign }),
      });
      report.marks += 1;
    }

    const stampIds = new Set(board.glyphs().map((g) => g.id));
    for (const g of snapshot.glyphs ?? []) {
      if (stampIds.has(g.id)) continue;
      board.addGlyph({
        id: g.id,
        glyph: g.glyph,
        nodeId: g.nodeId,
        quote: g.quote,
        prov: g.prov,
        ...(g.foreign === undefined ? {} : { foreign: g.foreign }),
      });
      report.glyphs += 1;
    }

    // The append-only audit: anything of ours the file no longer carries is a
    // removal the convention forbids. Counted, said once, never applied.
    const fileNodes = new Set((snapshot.nodes ?? []).map((n) => n.id));
    const dropped = board.nodes().filter((n) => !fileNodes.has(n.id)).length - report.nodes;
    if (dropped > 0) {
      report.ignored += dropped;
      console.info(
        `weave: the file dropped or moved ${dropped} object(s) this board holds — append-only merge keeps them`,
      );
    }
    return report;
  }

  function apply(text: string, via: "file" | "inject"): number {
    const snapshot = parse(text);
    if (!snapshot) {
      status(`external ${via === "file" ? "change" : "text"} is not readable JSON Canvas — ignored`);
      return 0;
    }
    const r = merge(snapshot);
    const total = r.nodes + r.edges + r.threads.length + r.marks + r.glyphs;
    if (total === 0) {
      if (r.ignored > 0) status("the file changed, but nothing new arrived (edits/removals are ignored)");
      return 0;
    }
    const who = r.byAgent > 0 ? "an agent wove" : "the board grew outside this window —";
    const bits = [
      r.nodes > 0 ? `${r.nodes} card${r.nodes === 1 ? "" : "s"}` : "",
      r.edges > 0 ? `${r.edges} edge${r.edges === 1 ? "" : "s"}` : "",
      ...r.threads.map((name) => `thread "${name}"`),
      r.glyphs > 0 ? `${r.glyphs} stamp${r.glyphs === 1 ? "" : "s"}` : "",
      r.marks > 0 ? `${r.marks} mark${r.marks === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    status(`${who} ${bits.join(" · ")}`);
    return total;
  }

  // ---- the poll ------------------------------------------------------------
  // `File.lastModified` off the bound handle is the whole watch mechanism. The
  // first look after a bind is a BASELINE, never a merge — the bind itself came
  // from a save or an open, so the file at that moment IS the board. Our own
  // autosaves bump the mtime too; those parse to a no-op diff and cost nothing.

  let lastModified = 0;
  let checking = false;

  async function check(): Promise<void> {
    if (checking) return;
    const handle = host.boundHandle();
    if (!handle) {
      lastModified = 0;
      return;
    }
    checking = true;
    try {
      const file = await handle.getFile();
      if (file.lastModified !== lastModified) {
        const baseline = lastModified === 0;
        lastModified = file.lastModified;
        if (!baseline) apply(await file.text(), "file");
      }
    } catch {
      // permission withdrawn or file gone — autosave surfaces that; stay quiet
    } finally {
      checking = false;
    }
  }

  const timer = window.setInterval(() => void check(), pollMs);

  return {
    inject: (text) => apply(text, "inject"),
    destroy() {
      window.clearInterval(timer);
      for (const t of settling.values()) window.clearTimeout(t);
      settling.clear();
    },
  };
}
