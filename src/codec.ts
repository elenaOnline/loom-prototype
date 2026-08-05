// codec.ts — JSON Canvas 1.0 (jsoncanvas.org) load/save, plus debounced autosave.
//
// Rules from ARCHITECTURE.md: write standard JSON Canvas so the file is readable
// in the design sessions (that readability IS the point); carry everything the
// spec has no room for under a namespaced `x-powerset` key; be liberal on read
// (a hand-edited or foreign .canvas should still open).
//
// Article/markdown bodies are never written — they are re-fetched on load.

import type {
  Board,
  BoardSnapshot,
  ContentMode,
  EdgeKind,
  LoomEdge,
  LoomNode,
  Mark,
  NodeKind,
  Thread,
  TopologyMode,
} from "./model";
import { DEFAULT_CARD_H, DEFAULT_CARD_W, TOPOLOGY_MODES, freshId } from "./model";
import type { Host } from "./host";

export const BOARD_PATH = "board.canvas";

type Json = Record<string, unknown>;

interface CanvasNodeOut extends Json {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- write ----

export function toCanvas(snapshot: BoardSnapshot): Json {
  const nodes: CanvasNodeOut[] = snapshot.nodes.map((n) => {
    const base: CanvasNodeOut = {
      id: n.id,
      type: n.kind === "note" ? "text" : n.kind === "doc" ? "file" : "link",
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.round(n.width),
      height: Math.round(n.height),
    };
    if (n.kind === "wiki") base["url"] = wikiUrl(n.ref);
    if (n.kind === "doc") base["file"] = n.ref;
    if (n.kind === "note") base["text"] = n.text ?? "";
    base["x-powerset"] = { kind: n.kind, title: n.title, ref: n.ref };
    return base;
  });

  const edges: Json[] = snapshot.edges.map((e) => {
    const out: Json = {
      id: e.id,
      fromNode: e.from,
      toNode: e.to,
      ...sidesFor(e.kind),
    };
    if (e.label !== undefined) out["label"] = e.label;
    out["x-powerset"] = { kind: e.kind };
    return out;
  });

  return {
    nodes,
    edges,
    "x-powerset": {
      version: 1,
      topologyMode: snapshot.topologyMode,
      contentMode: snapshot.contentMode,
      ...(snapshot.folderName === undefined ? {} : { folderName: snapshot.folderName }),
      threads: snapshot.threads,
      marks: snapshot.marks,
    },
  };
}

function sidesFor(kind: EdgeKind): Json {
  // advisory only — our renderer picks sides from live geometry, but other
  // JSON Canvas readers need them to draw something sane.
  if (kind === "return") return { fromSide: "top", toSide: "top" };
  if (kind === "manual") return {};
  return { fromSide: "right", toSide: "left" };
}

export function wikiUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/**
 * What a card is called in a handoff — the one string PowerSet's composer would
 * receive for it. Shared so threads and fibers cannot drift apart on it.
 */
export function refOf(node: LoomNode): string {
  if (node.kind === "wiki") return wikiUrl(node.ref);
  if (node.kind === "doc") return `./${node.ref}`;
  return `note: ${node.title}`;
}

export function serialize(board: Board): string {
  return `${JSON.stringify(toCanvas(board.snapshot()), null, 2)}\n`;
}

// ----------------------------------------------------------------- read ----

export function fromCanvas(raw: unknown): Partial<BoardSnapshot> | null {
  if (!isObject(raw)) return null;
  const ext = isObject(raw["x-powerset"]) ? raw["x-powerset"] : {};

  const nodes: LoomNode[] = [];
  for (const item of asArray(raw["nodes"])) {
    const node = readNode(item);
    if (node) nodes.push(node);
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges: LoomEdge[] = [];
  for (const item of asArray(raw["edges"])) {
    const edge = readEdge(item);
    if (edge && known.has(edge.from) && known.has(edge.to)) edges.push(edge);
  }

  const out: Partial<BoardSnapshot> = {
    nodes,
    edges,
    threads: readThreads(ext["threads"]),
    marks: readMarks(ext["marks"]),
    topologyMode: readTopology(ext["topologyMode"]),
    contentMode: readContent(ext["contentMode"]),
  };
  const folder = ext["folderName"];
  if (typeof folder === "string") out.folderName = folder;
  return out;
}

export function parse(text: string): Partial<BoardSnapshot> | null {
  try {
    return fromCanvas(JSON.parse(text));
  } catch {
    return null;
  }
}

function readNode(raw: unknown): LoomNode | null {
  if (!isObject(raw)) return null;
  const ext = isObject(raw["x-powerset"]) ? raw["x-powerset"] : {};
  const type = str(raw["type"]) ?? "";
  if (type === "group") return null; // groups are later work; skip, don't choke

  const kind = readKind(ext["kind"], type);
  const url = str(raw["url"]);
  const file = str(raw["file"]);
  const ref = str(ext["ref"]) ?? (kind === "doc" ? (file ?? "") : titleFromUrl(url));
  const title = str(ext["title"]) ?? fallbackTitle(kind, ref, str(raw["text"]));

  const node: LoomNode = {
    id: str(raw["id"]) ?? freshId("n"),
    kind,
    ref,
    title,
    x: num(raw["x"]) ?? 0,
    y: num(raw["y"]) ?? 0,
    width: num(raw["width"]) ?? DEFAULT_CARD_W,
    height: num(raw["height"]) ?? DEFAULT_CARD_H,
    status: "idle",
  };
  const text = str(raw["text"]);
  if (kind === "note" && text !== undefined) node.text = text;
  return node;
}

function readEdge(raw: unknown): LoomEdge | null {
  if (!isObject(raw)) return null;
  const from = str(raw["fromNode"]);
  const to = str(raw["toNode"]);
  if (!from || !to) return null;
  const ext = isObject(raw["x-powerset"]) ? raw["x-powerset"] : {};
  const kind = readEdgeKind(ext["kind"]);
  const edge: LoomEdge = { id: str(raw["id"]) ?? freshId("e"), from, to, kind };
  const label = str(raw["label"]);
  if (label !== undefined) edge.label = label;
  return edge;
}

function readThreads(raw: unknown): Thread[] {
  const out: Thread[] = [];
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue;
    const id = str(item["id"]);
    if (!id) continue;
    const nodeIds = asArray(item["nodeIds"]).filter((v): v is string => typeof v === "string");
    out.push({ id, name: str(item["name"]) ?? "thread", nodeIds });
  }
  return out;
}

function readMarks(raw: unknown): Mark[] {
  const out: Mark[] = [];
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue;
    const id = str(item["id"]);
    const nodeId = str(item["nodeId"]);
    if (!id || !nodeId) continue;
    const mark: Mark = {
      id,
      nodeId,
      quote: str(item["quote"]) ?? "",
      kind: str(item["kind"]) === "note" ? "note" : "highlight",
    };
    const noteNodeId = str(item["noteNodeId"]);
    if (noteNodeId !== undefined) mark.noteNodeId = noteNodeId;
    out.push(mark);
  }
  return out;
}

function readKind(raw: unknown, type: string): NodeKind {
  const v = str(raw);
  if (v === "wiki" || v === "doc" || v === "note") return v;
  if (type === "file") return "doc";
  if (type === "text") return "note";
  return "wiki";
}

function readEdgeKind(raw: unknown): EdgeKind {
  const v = str(raw);
  return v === "manual" || v === "return" || v === "tether" ? v : "trail";
}

function readTopology(raw: unknown): TopologyMode {
  const v = str(raw);
  const found = TOPOLOGY_MODES.find((m) => m === v);
  return found ?? "returnedge";
}

function readContent(raw: unknown): ContentMode {
  return str(raw) === "folder" ? "folder" : "wiki";
}

function titleFromUrl(url: string | undefined): string {
  if (!url) return "";
  const m = /\/wiki\/([^?#]+)/.exec(url);
  const slug = m?.[1];
  if (!slug) return "";
  try {
    return decodeURIComponent(slug).replace(/_/g, " ");
  } catch {
    return slug.replace(/_/g, " ");
  }
}

function fallbackTitle(kind: NodeKind, ref: string, text: string | undefined): string {
  if (kind === "note") {
    const first = (text ?? "").split("\n", 1)[0] ?? "";
    return first.slice(0, 60) || "note";
  }
  if (!ref) return "untitled";
  const tail = ref.split("/").pop() ?? ref;
  return tail.replace(/\.(md|markdown|txt)$/i, "");
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ------------------------------------------------------------- autosave ----

export type SaveState = "clean" | "pending" | "saving" | "saved" | "error";

export interface Autosave {
  /** force an immediate write (used by the explicit save button) */
  flush(): Promise<void>;
  text(): string;
  destroy(): void;
}

export interface AutosaveOptions {
  board: Board;
  host: Host;
  path?: string;
  delayMs?: number;
  onState?: (state: SaveState, detail?: string) => void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const { board, host } = options;
  const path = options.path ?? BOARD_PATH;
  const delay = options.delayMs ?? 400;
  let timer = 0;
  let writing = false;
  let again = false;

  function report(state: SaveState, detail?: string): void {
    options.onState?.(state, detail);
  }

  async function write(): Promise<void> {
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    report("saving");
    try {
      await host.writeFile(path, serialize(board));
      report("saved");
    } catch (err) {
      report("error", String(err));
    } finally {
      writing = false;
      if (again) {
        again = false;
        void write();
      }
    }
  }

  const unsubscribe = board.onChange(() => {
    report("pending");
    if (timer !== 0) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      void write();
    }, delay);
  });

  return {
    async flush() {
      if (timer !== 0) {
        window.clearTimeout(timer);
        timer = 0;
      }
      await write();
    },
    text: () => serialize(board),
    destroy() {
      if (timer !== 0) window.clearTimeout(timer);
      timer = 0;
      unsubscribe();
    },
  };
}
