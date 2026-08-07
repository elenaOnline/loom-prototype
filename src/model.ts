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
 * A thread is an ORDERED run of node ids — a line of thought, first-class:
 * nameable, editable, pullable, handable to an agent (ideation §6.6). Order is
 * trail order (root first); it is the order a handoff types.
 */
export interface Thread {
  id: string;
  name: string;
  nodeIds: string[];
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

export interface BoardSnapshot {
  nodes: LoomNode[];
  edges: LoomEdge[];
  threads: Thread[];
  marks: Mark[];
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
 * `reset` = the whole board was replaced.
 */
export type ChangeKind =
  | "graph"
  | "position"
  | "content"
  | "meta"
  | "threads"
  | "marks"
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
  node(id: string): LoomNode | undefined;
  edge(id: string): LoomEdge | undefined;
  thread(id: string): Thread | undefined;
  /** the fibers seam: everything marked on one card, in creation order */
  marksOf(nodeId: string): Mark[];
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

  /** name a run of nodes — the moment a trail becomes an object you can keep */
  addThread(name: string, nodeIds: string[], prov?: ProvSeed): Thread;
  renameThread(id: string, name: string): void;
  setThreadNodes(id: string, nodeIds: string[]): void;
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

/** refs compare case-insensitively with collapsed whitespace/underscores */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
}

export function createBoard(initial?: Partial<BoardSnapshot>): Board {
  const nodes = new Map<string, LoomNode>();
  const edges = new Map<string, LoomEdge>();
  let threads: Thread[] = [];
  let marks: Mark[] = [];
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

  function adoptThread(t: Thread): Thread {
    const out: Thread = { ...t, nodeIds: t.nodeIds.slice() };
    // the brief's backfill shape is uniform: human · wander · at-unknown, even
    // for a thread, which is never literally wandered into being
    out.prov = t.prov ? cloneProv(t.prov) : backfillProv({ by: "human", how: "wander" });
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
    node: (id) => nodes.get(id),
    edge: (id) => edges.get(id),
    thread: (id) => threads.find((t) => t.id === id),
    marksOf: (nodeId) => marks.filter((m) => m.nodeId === nodeId),

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
      if (!nodes.has(id)) return;
      nodes.delete(id);
      const dropped: string[] = [];
      for (const e of Array.from(edges.values())) {
        if (e.from === id || e.to === id) {
          edges.delete(e.id);
          dropped.push(e.id);
        }
      }
      // marks and threads keep their shape; a removed placement just drops out.
      // A note card is half of a mark, so unpinning it takes the mark with it —
      // otherwise the source card keeps drawing an underline that leads nowhere.
      marks = marks.filter((m) => m.nodeId !== id && m.noteNodeId !== id);
      threads = threads
        .map((t) => ({ ...t, nodeIds: t.nodeIds.filter((n) => n !== id) }))
        // a thread that lost every placement is no longer a line of thought
        .filter((t) => t.nodeIds.length > 0);
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
        hit = true;
        return { ...t, nodeIds: nodeIds.filter((n) => nodes.has(n)) };
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
