import "./styles.css";
import { boundsFrom, boundsOfRect, createCamera, type Bounds } from "./camera";
import { createGrid } from "./grid";
import { createBoard, type ContentMode } from "./model";
import { BOARD_PATH, createAutosave, parse, wikiUrl } from "./codec";
import {
  createLocalStorageHost,
  openTextFromDisk,
  saveTextToDisk,
  supportsOpenFilePicker,
} from "./host";
import { createEdgeLayer } from "./edges";
import { createCardLayer } from "./cards";
import { createTrail } from "./trail";
import { createThreadLayer } from "./threads";
import { createTierLayer } from "./tiers";
import { createFiberLayer } from "./fibers";
import { createUi } from "./ui";
import { createWikiSource } from "./providers/wiki";
import { createFolderSource, type FolderSource } from "./providers/folder";
import type { ContentSource } from "./providers/source";

// Bootstrap/wiring only — stages add their modules here in build order:
// camera → cards/trail → threads → tiers → fibers. See ARCHITECTURE.md.

const viewport = must<HTMLElement>("viewport");
const world = must<HTMLElement>("world");
const cardsLayer = must<HTMLElement>("cards");
const edgesSvg = mustSvg("edges");
const toolbar = must<HTMLElement>("toolbar");
const composer = must<HTMLElement>("composer");

/** the article the loom opens on — dense, self-referential, easy to tangle */
const SEED_TITLE = "Turing machine";

const host = createLocalStorageHost(composer);
const board = createBoard();

// ---- content sources --------------------------------------------------------

const wiki = createWikiSource();
let folder: FolderSource | null = null;

function getSource(): ContentSource | null {
  return board.contentMode() === "folder" ? folder : wiki;
}

// ---- camera -----------------------------------------------------------------

function contentBounds(): Bounds | null {
  return boundsFrom(board.nodes().map((n) => boundsOfRect(n.x, n.y, n.width, n.height)));
}

function insets(): { top: number; bottom: number } {
  return { top: toolbar.offsetHeight, bottom: composer.offsetHeight };
}

const camera = createCamera({
  viewport,
  world,
  getContentBounds: contentBounds,
  getInsets: insets,
  shouldIgnoreWheel: wheelBelongsToCardBody,
  // paper means paper: an edge grab or a thread nameplate must not drag the cloth
  isPaper: (target) =>
    !(target instanceof Element) ||
    !target.closest(".card, .edge-hit, .thread-plate, .fiber-pill"),
});

createGrid(viewport, camera);

/** a card body still has room to scroll in this direction → leave it alone */
function wheelBelongsToCardBody(e: WheelEvent): boolean {
  if (!(e.target instanceof Element)) return false;
  const body = e.target.closest<HTMLElement>(".card-body");
  if (!body) return false;
  const max = body.scrollHeight - body.clientHeight;
  if (max <= 1) return false;
  if (e.deltaY < 0) return body.scrollTop > 0;
  if (e.deltaY > 0) return body.scrollTop < max - 1;
  return false;
}

// ---- layers -----------------------------------------------------------------

const edges = createEdgeLayer(edgesSvg, board);

const cards = createCardLayer({
  container: cardsLayer,
  viewport,
  board,
  camera,
  edges,
  getSource,
});

const trail = createTrail({
  board,
  container: cardsLayer,
  camera,
  viewport,
  getSource,
  getInsets: insets,
  onPing: (id) => cards.ping(id),
  onStatus: (text) => ui.status(text),
});

const threads = createThreadLayer({
  board,
  camera,
  viewport,
  edgesSvg,
  edges,
  host,
  getCardEl: (id) => cards.element(id),
  getInsets: insets,
  onStatus: (text) => ui.status(text),
  onSelectionChange: (selection) => {
    ui.setActiveThread(selection?.threadId ?? null, threads.pulled());
  },
});

// ---- chrome -----------------------------------------------------------------

const ui = createUi({
  toolbar,
  board,
  camera,
  onContentMode: (mode) => {
    void switchContentMode(mode);
  },
  onOpenFolder: () => {
    void openFolder();
  },
  onNewBoard: () => {
    void newBoard();
  },
  onSaveToDisk: () => {
    void saveToDisk();
  },
  onLoadFromDisk: () => {
    void loadFromDisk();
  },
  canLoadFromDisk: supportsOpenFilePicker(),
  onHandOff: handOffSelection,
  onPull: () => threads.togglePull(),
  onThreadPick: (id) => threads.selectThread(id),
});

// after ui: the tier layer reports its altitude the moment it is built, and it
// must paint after the card layer has built the DOM for a change (listener order)
createTierLayer({
  viewport,
  board,
  camera,
  edges,
  getCardEl: (id) => cards.element(id),
  onTier: (_tier, word) => ui.setTier(word),
});

// last of the layers: fibers reads the tier class the line above writes, and its
// board listener must run after the card layer has (re)built the body it marks
createFiberLayer({
  board,
  camera,
  viewport,
  host,
  getCardEl: (id) => cards.element(id),
  getInsets: insets,
  onStatus: (text) => ui.status(text),
});

const autosave = createAutosave({
  board,
  host,
  onState: (state, detail) => ui.setSaveState(state, detail),
});

// ---- actions ----------------------------------------------------------------

async function openFolder(): Promise<void> {
  const dir = await host.pickFolder();
  if (!dir) {
    ui.status("no folder picked (this browser may not support the picker)");
    return;
  }
  folder = await createFolderSource(dir);
  board.setFolderName(dir.name);
  board.setContentMode("folder");
  ui.status(`${dir.name}: ${folder.entries().length} markdown files`);
  seedIfEmpty();
  trail.hydrateAll();
}

async function switchContentMode(mode: ContentMode): Promise<void> {
  if (mode === board.contentMode()) return;
  if (mode === "folder" && !folder) {
    await openFolder();
    return;
  }
  board.setContentMode(mode);
  const source = getSource();
  const foreign = board.nodes().filter((n) => n.kind !== source?.nodeKind).length;
  if (foreign > 0) ui.status(`${foreign} card(s) from the other corpus stay put — "new" clears`);
  seedIfEmpty();
  trail.hydrateAll();
}

/**
 * Save, and KEEP the file: the handle the picker hands back is bound to the
 * host, so every later change writes that file on the same debounce. Without
 * that, "save…" is an export and the JSON Canvas round trip is one-way.
 */
async function saveToDisk(): Promise<void> {
  const result = await saveTextToDisk(autosave.text(), "board.canvas");
  if (!result.ok) {
    ui.status("save cancelled");
    return;
  }
  if (!result.handle) {
    ui.status("downloaded board.canvas (this browser cannot keep writing it)");
    return;
  }
  host.bindFile(result.handle);
  ui.status(`saving to ${result.handle.name} from now on`);
}

/**
 * Open a .canvas board. Liberal on read by construction (codec.parse), so a
 * hand-edited file — or one an agent wrote — opens as a board, which is the
 * whole reason the format is JSON Canvas.
 */
async function loadFromDisk(): Promise<void> {
  const opened = await openTextFromDisk();
  if (!opened) {
    ui.status("no file opened");
    return;
  }
  const snapshot = parse(opened.text);
  if (!snapshot || (snapshot.nodes?.length ?? 0) === 0) {
    ui.status(`${opened.name}: no cards in that file — nothing loaded`);
    return;
  }
  board.load(snapshot);
  host.bindFile(opened.handle);
  ui.refresh();
  trail.hydrateAll();
  camera.zoomToFit();
  const kept = opened.handle ? ` — writing back to ${opened.name}` : "";
  ui.status(`opened ${opened.name}: ${snapshot.nodes?.length ?? 0} cards${kept}`);
  if (board.contentMode() === "folder" && !folder) {
    ui.status(`re-open "${board.folderName() ?? "the folder"}" to read these cards`);
  }
}

async function newBoard(): Promise<void> {
  if (board.nodes().length > 0 && !window.confirm("Clear the board? This cannot be undone.")) {
    return;
  }
  board.clear();
  seedIfEmpty();
  await autosave.flush();
  camera.zoomToFit();
}

/** the board is never empty paper with no way in */
function seedIfEmpty(): void {
  if (board.nodes().length > 0) return;
  const source = getSource();
  if (!source) return;
  if (source.mode === "wiki") {
    trail.spawnRoot(SEED_TITLE, SEED_TITLE);
    return;
  }
  if (folder) {
    const entries = folder.entries();
    const first =
      entries.find((p) => /^(readme|index)\.(md|markdown)$/i.test(p)) ?? entries[0];
    if (first) trail.spawnRoot(first, first.replace(/\.(md|markdown|txt)$/i, ""));
  }
}

/**
 * Handoff, widest grasp first: a selected thread goes as a whole line of
 * thought (name + ordered refs + marks); otherwise the one selected card.
 */
function handOffSelection(): void {
  if (threads.handOff()) return;
  const id = cards.selected();
  const node = id ? board.node(id) : undefined;
  if (!node) {
    ui.status("select a thread (click one of its edges) or a card, then press c");
    return;
  }
  const target =
    node.kind === "wiki"
      ? wikiUrl(node.ref)
      : node.kind === "doc"
        ? `./${node.ref}`
        : node.title;
  host.sendToComposer(`read ${target}`);
  ui.status(`sent to composer: ${node.title}`);
}

// ---- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  const saved = await host.readFile(BOARD_PATH);
  const snapshot = saved ? parse(saved) : null;
  if (snapshot && (snapshot.nodes?.length ?? 0) > 0) {
    board.load(snapshot);
    if (board.contentMode() === "folder" && !folder) {
      // folder handles cannot survive a reload; the cards stay, unreadable
      // until the folder is re-picked, which is honest about the platform
      ui.status(`re-open "${board.folderName() ?? "the folder"}" to read these cards`);
    }
  } else {
    seedIfEmpty();
  }
  ui.refresh();
  trail.hydrateAll();
  // frame the board on boot — the one move that is allowed to be a cut
  camera.zoomToFit({ immediate: true });
}

void boot();

// ---- helpers ----------------------------------------------------------------

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`loom: missing #${id}`);
  return el as T;
}

function mustSvg(id: string): SVGSVGElement {
  const el = document.getElementById(id);
  if (!(el instanceof SVGSVGElement)) throw new Error(`loom: missing <svg id="${id}">`);
  return el;
}
