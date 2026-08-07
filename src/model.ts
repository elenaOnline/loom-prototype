// model.ts — the board: types, state, mutation API, change events.
//
// Single source of truth (ARCHITECTURE.md). Views (cards, edges, ui) never hold
// their own copy of graph state; they subscribe to `onChange` and reconcile.
// Mutations are small and named so a change event can say *what kind* of change
// happened — the edge layer only redraws on graph/position, never on content.
//
// Node.html is deliberately transient: fetched article/markdown bodies are
// re-hydrated from the provider on load, never written into board.canvas.

export type TopologyMode = "duplicate" | "linkback" | "returnedge";
export type ContentMode = "wiki" | "folder";
export type NodeKind = "wiki" | "doc" | "note";
/** tether: the ghost hairline that holds a note to the words it is about */
export type EdgeKind = "trail" | "manual" | "return" | "tether";
export type LoadStatus = "idle" | "loading" | "ready" | "error";

export const TOPOLOGY_MODES: readonly TopologyMode[] = [
  "duplicate",
  "linkback",
  "returnedge",
];

export type ProvBy = "human" | "agent";
export type ProvHow = "wander" | "place" | "capture" | "mark" | "reply";

export const PROV_BY: readonly ProvBy[] = ["human", "agent"];
export const PROV_HOW: readonly ProvHow[] = ["wander", "place", "capture", "mark", "reply"];

/**
 * The provenance substrate (wave-2 brief §0). Every node, every edge and every
 * thread carries one; it is written at creation and preserved verbatim through
 * load/save. It cannot be retrofitted — a board that did not record how a card
 * arrived can never be asked later — so it is spec'd before any lens reads it.
 *
 * `x0/y0` are the world coordinates the object was BORN at (nodes only). They
 * are what makes the "relax" verb possible: pull-taut and hand-drags move a
 * card away from where the wander put it, and relax puts it back. Recording
 * them costs two numbers; reconstructing them later costs the whole history.
 *
 * The index signature is deliberate: an agent (or a later wave) may write keys
 * this build does not know, and losing them on the next autosave would break
 * the additive-schema promise.
 */
export interface Prov {
  /** ISO-8601 UTC, second precision. `null` = backfilled: creation time unknown */
  at: string | null;
  by: ProvBy;
  how: ProvHow;
  /** spawned-from: trail parent, marked card, anchor of a reply — else null */
  from: string | null;
  /** external origin: the href actually followed, a file path — else null */
  src: string | null;
  /** world x at creation (nodes only) */
  x0?: number;
  /** world y at creation (nodes only) */
  y0?: number;
  [key: string]: unknown;
}

/** what a creation site supplies; everything unsaid takes a default */
export type ProvSeed = Partial<Prov>;

const PROV_KNOWN_KEYS = new Set(["at", "by", "how", "from", "src", "x0", "y0"]);

/** ISO-8601 UTC at second precision — the brief's stamp, not JS's millisecond one */
export function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function buildProv(at: string | null, seed: ProvSeed | undefined): Prov {
  const out: Prov = {
    at: seed && seed.at !== undefined ? seed.at : at,
    by: seed?.by ?? "human",
    how: seed?.how ?? "wander",
    from: seed?.from ?? null,
    src: seed?.src ?? null,
  };
  if (seed?.x0 !== undefined) out.x0 = seed.x0;
  if (seed?.y0 !== undefined) out.y0 = seed.y0;
  if (seed) {
    for (const key of Object.keys(seed)) {
      if (!PROV_KNOWN_KEYS.has(key)) out[key] = seed[key];
    }
  }
  return out;
}

/** provenance for something being created RIGHT NOW */
export function makeProv(seed?: ProvSeed): Prov {
  return buildProv(nowStamp(), seed);
}

/**
 * Provenance for something that predates the substrate. `at: null` is the
 * honest answer — the file never said — and is deliberately distinguishable
 * from a real stamp so a later lens can grey out what it does not know.
 */
export function backfillProv(seed?: ProvSeed): Prov {
  return buildProv(null, seed);
}

export function cloneProv(p: Prov): Prov {
  return { ...p };
}

/**
 * Fields the file carried that this build does not model. Replayed verbatim on
 * save so a hand-edit or an agent's extension survives a round trip through the
 * prototype (additive schema discipline, brief §0).
 */
export interface Foreign {
  /** unrecognized top-level keys of the object as it appeared in the file */
  top?: Record<string, unknown>;
  /** unrecognized keys inside the object's `x-powerset` block */
  ext?: Record<string, unknown>;
}

export function cloneForeign(f: Foreign | undefined): Foreign | undefined {
  if (!f) return undefined;
  const out: Foreign = {};
  if (f.top) out.top = { ...f.top };
  if (f.ext) out.ext = { ...f.ext };
  return out.top || out.ext ? out : undefined;
}

export interface LoomNode {
  id: string;
  kind: NodeKind;
  /** identity inside its content mode: wiki title · folder-relative path · "" for notes */
  ref: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** notes only — persisted */
  text?: string;
  /**
   * This card is the RENDERING of a glyph file (`marks/<glyphFile>.md`), not a
   * note somebody wrote: its text is regenerated from the board whenever that
   * glyph's collection changes, and it is therefore not editable in place. The
   * file is still the source of truth — the card is a window onto it.
   */
  glyphFile?: string;
  /** sanitized body HTML — transient, re-fetched on load */
  html?: string;
  status: LoadStatus;
  error?: string;
  /** how this placement came to be — always present (brief §0) */
  prov: Prov;
  foreign?: Foreign;
}

export interface LoomEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  /** how this connection came to be — always present (brief §0) */
  prov: Prov;
  foreign?: Foreign;
}

/**
 * One card a thread was holding when the board let it go. Kept by id AND by the
 * two things that survive the node's deletion — where it sat in the run, and
 * what it was called — because the whole point of a break record is that it can
 * still be READ after the thing it names is gone.
 */
export interface BrokenLink {
  id: string;
  /** its position in the membership at the moment it left */
  index: number;
  /** its title at the moment it left — the only readable trace it leaves */
  title: string;
}

/**
 * A thread whose membership lost cards to an edit (wave-2 §1's hard
 * constraint: **a name never detaches silently**). The board does not quietly
 * shrink the thread and let its name go stale — it records the loss, keeps the
 * name, and every surface that draws the thread draws the break as geometry.
 * Cleared only by an explicit `mendThread`.
 */
export interface ThreadBreak {
  /** when the FIRST loss was noticed; `null` only if the stamp was unreadable */
  at: string | null;
  /** in loss order, not run order */
  missing: BrokenLink[];
}

/**
 * A thread is an ORDERED run of node ids — a line of thought, first-class:
 * nameable, editable, pullable, handable to an agent (ideation §6.6). Order is
 * trail order (root first); it is the order a handoff types.
 *
 * Identity (wave-2 §1, replacing wave-1's exact-run equality): a thread IS its
 * membership. The membership follows the trail's tip as the trail grows — see
 * `growthForEdge` — unless the thread is `pinned`, which freezes it.
 */
export interface Thread {
  id: string;
  name: string;
  nodeIds: string[];
  /**
   * Frozen: this thread no longer follows its tip. Written to the file only
   * when true, so an unpinned thread's entry is byte-identical to wave 1's.
   */
  pinned?: boolean;
  /** set when an edit orphaned part of the membership; never cleared silently */
  broken?: ThreadBreak;
  /**
   * A thread entry has no `x-powerset` block to nest provenance inside — the
   * whole thread list already lives in one. So `prov` sits at the TOP LEVEL of
   * the entry (P0 convention gap #1, closed here). Readers also accept the
   * nested `x-powerset.prov` the P0 agent invented, and rewrite it to this spot.
   */
  prov: Prov;
  foreign?: Foreign;
}

/**
 * A fiber: the atomic mark. Anchored by the QUOTED TEXT it was taken from
 * (first occurrence), never by an offset — a body is re-fetched and re-rendered
 * constantly, and a quote survives that where an index does not.
 */
export interface Mark {
  id: string;
  nodeId: string;
  quote: string;
  kind: "highlight" | "note";
  noteNodeId?: string;
  /**
   * Marks are NOT given a `prov` field by this stage (the brief scopes §0 to
   * nodes, edges and thread entries) — but any `prov` a file carries on a mark
   * rides here verbatim and survives the round trip, so the glyph stage can
   * start writing one without a format change.
   */
  foreign?: Record<string, unknown>;
}

export interface MarkSpec {
  nodeId: string;
  quote: string;
  kind: "highlight" | "note";
  noteNodeId?: string;
  foreign?: Record<string, unknown>;
  /** only for load(): keep the id from the file */
  id?: string;
}

/**
 * A GLYPH: one mark in the meaning-thread palette (wave-2 §2, ideation §7.6).
 *
 * A trail records *movement* — where attention went. A glyph records *meaning* —
 * a thought that recurs in several places. Same substrate, second species: you
 * stamp the same glyph on a passage in card A, another in card B, a third back
 * in A, and the glyph accrues its own collection across the cloth.
 *
 * `name` is the file name (`marks/<name>.md`) as well as the identity, so it is
 * lower-case and filename-safe; `char` is the drawn form. Geometry only — the
 * palette carries no color role of its own beyond ink.
 */
export interface Glyph {
  name: string;
  char: string;
}

/** exactly five (the brief's cap). Filled/open pairs, plus the asterisk. */
export const GLYPH_PALETTE: readonly Glyph[] = [
  { name: "dot", char: "●" },
  { name: "ring", char: "○" },
  { name: "lozenge", char: "◆" },
  { name: "prism", char: "◇" },
  { name: "star", char: "✳" },
];

export function isPaletteGlyph(name: string): boolean {
  return GLYPH_PALETTE.some((g) => g.name === name);
}

/**
 * The drawn form of a glyph name. A file may carry a glyph this build's palette
 * does not offer (additive schema discipline — a later wave, a hand edit, an
 * agent); it is NOT coerced into one of the five, it simply draws as its own
 * initial. Losing it would be the one un-additive thing in the codec.
 */
export function glyphChar(name: string): string {
  const found = GLYPH_PALETTE.find((g) => g.name === name);
  if (found) return found.char;
  return name.slice(0, 1).toUpperCase() || "?";
}

/**
 * One stamp: this glyph, on this passage, on this card. Anchored by quoted text
 * exactly as a fiber mark is (see `quotes.ts`) — a stamp is a location, not a
 * highlight, and it carries no note of its own.
 */
export interface GlyphStamp {
  id: string;
  /** palette name, or a foreign one the file carried — never coerced */
  glyph: string;
  nodeId: string;
  quote: string;
  /** the brief's §0 substrate: a stamp is `how: "mark"` */
  prov: Prov;
  foreign?: Record<string, unknown>;
}

export interface GlyphSpec {
  glyph: string;
  nodeId: string;
  quote: string;
  prov?: ProvSeed;
  foreign?: Record<string, unknown>;
  /** only for load(): keep the id from the file */
  id?: string;
}

export interface BoardSnapshot {
  nodes: LoomNode[];
  edges: LoomEdge[];
  threads: Thread[];
  marks: Mark[];
  glyphs: GlyphStamp[];
  topologyMode: TopologyMode;
  contentMode: ContentMode;
  folderName?: string;
  /** unknown top-level / board-level `x-powerset` keys, carried verbatim */
  foreign?: Foreign;
}

/**
 * What changed. `graph` = nodes/edges added or removed · `position` = a node
 * moved or resized · `content` = title/body/status · `meta` = modes ·
 * `threads` = the named-thread list · `marks` = the fibers on a card ·
 * `glyphs` = the meaning-mark stamps · `reset` = the whole board was replaced.
 */
export type ChangeKind =
  | "graph"
  | "position"
  | "content"
  | "meta"
  | "threads"
  | "marks"
  | "glyphs"
  | "reset";

export interface Change {
  kind: ChangeKind;
  nodeIds?: string[];
  edgeIds?: string[];
}

export type ChangeListener = (change: Change) => void;

export interface NodeSpec {
  kind: NodeKind;
  ref?: string;
  title: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  /** this card renders `marks/<glyphFile>.md` (wave-2 §2) */
  glyphFile?: string;
  html?: string;
  status?: LoadStatus;
  /** who/how/why — anything unsaid defaults to human · wander · now */
  prov?: ProvSeed;
  foreign?: Foreign;
  /** only for load(): keep the id from the file */
  id?: string;
}

/** everything an edge needs beyond its two ends and its kind */
export interface EdgeSpec {
  label?: string;
  prov?: ProvSeed;
  foreign?: Foreign;
}

export const DEFAULT_CARD_W = 380;
export const DEFAULT_CARD_H = 460;

export interface Board {
  nodes(): LoomNode[];
  edges(): LoomEdge[];
  threads(): Thread[];
  marks(): Mark[];
  /** every meaning-mark stamp on the board, in stamp order */
  glyphs(): GlyphStamp[];
  node(id: string): LoomNode | undefined;
  edge(id: string): LoomEdge | undefined;
  thread(id: string): Thread | undefined;
  /** the fibers seam: everything marked on one card, in creation order */
  marksOf(nodeId: string): Mark[];
  /** every glyph stamped on one card, in stamp order */
  glyphsOf(nodeId: string): GlyphStamp[];
  /** one glyph's whole collection — the thing `marks/<glyph>.md` is written from */
  stampsOf(glyph: string): GlyphStamp[];
  /** the placed card for a ref, if any — the topology toggle's "already here?" */
  findByRef(kind: NodeKind, ref: string): LoomNode | undefined;
  findEdge(from: string, to: string, kind: EdgeKind): LoomEdge | undefined;
  edgesOf(nodeId: string): LoomEdge[];

  addNode(spec: NodeSpec): LoomNode;
  /** removes the PLACEMENT: the node and its incident edges leave the board */
  removeNode(id: string): void;
  moveNode(id: string, x: number, y: number): void;
  sizeNode(id: string, width: number, height: number): void;
  setContent(
    id: string,
    patch: { title?: string; html?: string; text?: string; status?: LoadStatus; error?: string },
  ): void;

  addEdge(from: string, to: string, kind: EdgeKind, spec?: EdgeSpec): LoomEdge | undefined;
  removeEdge(id: string): void;

  /** keep a fiber: the quote stays with the card, and rides a thread handoff */
  addMark(spec: MarkSpec): Mark;
  removeMark(id: string): void;

  /** stamp a glyph on a passage — at highlight speed, no dialog, no naming */
  addGlyph(spec: GlyphSpec): GlyphStamp;
  removeGlyph(id: string): void;

  /** name a run of nodes — the moment a trail becomes an object you can keep */
  addThread(name: string, nodeIds: string[], prov?: ProvSeed): Thread;
  renameThread(id: string, name: string): void;
  setThreadNodes(id: string, nodeIds: string[]): void;
  /** PIN: freeze membership — a pinned thread stops following its tip */
  setThreadPinned(id: string, pinned: boolean): void;
  /** acknowledge a break: the record goes, the surviving membership stays */
  mendThread(id: string): void;
  removeThread(id: string): void;

  topologyMode(): TopologyMode;
  setTopologyMode(mode: TopologyMode): void;
  contentMode(): ContentMode;
  setContentMode(mode: ContentMode): void;
  folderName(): string | undefined;
  setFolderName(name: string | undefined): void;

  snapshot(): BoardSnapshot;
  load(snapshot: Partial<BoardSnapshot>): void;
  clear(): void;

  onChange(cb: ChangeListener): () => void;
}

let idCounter = 0;

export function freshId(prefix: string): string {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x10000).toString(36);
  return `${prefix}${stamp}${idCounter.toString(36)}${rand}`;
}

/**
 * The branch predicate. `edges()` is insertion-ordered, so the FIRST trail edge
 * a card ever spawned continues its line and every later one starts a branch
 * (the same reading of "primary" threads.ts walks by). Returned: the ids of the
 * trail edges that are branch starts — a revisit is not a branch, so returns,
 * manual edges and tethers never count, on either side of the test.
 */
export function branchStartEdgeIds(edges: readonly LoomEdge[]): Set<string> {
  const spawned = new Set<string>();
  const out = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "trail") continue;
    if (spawned.has(e.from)) out.add(e.id);
    else spawned.add(e.from);
  }
  return out;
}

/** a named thread following its tip: which thread grows, and to what */
export interface ThreadGrowth {
  threadId: string;
  /** the node joining the membership */
  nodeId: string;
  /** which end of the thread it joined */
  end: "tip" | "root";
  /** the membership the thread should now hold */
  nodeIds: string[];
}

/**
 * TIP-TRACKING (wave-2 §1). Wave 1 identified a thread by exact-run equality,
 * so a named 4-card thread lost its name the instant the trail grew by one
 * spawn (FINDINGS Q2). The replacement: a named thread FOLLOWS ITS TIP.
 *
 * This is an EVENT rule, not a matching rule, and that distinction is the whole
 * design. Membership changes when the board watches a trail edge appear at one
 * of a thread's two ends — never as a side effect of loading a file. So a
 * thread declared in a file (an agent's reply, a hand edit) keeps exactly the
 * membership it declared, and only what happens *next*, in front of the user,
 * can extend it. Additive-schema discipline applied to threads.
 *
 * The three cases, all from one reading of "primary" that `branchStartEdgeIds`
 * and `threads.ts`'s walk already share — insertion order is the spine:
 *
 *   - the new edge leaves the thread's TIP and is that tip's FIRST outgoing
 *     trail edge → the line continued; the thread extends.
 *   - the new edge leaves the tip but the tip already spawned once → this is a
 *     BRANCH. The name stays with the spine; the branch is born unnamed.
 *   - the new edge arrives at the thread's ROOT and is that root's FIRST
 *     incoming trail edge → the trail grew from the other endpoint (the brief
 *     says growth from *either* endpoint extends), so the thread extends
 *     upstream. In practice this is the shape an agent's anchor edge takes.
 *
 * A pinned thread never grows. Neither does one that already holds the node
 * (a revisit is not new membership — and `return` edges are not trail edges,
 * so a return never grows a thread at all).
 */
export function growthForEdge(
  threads: readonly Thread[],
  edges: readonly LoomEdge[],
  edge: LoomEdge,
): ThreadGrowth[] {
  if (edge.kind !== "trail") return [];
  const firstOut = edges.find((e) => e.kind === "trail" && e.from === edge.from);
  const firstIn = edges.find((e) => e.kind === "trail" && e.to === edge.to);
  const out: ThreadGrowth[] = [];
  for (const t of threads) {
    if (t.pinned) continue;
    if (t.nodeIds.length === 0) continue;
    const tip = t.nodeIds[t.nodeIds.length - 1];
    const root = t.nodeIds[0];
    if (edge.from === tip && firstOut?.id === edge.id && !t.nodeIds.includes(edge.to)) {
      out.push({ threadId: t.id, nodeId: edge.to, end: "tip", nodeIds: [...t.nodeIds, edge.to] });
      continue;
    }
    if (edge.to === root && firstIn?.id === edge.id && !t.nodeIds.includes(edge.from)) {
      out.push({
        threadId: t.id,
        nodeId: edge.from,
        end: "root",
        nodeIds: [edge.from, ...t.nodeIds],
      });
    }
  }
  return out;
}

/** two runs are the same run: same ids, same order */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** the start index of `member` inside `run` as a CONTIGUOUS block, or -1 */
function blockStart(run: readonly string[], member: readonly string[]): number {
  if (member.length === 0 || member.length > run.length) return -1;
  for (let i = 0; i + member.length <= run.length; i += 1) {
    let hit = true;
    for (let j = 0; j < member.length; j += 1) {
      if (run[i + j] !== member[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** every id of `member`, in order, somewhere in `run` — gaps allowed */
function isSubsequence(run: readonly string[], member: readonly string[]): boolean {
  if (member.length === 0) return false;
  let i = 0;
  for (const id of run) {
    if (id === member[i]) i += 1;
    if (i === member.length) return true;
  }
  return false;
}

function adjacentIn(ids: readonly string[], from: string, to: string): boolean {
  const i = ids.indexOf(from);
  return i >= 0 && ids[i + 1] === to;
}

/**
 * RESOLUTION (wave-2 §1): which stored thread did this walked run just grab?
 *
 * Wave 1 asked for exact-run equality, and a name detached the moment the trail
 * grew by one card (FINDINGS Q2, observed live on the owner's board). The rule
 * here is CONTAINMENT, in two tiers.
 *
 * Tier 1 — the membership appears in the run as a CONTIGUOUS block. This is
 * what resolves the **P0 anchor-edge case** (FINDINGS "P0", convention gap 3),
 * and it is the reason the rule is containment and not "extend to fit": the P0
 * agent declared a 6-card reply and anchored it with a trail edge from the
 * owner's own margin note, so the walk yields 7 cards and no equality test can
 * ever match. Containment matches the declared 6 — the name resolves, the
 * agent's declaration is left exactly as written (we do not annex a human's
 * note into an agent's thread merely because the walk passed through it), and
 * the anchor stays visible as what it is: the card the reply hangs from.
 *
 * Tier 2 — a BROKEN thread's survivors appear in the run in order, with gaps.
 * A card deleted mid-thread splits the membership; without this tier the name
 * would read "unnamed" again, which is precisely the silent detach the brief
 * forbids. The name comes back marked broken instead, and the missing step
 * draws as a hole in the weave (no edge spans the gap).
 *
 * Ties: an exact match first, then a thread that HOLDS the clicked edge, then
 * the longer claim. A one-card thread can only match a one-card run — it would
 * otherwise claim every run it appears in.
 */
export function resolveThreadForRun(
  threads: readonly Thread[],
  run: readonly string[],
  edge?: { from: string; to: string },
): Thread | undefined {
  let best: Thread | undefined;
  let bestScore = -1;
  for (const t of threads) {
    if (t.nodeIds.length < 2 && t.nodeIds.length !== run.length) continue;
    const contiguous = blockStart(run, t.nodeIds) >= 0;
    const scattered = !contiguous && t.broken !== undefined && isSubsequence(run, t.nodeIds);
    if (!contiguous && !scattered) continue;
    const score =
      (contiguous ? 4000 : 0) +
      (sameOrder(t.nodeIds, run) ? 2000 : 0) +
      (edge && adjacentIn(t.nodeIds, edge.from, edge.to) ? 1000 : 0) +
      t.nodeIds.length;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** refs compare case-insensitively with collapsed whitespace/underscores */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
}

export function createBoard(initial?: Partial<BoardSnapshot>): Board {
  const nodes = new Map<string, LoomNode>();
  const edges = new Map<string, LoomEdge>();
  let threads: Thread[] = [];
  let marks: Mark[] = [];
  let stamps: GlyphStamp[] = [];
  let topology: TopologyMode = "returnedge";
  let content: ContentMode = "wiki";
  let folder: string | undefined;
  let boardForeign: Foreign | undefined;

  const listeners = new Set<ChangeListener>();

  function emit(change: Change): void {
    for (const cb of Array.from(listeners)) cb(change);
  }

  function makeNode(spec: NodeSpec): LoomNode {
    // Every card records where it was BORN, whatever the creation site said —
    // a spawn site that forgets x0/y0 would silently un-build the relax verb.
    const seed: ProvSeed = { ...(spec.prov ?? {}) };
    if (seed.x0 === undefined) seed.x0 = spec.x;
    if (seed.y0 === undefined) seed.y0 = spec.y;
    const node: LoomNode = {
      id: spec.id ?? freshId("n"),
      kind: spec.kind,
      ref: spec.ref ?? "",
      title: spec.title,
      x: spec.x,
      y: spec.y,
      width: spec.width ?? DEFAULT_CARD_W,
      height: spec.height ?? DEFAULT_CARD_H,
      ...(spec.text === undefined ? {} : { text: spec.text }),
      ...(spec.glyphFile === undefined ? {} : { glyphFile: spec.glyphFile }),
      ...(spec.html === undefined ? {} : { html: spec.html }),
      status: spec.status ?? "idle",
      prov: makeProv(seed),
    };
    const foreign = cloneForeign(spec.foreign);
    if (foreign) node.foreign = foreign;
    return node;
  }

  /**
   * The load-path safety net. `load()` takes whatever a caller hands it, and a
   * node without provenance would be a hole the rest of wave 2 reads through —
   * so anything arriving bare is backfilled to human · wander · at-unknown,
   * with its CURRENT position standing in for where it was born.
   */
  function adoptNode(n: LoomNode): LoomNode {
    const out: LoomNode = { ...n };
    out.prov = n.prov
      ? cloneProv(n.prov)
      : backfillProv({ by: "human", how: "wander", x0: n.x, y0: n.y });
    if (out.prov.x0 === undefined) out.prov.x0 = n.x;
    if (out.prov.y0 === undefined) out.prov.y0 = n.y;
    const foreign = cloneForeign(n.foreign);
    if (foreign) out.foreign = foreign;
    else delete out.foreign;
    return out;
  }

  function adoptEdge(e: LoomEdge): LoomEdge {
    const out: LoomEdge = { ...e };
    out.prov = e.prov ? cloneProv(e.prov) : backfillProv({ by: "human", how: "wander" });
    const foreign = cloneForeign(e.foreign);
    if (foreign) out.foreign = foreign;
    else delete out.foreign;
    return out;
  }

  /** a stamp arriving bare (a hand edit, an older file) takes the §0 backfill */
  function adoptGlyph(g: GlyphStamp): GlyphStamp {
    const out: GlyphStamp = { ...g };
    out.prov = g.prov ? cloneProv(g.prov) : backfillProv({ by: "human", how: "mark", from: g.nodeId });
    if (g.foreign) out.foreign = { ...g.foreign };
    else delete out.foreign;
    return out;
  }

  function adoptThread(t: Thread): Thread {
    const out: Thread = { ...t, nodeIds: t.nodeIds.slice() };
    // the brief's backfill shape is uniform: human · wander · at-unknown, even
    // for a thread, which is never literally wandered into being
    out.prov = t.prov ? cloneProv(t.prov) : backfillProv({ by: "human", how: "wander" });
    if (t.pinned) out.pinned = true;
    else delete out.pinned;
    if (t.broken && t.broken.missing.length > 0) {
      out.broken = { at: t.broken.at, missing: t.broken.missing.map((m) => ({ ...m })) };
    } else delete out.broken;
    const foreign = cloneForeign(t.foreign);
    if (foreign) out.foreign = foreign;
    else delete out.foreign;
    return out;
  }

  const board: Board = {
    nodes: () => Array.from(nodes.values()),
    edges: () => Array.from(edges.values()),
    threads: () => threads.slice(),
    marks: () => marks.slice(),
    glyphs: () => stamps.slice(),
    node: (id) => nodes.get(id),
    edge: (id) => edges.get(id),
    thread: (id) => threads.find((t) => t.id === id),
    marksOf: (nodeId) => marks.filter((m) => m.nodeId === nodeId),
    glyphsOf: (nodeId) => stamps.filter((g) => g.nodeId === nodeId),
    stampsOf: (glyph) => stamps.filter((g) => g.glyph === glyph),

    findByRef(kind, ref) {
      if (!ref) return undefined;
      const want = normalizeRef(ref);
      for (const n of nodes.values()) {
        if (n.kind === kind && normalizeRef(n.ref) === want) return n;
      }
      return undefined;
    },

    findEdge(from, to, kind) {
      for (const e of edges.values()) {
        if (e.from === from && e.to === to && e.kind === kind) return e;
      }
      return undefined;
    },

    edgesOf(nodeId) {
      const out: LoomEdge[] = [];
      for (const e of edges.values()) {
        if (e.from === nodeId || e.to === nodeId) out.push(e);
      }
      return out;
    },

    addNode(spec) {
      const node = makeNode(spec);
      nodes.set(node.id, node);
      emit({ kind: "graph", nodeIds: [node.id] });
      return node;
    },

    removeNode(id) {
      const gone = nodes.get(id);
      if (!gone) return;
      nodes.delete(id);
      const dropped: string[] = [];
      for (const e of Array.from(edges.values())) {
        if (e.from === id || e.to === id) {
          edges.delete(e.id);
          dropped.push(e.id);
        }
      }
      // A note card is half of a mark, so unpinning it takes the mark with it —
      // otherwise the source card keeps drawing an underline that leads nowhere.
      marks = marks.filter((m) => m.nodeId !== id && m.noteNodeId !== id);
      // A glyph stamp is a LOCATION, and the location has gone. Unlike a thread
      // (an ordered line whose name must survive a hole — see below), a glyph is
      // an unordered set: losing one of its places leaves the rest of the
      // collection meaning exactly what it meant, so the stamp just goes and the
      // glyph file regenerates one entry shorter. No break record to keep.
      stamps = stamps.filter((g) => g.nodeId !== id);
      // A thread, though, does NOT quietly shrink. Wave-2 §1's hard constraint
      // is that a name never detaches silently, and wave 1 broke it twice over:
      // the membership shrank (so the name stopped matching the run) and a
      // thread that lost its last card was deleted outright — a name vanishing
      // with no trace is the loudest silent detach there is. Now the loss is
      // RECORDED, the name is kept, and every surface draws the break.
      threads = threads.map((t) => {
        const index = t.nodeIds.indexOf(id);
        if (index < 0) return t;
        const lost: BrokenLink = { id, index, title: gone.title };
        return {
          ...t,
          nodeIds: t.nodeIds.filter((n) => n !== id),
          broken: {
            at: t.broken?.at ?? nowStamp(),
            missing: [...(t.broken?.missing ?? []), lost],
          },
        };
      });
      emit({ kind: "graph", nodeIds: [id], edgeIds: dropped });
    },

    moveNode(id, x, y) {
      const n = nodes.get(id);
      if (!n || (n.x === x && n.y === y)) return;
      n.x = x;
      n.y = y;
      emit({ kind: "position", nodeIds: [id] });
    },

    sizeNode(id, width, height) {
      const n = nodes.get(id);
      if (!n || (n.width === width && n.height === height)) return;
      n.width = Math.max(120, width);
      n.height = Math.max(80, height);
      emit({ kind: "position", nodeIds: [id] });
    },

    setContent(id, patch) {
      const n = nodes.get(id);
      if (!n) return;
      if (patch.title !== undefined) n.title = patch.title;
      if (patch.html !== undefined) n.html = patch.html;
      if (patch.text !== undefined) n.text = patch.text;
      if (patch.status !== undefined) n.status = patch.status;
      if (patch.error !== undefined) n.error = patch.error;
      else if (patch.status === "ready" || patch.status === "loading") delete n.error;
      emit({ kind: "content", nodeIds: [id] });
    },

    addEdge(from, to, kind, spec) {
      if (from === to) return undefined;
      if (!nodes.has(from) || !nodes.has(to)) return undefined;
      const existing = board.findEdge(from, to, kind);
      if (existing) return existing;
      const edge: LoomEdge = {
        id: freshId("e"),
        from,
        to,
        kind,
        ...(spec?.label === undefined ? {} : { label: spec.label }),
        // an edge with no stated parent came from its own source card
        prov: makeProv({ from, ...(spec?.prov ?? {}) }),
      };
      const foreign = cloneForeign(spec?.foreign);
      if (foreign) edge.foreign = foreign;
      edges.set(edge.id, edge);
      emit({ kind: "graph", edgeIds: [edge.id] });
      return edge;
    },

    removeEdge(id) {
      if (!edges.delete(id)) return;
      emit({ kind: "graph", edgeIds: [id] });
    },

    addMark(spec) {
      const mark: Mark = {
        id: spec.id ?? freshId("m"),
        nodeId: spec.nodeId,
        quote: spec.quote,
        kind: spec.kind,
        ...(spec.noteNodeId === undefined ? {} : { noteNodeId: spec.noteNodeId }),
        ...(spec.foreign === undefined ? {} : { foreign: { ...spec.foreign } }),
      };
      marks = [...marks, mark];
      emit({ kind: "marks", nodeIds: [mark.nodeId] });
      return mark;
    },

    removeMark(id) {
      const gone = marks.find((m) => m.id === id);
      if (!gone) return;
      marks = marks.filter((m) => m.id !== id);
      emit({ kind: "marks", nodeIds: [gone.nodeId] });
    },

    addGlyph(spec) {
      const stamp: GlyphStamp = {
        id: spec.id ?? freshId("g"),
        glyph: spec.glyph,
        nodeId: spec.nodeId,
        quote: spec.quote,
        // a stamp is the brief's `mark` verb, and it came from the card it is on
        prov: makeProv({ how: "mark", from: spec.nodeId, src: null, ...(spec.prov ?? {}) }),
        ...(spec.foreign === undefined ? {} : { foreign: { ...spec.foreign } }),
      };
      stamps = [...stamps, stamp];
      emit({ kind: "glyphs", nodeIds: [stamp.nodeId] });
      return stamp;
    },

    removeGlyph(id) {
      const gone = stamps.find((g) => g.id === id);
      if (!gone) return;
      stamps = stamps.filter((g) => g.id !== id);
      emit({ kind: "glyphs", nodeIds: [gone.nodeId] });
    },

    addThread(name, nodeIds, prov) {
      const kept = nodeIds.filter((id) => nodes.has(id));
      const thread: Thread = {
        id: freshId("t"),
        name,
        // a thread only ever holds placements that exist, in the order given
        nodeIds: kept,
        // a named thread is a run CAPTURED — from = the run's root
        prov: makeProv({ how: "capture", from: kept[0] ?? null, ...(prov ?? {}) }),
      };
      threads = [...threads, thread];
      emit({ kind: "threads" });
      return thread;
    },

    renameThread(id, name) {
      let hit = false;
      threads = threads.map((t) => {
        if (t.id !== id || t.name === name) return t;
        hit = true;
        return { ...t, name };
      });
      if (hit) emit({ kind: "threads" });
    },

    setThreadNodes(id, nodeIds) {
      let hit = false;
      threads = threads.map((t) => {
        if (t.id !== id) return t;
        const kept = nodeIds.filter((n) => nodes.has(n));
        if (kept.length === t.nodeIds.length && kept.every((n, i) => n === t.nodeIds[i])) return t;
        hit = true;
        return { ...t, nodeIds: kept };
      });
      if (hit) emit({ kind: "threads" });
    },

    setThreadPinned(id, pinned) {
      let hit = false;
      threads = threads.map((t) => {
        if (t.id !== id || (t.pinned ?? false) === pinned) return t;
        hit = true;
        const next: Thread = { ...t };
        if (pinned) next.pinned = true;
        else delete next.pinned;
        return next;
      });
      if (hit) emit({ kind: "threads" });
    },

    mendThread(id) {
      let hit = false;
      threads = threads.map((t) => {
        if (t.id !== id || !t.broken) return t;
        hit = true;
        const next: Thread = { ...t };
        delete next.broken;
        return next;
      });
      if (hit) emit({ kind: "threads" });
    },

    removeThread(id) {
      const next = threads.filter((t) => t.id !== id);
      if (next.length === threads.length) return;
      threads = next;
      emit({ kind: "threads" });
    },

    topologyMode: () => topology,
    setTopologyMode(mode) {
      if (topology === mode) return;
      topology = mode;
      emit({ kind: "meta" });
    },
    contentMode: () => content,
    setContentMode(mode) {
      if (content === mode) return;
      content = mode;
      emit({ kind: "meta" });
    },
    folderName: () => folder,
    setFolderName(name) {
      if (folder === name) return;
      folder = name;
      emit({ kind: "meta" });
    },

    snapshot() {
      return {
        nodes: Array.from(nodes.values()).map(adoptNode),
        edges: Array.from(edges.values()).map(adoptEdge),
        threads: threads.map(adoptThread),
        marks: marks.map((m) => ({ ...m, ...(m.foreign ? { foreign: { ...m.foreign } } : {}) })),
        glyphs: stamps.map(adoptGlyph),
        topologyMode: topology,
        contentMode: content,
        ...(folder === undefined ? {} : { folderName: folder }),
        ...(boardForeign ? { foreign: cloneForeign(boardForeign) } : {}),
      };
    },

    load(snapshot) {
      nodes.clear();
      edges.clear();
      for (const n of snapshot.nodes ?? []) nodes.set(n.id, adoptNode(n));
      for (const e of snapshot.edges ?? []) {
        if (nodes.has(e.from) && nodes.has(e.to)) edges.set(e.id, adoptEdge(e));
      }
      threads = (snapshot.threads ?? []).map(adoptThread);
      marks = (snapshot.marks ?? []).map((m) => ({
        ...m,
        ...(m.foreign ? { foreign: { ...m.foreign } } : {}),
      }));
      stamps = (snapshot.glyphs ?? []).map(adoptGlyph);
      topology = snapshot.topologyMode ?? topology;
      content = snapshot.contentMode ?? content;
      folder = snapshot.folderName;
      boardForeign = cloneForeign(snapshot.foreign);
      emit({ kind: "reset" });
    },

    clear() {
      nodes.clear();
      edges.clear();
      threads = [];
      marks = [];
      stamps = [];
      // a cleared board is a new board — it inherits nobody's foreign fields
      boardForeign = undefined;
      emit({ kind: "reset" });
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  if (initial) board.load(initial);
  return board;
}
