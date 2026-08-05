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
}

export interface LoomEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
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
}

export interface MarkSpec {
  nodeId: string;
  quote: string;
  kind: "highlight" | "note";
  noteNodeId?: string;
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
  /** only for load(): keep the id from the file */
  id?: string;
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

  addEdge(from: string, to: string, kind: EdgeKind, label?: string): LoomEdge | undefined;
  removeEdge(id: string): void;

  /** keep a fiber: the quote stays with the card, and rides a thread handoff */
  addMark(spec: MarkSpec): Mark;
  removeMark(id: string): void;

  /** name a run of nodes — the moment a trail becomes an object you can keep */
  addThread(name: string, nodeIds: string[]): Thread;
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

  const listeners = new Set<ChangeListener>();

  function emit(change: Change): void {
    for (const cb of Array.from(listeners)) cb(change);
  }

  function makeNode(spec: NodeSpec): LoomNode {
    return {
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
    };
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

    addEdge(from, to, kind, label) {
      if (from === to) return undefined;
      if (!nodes.has(from) || !nodes.has(to)) return undefined;
      const existing = board.findEdge(from, to, kind);
      if (existing) return existing;
      const edge: LoomEdge = {
        id: freshId("e"),
        from,
        to,
        kind,
        ...(label === undefined ? {} : { label }),
      };
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

    addThread(name, nodeIds) {
      const thread: Thread = {
        id: freshId("t"),
        name,
        // a thread only ever holds placements that exist, in the order given
        nodeIds: nodeIds.filter((id) => nodes.has(id)),
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
        nodes: Array.from(nodes.values()).map((n) => ({ ...n })),
        edges: Array.from(edges.values()).map((e) => ({ ...e })),
        threads: threads.map((t) => ({ ...t, nodeIds: t.nodeIds.slice() })),
        marks: marks.map((m) => ({ ...m })),
        topologyMode: topology,
        contentMode: content,
        ...(folder === undefined ? {} : { folderName: folder }),
      };
    },

    load(snapshot) {
      nodes.clear();
      edges.clear();
      for (const n of snapshot.nodes ?? []) nodes.set(n.id, { ...n });
      for (const e of snapshot.edges ?? []) {
        if (nodes.has(e.from) && nodes.has(e.to)) edges.set(e.id, { ...e });
      }
      threads = (snapshot.threads ?? []).map((t) => ({ ...t, nodeIds: t.nodeIds.slice() }));
      marks = (snapshot.marks ?? []).map((m) => ({ ...m }));
      topology = snapshot.topologyMode ?? topology;
      content = snapshot.contentMode ?? content;
      folder = snapshot.folderName;
      emit({ kind: "reset" });
    },

    clear() {
      nodes.clear();
      edges.clear();
      threads = [];
      marks = [];
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
