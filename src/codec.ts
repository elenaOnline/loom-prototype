// codec.ts — JSON Canvas 1.0 (jsoncanvas.org) load/save, plus debounced autosave.
//
// Rules from ARCHITECTURE.md: write standard JSON Canvas so the file is readable
// in the design sessions (that readability IS the point); carry everything the
// spec has no room for under a namespaced `x-powerset` key; be liberal on read
// (a hand-edited or foreign .canvas should still open).
//
// Article/markdown bodies are never written — they are re-fetched on load.

import type {
  ArrangeSpot,
  Arrangement,
  Board,
  BoardSnapshot,
  BrokenLink,
  ContentMode,
  EdgeKind,
  Foreign,
  GlyphStamp,
  LoomEdge,
  LoomNode,
  Mark,
  NodeKind,
  Prov,
  ProvBy,
  ProvHow,
  Thread,
  ThreadBreak,
  TopologyMode,
} from "./model";
import {
  ARRANGE_VERBS,
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  PROV_BY,
  PROV_HOW,
  TOPOLOGY_MODES,
  backfillProv,
  freshId,
} from "./model";
import type { Host } from "./host";

export const BOARD_PATH = "board.canvas";

type Json = Record<string, unknown>;

// ------------------------------------------------------------- foreign ----
// Which keys this build OWNS. Everything else in a node/edge/thread/mark object
// is somebody else's — a hand-edit, an agent extension, a later wave — and is
// carried through untouched (brief §0: additive schema discipline).
//
// `fromSide`/`toSide` are deliberately NOT owned: the renderer picks sides from
// live geometry and only synthesizes advisory ones for foreign readers, so a
// file that states them keeps its own.

const NODE_BASE_KEYS = ["id", "type", "x", "y", "width", "height", "x-powerset"];
const NODE_EXT_KEYS = new Set(["kind", "title", "ref", "glyphFile", "prov"]);
const EDGE_BASE_KEYS = new Set(["id", "fromNode", "toNode", "label", "x-powerset"]);
const EDGE_EXT_KEYS = new Set(["kind", "prov"]);
const THREAD_KEYS = new Set(["id", "name", "nodeIds", "pinned", "broken", "prov"]);
const MARK_KEYS = new Set(["id", "nodeId", "quote", "kind", "noteNodeId"]);
const GLYPH_KEYS = new Set(["id", "glyph", "nodeId", "quote", "prov"]);
const ARRANGE_KEYS = new Set(["key", "verb", "at", "spots"]);
const BOARD_BASE_KEYS = new Set(["nodes", "edges", "x-powerset"]);
const BOARD_EXT_KEYS = new Set([
  "version",
  "topologyMode",
  "contentMode",
  "folderName",
  "threads",
  "marks",
  "glyphs",
  "arrangements",
]);

/** the payload key a node of this kind carries is ours; on any other kind it is not */
function nodeOwnedKeys(kind: NodeKind): Set<string> {
  const own = new Set(NODE_BASE_KEYS);
  own.add(kind === "wiki" ? "url" : kind === "doc" ? "file" : "text");
  return own;
}

function pickForeign(raw: Json, owned: Set<string>): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(raw)) {
    if (owned.has(key)) continue;
    (out ??= {})[key] = raw[key];
  }
  return out;
}

function foreignOf(
  raw: Json,
  owned: Set<string>,
  ext: Json,
  ownedExt: Set<string>,
): Foreign | undefined {
  const top = pickForeign(raw, owned);
  const inner = pickForeign(ext, ownedExt);
  if (!top && !inner) return undefined;
  return { ...(top ? { top } : {}), ...(inner ? { ext: inner } : {}) };
}

/** replay foreign keys, never letting one clobber a field this build owns */
function replay(target: Json, extras: Record<string, unknown> | undefined): void {
  if (!extras) return;
  for (const key of Object.keys(extras)) {
    if (key in target) continue;
    target[key] = extras[key];
  }
}

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
    replay(base, n.foreign?.top);
    const ext: Json = {
      kind: n.kind,
      title: n.title,
      ref: n.ref,
      // written only when the card IS a glyph file's window (wave-2 §2), so an
      // ordinary note's entry keeps the shape every earlier wave wrote
      ...(n.glyphFile === undefined ? {} : { glyphFile: n.glyphFile }),
      prov: provOut(n.prov),
    };
    replay(ext, n.foreign?.ext);
    base["x-powerset"] = ext;
    return base;
  });

  const edges: Json[] = snapshot.edges.map((e) => {
    const out: Json = { id: e.id, fromNode: e.from, toNode: e.to };
    if (e.label !== undefined) out["label"] = e.label;
    // a file that stated its own sides keeps them; ours are only advisory
    replay(out, e.foreign?.top);
    replay(out, sidesFor(e.kind));
    const ext: Json = { kind: e.kind, prov: provOut(e.prov) };
    replay(ext, e.foreign?.ext);
    out["x-powerset"] = ext;
    return out;
  });

  const threads: Json[] = snapshot.threads.map((t) => {
    // `prov` sits at the TOP LEVEL of a thread entry: a thread has no
    // `x-powerset` block of its own to nest it inside (P0 gap #1).
    // `pinned` and `broken` are written ONLY when they are true/present, so an
    // ordinary thread's entry stays byte-identical to the wave-1 shape and the
    // codec's fixpoint property survives (stage 0's invariant 1).
    const out: Json = {
      id: t.id,
      name: t.name,
      nodeIds: t.nodeIds.slice(),
      ...(t.pinned ? { pinned: true } : {}),
      ...(t.broken && t.broken.missing.length > 0
        ? { broken: { at: t.broken.at, missing: t.broken.missing.map((m) => ({ ...m })) } }
        : {}),
      prov: provOut(t.prov),
    };
    replay(out, t.foreign?.top);
    if (t.foreign?.ext) out["x-powerset"] = { ...t.foreign.ext };
    return out;
  });

  const marks: Json[] = snapshot.marks.map((m) => {
    const out: Json = { id: m.id, nodeId: m.nodeId, quote: m.quote, kind: m.kind };
    if (m.noteNodeId !== undefined) out["noteNodeId"] = m.noteNodeId;
    replay(out, m.foreign);
    return out;
  });

  // The glyph collection: parallel to `marks`, not folded into it. A fiber is a
  // passage kept where it was found; a glyph is a passage claimed by a thought
  // that recurs elsewhere. One is per-card, the other is per-glyph — a single
  // list with a widened `kind` would have made both queries scan the other's
  // rows and would have put two different species under one word.
  const glyphs: Json[] = snapshot.glyphs.map((g) => {
    const out: Json = {
      id: g.id,
      glyph: g.glyph,
      nodeId: g.nodeId,
      quote: g.quote,
      prov: provOut(g.prov),
    };
    replay(out, g.foreign);
    return out;
  });

  // The un-arrange stash, made persistent (wave-2 §3). Wave 1 kept it in a
  // module-local Map: reload mid-pull and the arc was permanent. It is written
  // as plain coordinates so a hand-edit or another reader can see exactly what
  // "put back" would do — no diff, no delta, no cleverness.
  const arrangements: Json[] = snapshot.arrangements.map((a) => {
    const out: Json = {
      key: a.key,
      verb: a.verb,
      at: a.at,
      spots: a.spots.map((s) => ({ id: s.id, x: s.x, y: s.y })),
    };
    replay(out, a.foreign);
    return out;
  });

  const ext: Json = {
    version: 1,
    topologyMode: snapshot.topologyMode,
    contentMode: snapshot.contentMode,
    ...(snapshot.folderName === undefined ? {} : { folderName: snapshot.folderName }),
    threads,
    marks,
    // omitted entirely on a board with no stamps, so wave-1 boards and boards
    // that never used the palette keep their exact shape (fixpoint preserved:
    // absent reads back as [], which writes back as absent)
    ...(glyphs.length === 0 ? {} : { glyphs }),
    // same discipline: a board nobody has arranged carries no key at all
    ...(arrangements.length === 0 ? {} : { arrangements }),
  };
  replay(ext, snapshot.foreign?.ext);

  const out: Json = { nodes, edges, "x-powerset": ext };
  replay(out, snapshot.foreign?.top);
  return out;
}

/** the wire shape, in the brief's field order; unknown prov keys ride along */
function provOut(prov: Prov): Json {
  const out: Json = {
    at: prov.at,
    by: prov.by,
    how: prov.how,
    from: prov.from,
    src: prov.src,
  };
  if (prov.x0 !== undefined) out["x0"] = prov.x0;
  if (prov.y0 !== undefined) out["y0"] = prov.y0;
  replay(out, prov as Record<string, unknown>);
  return out;
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
    glyphs: readGlyphs(ext["glyphs"]),
    arrangements: readArrangements(ext["arrangements"]),
    topologyMode: readTopology(ext["topologyMode"]),
    contentMode: readContent(ext["contentMode"]),
  };
  const folder = ext["folderName"];
  if (typeof folder === "string") out.folderName = folder;
  const foreign = foreignOf(raw, BOARD_BASE_KEYS, ext, BOARD_EXT_KEYS);
  if (foreign) out.foreign = foreign;
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

  const x = num(raw["x"]) ?? 0;
  const y = num(raw["y"]) ?? 0;
  const node: LoomNode = {
    id: str(raw["id"]) ?? freshId("n"),
    kind,
    ref,
    title,
    x,
    y,
    width: num(raw["width"]) ?? DEFAULT_CARD_W,
    height: num(raw["height"]) ?? DEFAULT_CARD_H,
    status: "idle",
    // a card with no recorded birthplace was born where it stands — the only
    // honest guess, and the one relax needs to have something to restore to
    prov: readProv(ext["prov"], { x0: x, y0: y }),
  };
  const text = str(raw["text"]);
  if (kind === "note" && text !== undefined) node.text = text;
  const glyphFile = str(ext["glyphFile"]);
  if (glyphFile !== undefined) node.glyphFile = glyphFile;
  const foreign = foreignOf(raw, nodeOwnedKeys(kind), ext, NODE_EXT_KEYS);
  if (foreign) node.foreign = foreign;
  return node;
}

function readEdge(raw: unknown): LoomEdge | null {
  if (!isObject(raw)) return null;
  const from = str(raw["fromNode"]);
  const to = str(raw["toNode"]);
  if (!from || !to) return null;
  const ext = isObject(raw["x-powerset"]) ? raw["x-powerset"] : {};
  const kind = readEdgeKind(ext["kind"]);
  const edge: LoomEdge = {
    id: str(raw["id"]) ?? freshId("e"),
    from,
    to,
    kind,
    prov: readProv(ext["prov"], { from }),
  };
  const label = str(raw["label"]);
  if (label !== undefined) edge.label = label;
  const foreign = foreignOf(raw, EDGE_BASE_KEYS, ext, EDGE_EXT_KEYS);
  if (foreign) edge.foreign = foreign;
  return edge;
}

function readThreads(raw: unknown): Thread[] {
  const out: Thread[] = [];
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue;
    const id = str(item["id"]);
    if (!id) continue;
    const nodeIds = asArray(item["nodeIds"]).filter((v): v is string => typeof v === "string");

    // Migration: the P0 agent, told "prov goes inside every x-powerset block",
    // reasonably invented one inside the thread entry. Read it, then rewrite it
    // to the top level — and drop it from the preserved leftovers so the board
    // does not end up carrying two copies that can drift apart.
    const nested = isObject(item["x-powerset"]) ? { ...item["x-powerset"] } : null;
    const nestedProv = nested?.["prov"];
    if (nested) delete nested["prov"];

    const thread: Thread = {
      id,
      name: str(item["name"]) ?? "thread",
      nodeIds,
      prov: readProv(item["prov"] ?? nestedProv, { from: nodeIds[0] ?? null }),
    };
    // a pin is a fact about the thread, so a hand-edit can set one; anything
    // other than a literal `true` is read as unpinned (and then not rewritten)
    if (item["pinned"] === true) thread.pinned = true;
    const broke = readBreak(item["broken"]);
    if (broke) thread.broken = broke;
    const top = pickForeign(item, new Set([...THREAD_KEYS, "x-powerset"]));
    const leftover = nested && Object.keys(nested).length > 0 ? nested : undefined;
    if (top || leftover) {
      thread.foreign = { ...(top ? { top } : {}), ...(leftover ? { ext: leftover } : {}) };
    }
    out.push(thread);
  }
  return out;
}

/**
 * A break record, liberal on read. An entry with no surviving `missing` list is
 * not a break — it is noise — and is dropped rather than kept as an empty husk
 * that would make the toolbar draw a dashed chip for nothing.
 */
function readBreak(raw: unknown): ThreadBreak | undefined {
  if (!isObject(raw)) return undefined;
  const missing: BrokenLink[] = [];
  for (const item of asArray(raw["missing"])) {
    if (!isObject(item)) continue;
    const id = str(item["id"]);
    if (!id) continue;
    missing.push({ id, index: num(item["index"]) ?? 0, title: str(item["title"]) ?? "" });
  }
  if (missing.length === 0) return undefined;
  return { at: str(raw["at"]) ?? null, missing };
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
    const foreign = pickForeign(item, MARK_KEYS);
    if (foreign) mark.foreign = foreign;
    out.push(mark);
  }
  return out;
}

/**
 * The glyph collection, liberal on read. Two deliberate liberties:
 *   · the glyph NAME is never narrowed to the five-glyph palette. A file may
 *     carry a sixth; coercing it would silently merge two collections, and
 *     dropping it would be the one un-additive act in the codec. It rides
 *     through and draws as its own initial (`model.glyphChar`).
 *   · a stamp whose `nodeId` is not on the board is KEPT (marks behave the same;
 *     edges do not, because an edge with no ends cannot be drawn at all). It
 *     simply draws nothing until that card comes back.
 */
function readGlyphs(raw: unknown): GlyphStamp[] {
  const out: GlyphStamp[] = [];
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue;
    const id = str(item["id"]);
    const glyph = str(item["glyph"]);
    const nodeId = str(item["nodeId"]);
    if (!id || !glyph || !nodeId) continue;
    const stamp: GlyphStamp = {
      id,
      glyph,
      nodeId,
      quote: str(item["quote"]) ?? "",
      prov: readProv(item["prov"], { from: nodeId, how: "mark" }),
    };
    const foreign = pickForeign(item, GLYPH_KEYS);
    if (foreign) stamp.foreign = foreign;
    out.push(stamp);
  }
  return out;
}

/**
 * The persistent un-arrange stash (wave-2 §3). Read liberally: an entry with no
 * key or no usable spot is dropped rather than kept as a restore point that
 * cannot restore, and `verb` is narrowed to its union (the label the toolbar
 * shows has to be one of three words). Spots are strict `{id,x,y}` triples —
 * unlike the objects above, there is nothing here a later wave would extend
 * per-spot, and an entry's own unknown keys still ride through `foreign`.
 */
function readArrangements(raw: unknown): Arrangement[] {
  const out: Arrangement[] = [];
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue;
    const key = str(item["key"]);
    if (!key) continue;
    const spots: ArrangeSpot[] = [];
    for (const s of asArray(item["spots"])) {
      if (!isObject(s)) continue;
      const id = str(s["id"]);
      const x = num(s["x"]);
      const y = num(s["y"]);
      if (!id || x === undefined || y === undefined) continue;
      spots.push({ id, x, y });
    }
    if (spots.length === 0) continue;
    const entry: Arrangement = {
      key,
      verb: ARRANGE_VERBS.find((v) => v === item["verb"]) ?? "pull",
      at: typeof item["at"] === "string" ? item["at"] : null,
      spots,
    };
    const foreign = pickForeign(item, ARRANGE_KEYS);
    if (foreign) entry.foreign = foreign;
    out.push(entry);
  }
  return out;
}

/**
 * Provenance, liberal on read. Absent → the brief's backfill shape
 * (`human · wander · at: null`) with the caller's positional fallback standing
 * in for the birthplace. Present → taken as written, including keys this build
 * does not know; only `by` and `how` are narrowed to their unions, since a
 * value outside them would be a schema violation the renderer cannot act on.
 */
function readProv(
  raw: unknown,
  fallback?: { x0?: number; y0?: number; from?: string | null; how?: ProvHow },
): Prov {
  // the caller's `how` fallback only ever applies to an object that DID NOT say:
  // a glyph stamp with no recorded provenance was still a `mark`, not a wander
  const how0: ProvHow = fallback?.how ?? "wander";
  if (!isObject(raw)) {
    return backfillProv({
      by: "human",
      how: how0,
      // NB: `from` is deliberately NOT taken from the fallback here. Stage 0's
      // fallback rule is about an absent KEY inside a prov block that exists;
      // an object with no prov block at all backfills to `from: null`, and that
      // is the shape its first save has already been verified against.
      ...(fallback?.x0 === undefined ? {} : { x0: fallback.x0 }),
      ...(fallback?.y0 === undefined ? {} : { y0: fallback.y0 }),
    });
  }
  const seed: Record<string, unknown> = { ...raw };
  seed["at"] = typeof raw["at"] === "string" ? raw["at"] : null;
  const by: ProvBy = PROV_BY.find((v) => v === raw["by"]) ?? "human";
  const how: ProvHow = PROV_HOW.find((v) => v === raw["how"]) ?? how0;
  seed["by"] = by;
  seed["how"] = how;
  // an explicit `from: null` MEANS null; only a missing key takes the fallback,
  // or the codec would not be idempotent (write null → read back the fallback)
  seed["from"] = "from" in raw ? (str(raw["from"]) ?? null) : (fallback?.from ?? null);
  seed["src"] = str(raw["src"]) ?? null;
  const x0 = num(raw["x0"]) ?? fallback?.x0;
  const y0 = num(raw["y0"]) ?? fallback?.y0;
  if (x0 === undefined) delete seed["x0"];
  else seed["x0"] = x0;
  if (y0 === undefined) delete seed["y0"];
  else seed["y0"] = y0;
  return backfillProv(seed as Prov);
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
