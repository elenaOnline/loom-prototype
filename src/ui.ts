// ui.ts — one hairline strip. Instrument chrome, not a dashboard.
//
// Everything here is a switch on the experiment: which corpus, which topology,
// which thread, where the board stands. Active state is inversion (ink ground,
// paper text), never a tint. Keys: 1/2/3 topology · f fit (camera owns it) ·
// t pull taut, p pin, and Escape/n naming (threads.ts owns those) · c hand off.

import type { Camera } from "./camera";
import type { Board, ContentMode, TopologyMode } from "./model";
import { TOPOLOGY_MODES } from "./model";
import type { SaveState } from "./codec";

export interface Ui {
  status(text: string): void;
  setSaveState(state: SaveState, detail?: string): void;
  /** the thread list is a readout of the model; this is only its highlight */
  setActiveThread(threadId: string | null, pulled: boolean): void;
  /** the altitude word from tiers.ts — fiber · thread · cloth */
  setTier(word: string): void;
  refresh(): void;
  destroy(): void;
}

export interface UiOptions {
  toolbar: HTMLElement;
  board: Board;
  camera: Camera;
  onContentMode: (mode: ContentMode) => void;
  onOpenFolder: () => void;
  onNewBoard: () => void;
  onSaveToDisk: () => void;
  onLoadFromDisk: () => void;
  /** no showOpenFilePicker on this engine → the affordance does not exist */
  canLoadFromDisk: boolean;
  onHandOff: () => void;
  onPull: () => void;
  /** freeze / unfreeze the selected thread's membership (wave-2 §1) */
  onPin: () => void;
  onThreadPick: (threadId: string) => void;
}

const TOPOLOGY_HINT: Record<TopologyMode, string> = {
  duplicate: "always spawn a fresh card, even on a revisit",
  linkback: "revisit → trail edge to the card already placed",
  returnedge: "revisit → a distinct return loop; otherwise spawn",
};

const STATUS_MS = 2600;

export function createUi(options: UiOptions): Ui {
  const { toolbar, board, camera } = options;
  toolbar.replaceChildren();

  const brand = el("span", "brand", "loom");

  const modeGroup = group("corpus");
  const modeButtons = new Map<ContentMode, HTMLButtonElement>();
  for (const mode of ["wiki", "folder"] as ContentMode[]) {
    const b = button(mode, () => options.onContentMode(mode));
    modeButtons.set(mode, b);
    modeGroup.appendChild(b);
  }
  const openFolder = button("open…", () => options.onOpenFolder());
  openFolder.title = "pick a local folder of markdown";
  modeGroup.appendChild(openFolder);

  const topoGroup = group("topology");
  const topoButtons = new Map<TopologyMode, HTMLButtonElement>();
  TOPOLOGY_MODES.forEach((mode, i) => {
    const b = button(`${i + 1} ${mode}`, () => board.setTopologyMode(mode));
    b.title = TOPOLOGY_HINT[mode];
    topoButtons.set(mode, b);
    topoGroup.appendChild(b);
  });

  const threadGroup = group("thread");
  const pullButton = button("pull taut", () => options.onPull());
  pullButton.title = "t — gather the selected thread onto an even arc (reversible)";
  const pinButton = button("pin", () => options.onPin());
  pinButton.title = "p — freeze this thread's membership; unpinned, it follows its tip";
  const handButton = button("→ composer", () => options.onHandOff());
  handButton.title = "c — type the thread's ordered refs into the composer strip";
  const threadList = document.createElement("span");
  threadList.className = "tb-threads";
  threadGroup.append(pullButton, pinButton, handButton, threadList);

  const boardGroup = group("board");
  boardGroup.appendChild(button("fit", () => camera.zoomToFit()));
  boardGroup.appendChild(button("new", () => options.onNewBoard()));
  const saveButton = button("save…", () => options.onSaveToDisk());
  saveButton.title = "write board.canvas to a file — and keep writing it";
  boardGroup.appendChild(saveButton);
  if (options.canLoadFromDisk) {
    const loadButton = button("load…", () => options.onLoadFromDisk());
    loadButton.title = "open a .canvas board file (hand-edited files welcome)";
    boardGroup.appendChild(loadButton);
  }

  const statusEl = el("span", "tb-status", "");
  const countEl = el("span", "tb-count", "");
  const saveEl = el("span", "tb-save", "…");
  const zoomEl = el("span", "tb-zoom", "100%");
  zoomEl.id = "zoom-readout";

  toolbar.append(
    brand,
    modeGroup,
    topoGroup,
    threadGroup,
    boardGroup,
    statusEl,
    countEl,
    saveEl,
    zoomEl,
  );

  // ---- state readout ------------------------------------------------------

  let statusTimer = 0;

  function status(text: string): void {
    statusEl.textContent = text;
    if (statusTimer !== 0) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = "";
      statusTimer = 0;
    }, STATUS_MS);
  }

  let activeThread: string | null = null;
  let isPulled = false;

  function refresh(): void {
    const topology = board.topologyMode();
    for (const [mode, b] of topoButtons) toggle(b, mode === topology);
    const content = board.contentMode();
    for (const [mode, b] of modeButtons) toggle(b, mode === content);
    const folder = board.folderName();
    openFolder.textContent = folder ? `open… (${folder})` : "open…";
    // the residue readout (brief Q5): what 30 minutes of wandering LEFT. The
    // entropy question wants numbers, not an impression — cards is the walk,
    // threads is what was kept of it, marks is what was kept of them.
    countEl.textContent = [
      count(board.nodes().length, "card"),
      count(board.threads().length, "thread"),
      count(board.marks().length, "mark"),
    ].join(" · ");
    refreshThreads();
  }

  /** the list IS the model's thread array — kept names, in the order kept */
  function refreshThreads(): void {
    pullButton.textContent = isPulled ? "relax" : "pull taut";
    toggle(pullButton, isPulled);

    const threads = board.threads();
    const active = activeThread ? board.thread(activeThread) : undefined;
    pinButton.textContent = active?.pinned ? "unpin" : "pin";
    toggle(pinButton, active?.pinned === true);

    const frag = document.createDocumentFragment();
    if (threads.length === 0) {
      frag.appendChild(el("span", "tb-empty", "none kept"));
    }
    for (const thread of threads) {
      const b = button(thread.name, () => options.onThreadPick(thread.id));
      const notes = [`${thread.nodeIds.length} cards`];
      // state as GEOMETRY on the chip, matching the nameplate: a filled atom is
      // "pinned — this membership is frozen"; a dashed chip is "broken — this
      // name outlived part of its line". Never a tint, never a badge colour.
      if (thread.pinned) {
        const atom = document.createElement("span");
        atom.className = "tb-atom";
        b.prepend(atom);
        notes.push("pinned — membership frozen");
      }
      if (thread.broken) {
        b.setAttribute("data-broken", "");
        notes.push(
          `BROKEN — lost ${thread.broken.missing.map((m) => m.title || m.id).join(", ")}`,
        );
      }
      b.title = `${notes.join(" · ")} — select and frame this thread`;
      toggle(b, thread.id === activeThread);
      frag.appendChild(b);
    }
    threadList.replaceChildren(frag);
  }

  function setActiveThread(threadId: string | null, pulled: boolean): void {
    activeThread = threadId;
    isPulled = pulled;
    refreshThreads();
  }

  function setSaveState(state: SaveState, detail?: string): void {
    saveEl.textContent =
      state === "saving"
        ? "saving…"
        : state === "saved"
          ? "saved"
          : state === "pending"
            ? "unsaved"
            : state === "error"
              ? "save failed"
              : "—";
    saveEl.title = detail ?? "";
    saveEl.dataset["state"] = state;
  }

  // the zoom readout says the altitude as well as the number: naming the band
  // is how the session can tell "levels of abstraction" from "LOD shrink"
  let tierWord = "";
  let zoomPercent = Math.round(camera.z * 100);

  function paintZoom(): void {
    zoomEl.textContent = tierWord ? `${zoomPercent}% · ${tierWord}` : `${zoomPercent}%`;
  }

  function setTier(word: string): void {
    if (tierWord === word) return;
    tierWord = word;
    paintZoom();
  }

  const unsubscribe = board.onChange(() => refresh());
  const unzoom = camera.onChange((s) => {
    const next = Math.round(s.z * 100);
    if (next === zoomPercent) return;
    zoomPercent = next;
    paintZoom();
  });

  // ---- keys ---------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const index = ["1", "2", "3"].indexOf(e.key);
    if (index >= 0) {
      const mode = TOPOLOGY_MODES[index];
      if (mode) {
        e.preventDefault();
        board.setTopologyMode(mode);
        status(`topology: ${mode} — ${TOPOLOGY_HINT[mode]}`);
      }
      return;
    }
    if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      options.onHandOff();
    }
  }

  window.addEventListener("keydown", onKeyDown);
  refresh();

  return {
    status,
    setSaveState,
    setActiveThread,
    setTier,
    refresh,
    destroy() {
      unsubscribe();
      unzoom();
      window.removeEventListener("keydown", onKeyDown);
      if (statusTimer !== 0) window.clearTimeout(statusTimer);
      toolbar.replaceChildren();
    },
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function group(label: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tb-group";
  const tag = document.createElement("span");
  tag.className = "tb-label";
  tag.textContent = label;
  wrap.appendChild(tag);
  return wrap;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tb-button";
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    b.blur();
    onClick();
  });
  return b;
}

function toggle(b: HTMLButtonElement, on: boolean): void {
  if (on) b.setAttribute("data-active", "");
  else b.removeAttribute("data-active");
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
