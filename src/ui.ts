// ui.ts — one hairline strip. Instrument chrome, not a dashboard.
//
// Everything here is a switch on the experiment: which corpus, which topology,
// which thread, where the board stands. Active state is inversion (ink ground,
// paper text), never a tint. Keys: 1/2/3 topology · f fit (camera owns it) ·
// t pull taut / put back, b comb, r relax, p pin, Escape/n naming (threads.ts
// owns those) · c hand off.

import type { Camera } from "./camera";
import type { ArrangeVerb, Board, ContentMode, TopologyMode } from "./model";
import { GLYPH_PALETTE, TOPOLOGY_MODES, glyphChar } from "./model";
import type { SaveState } from "./codec";

export interface Ui {
  status(text: string): void;
  setSaveState(state: SaveState, detail?: string): void;
  /** the thread list is a readout of the model; this is only its highlight */
  setActiveThread(threadId: string | null): void;
  /**
   * What the entropy verbs can do right now: `restore` is the verb holding the
   * live restore point for the current scope (null = nothing to put back), and
   * `hasSelection` is whether a run is in hand — pull and comb need one, relax
   * does not (without one it means the whole cloth).
   */
  setArrange(restore: ArrangeVerb | null, hasSelection: boolean): void;
  /** which glyph is selected as a unit, if any */
  setActiveGlyph(glyph: string | null): void;
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
  /** straighten + space the selected thread, never anything else (wave-2 §3) */
  onComb: () => void;
  /** restore as-wandered positions; `board` forces whole-cloth scope */
  onRelax: (scope: "auto" | "board") => void;
  /** freeze / unfreeze the selected thread's membership (wave-2 §1) */
  onPin: () => void;
  onThreadPick: (threadId: string) => void;
  /** light every place this glyph was stamped (wave-2 §2) */
  onGlyphPick: (glyph: string) => void;
  /** put the selected glyph's `marks/<name>.md` on the board */
  onGlyphFile: () => void;
  /** cloth-range caption policy — the reversible half of the §7.6 experiment */
  onCaptions: (on: boolean) => void;
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

  // the meaning-mark palette (wave-2 §2). A chip is the glyph itself plus how
  // many passages carry it — the whole readout of a collection in six pixels.
  // Chips for glyphs with no stamps stay visible but ghosted: the palette is
  // the vocabulary, and a vocabulary you cannot see is one you never reach for.
  const glyphGroup = group("glyph");
  const glyphList = document.createElement("span");
  glyphList.className = "tb-glyphs";
  const glyphFileButton = button("file…", () => options.onGlyphFile());
  glyphFileButton.title = "place the selected glyph's marks/<name>.md on the board";
  glyphGroup.append(glyphList, glyphFileButton);

  // The entropy verbs (wave-2 §3) get their own group: `relax` acts on the
  // whole cloth when nothing is grabbed, so filing it under "thread" would have
  // been a lie about its reach. One button carries pull AND its inverse because
  // they are one gesture — the label says which way it will go.
  const arrangeGroup = group("arrange");
  const pullButton = button("pull taut", () => options.onPull());
  const combButton = button("comb", () => options.onComb());
  combButton.title = "b — straighten and space the selected thread, moving nothing else";
  const relaxButton = button("relax", (e) => options.onRelax(e.shiftKey ? "board" : "auto"));
  arrangeGroup.append(pullButton, combButton, relaxButton);

  const threadGroup = group("thread");
  const pinButton = button("pin", () => options.onPin());
  pinButton.title = "p — freeze this thread's membership; unpinned, it follows its tip";
  const handButton = button("→ composer", () => options.onHandOff());
  handButton.title = "c — type the thread's ordered refs into the composer strip";
  const threadList = document.createElement("span");
  threadList.className = "tb-threads";
  threadGroup.append(pinButton, handButton, threadList);

  const boardGroup = group("board");
  boardGroup.appendChild(button("fit", () => camera.zoomToFit()));
  // reversible by construction (ideation §7 meta-rule): the caption policy is a
  // candidate under test, so the session can put the labels back in one click
  let captionsOn = false;
  const captionButton = button("captions", () => {
    captionsOn = !captionsOn;
    toggle(captionButton, captionsOn);
    options.onCaptions(captionsOn);
    status(
      captionsOn
        ? "cloth captions: every card labelled (the control)"
        : "cloth captions: named threads only — glyphs still show (the candidate)",
    );
  });
  captionButton.title = "at cloth range, label every card — off: only cards in a named thread";
  boardGroup.appendChild(captionButton);
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
    glyphGroup,
    arrangeGroup,
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
  let restoreOffer: ArrangeVerb | null = null;
  let hasSelection = false;
  let activeGlyph: string | null = null;

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
      count(board.glyphs().length, "stamp"),
    ].join(" · ");
    refreshThreads();
    refreshArrange();
    refreshGlyphs();
  }

  /**
   * The palette, as a readout. The five chips are always present (a vocabulary
   * has to be visible to be reached for); a glyph the board has never used is
   * ghosted, one with stamps carries its count, and the selected one inverts —
   * the same idiom the thread chips use, because it is the same kind of object.
   * A glyph a FILE brought that this build's palette does not offer gets a chip
   * too, so nothing on the board is invisible in the chrome.
   */
  function refreshGlyphs(): void {
    const counts = new Map<string, number>();
    for (const stamp of board.glyphs()) {
      counts.set(stamp.glyph, (counts.get(stamp.glyph) ?? 0) + 1);
    }
    const names = GLYPH_PALETTE.map((g) => g.name);
    for (const name of counts.keys()) if (!names.includes(name)) names.push(name);

    const frag = document.createDocumentFragment();
    for (const name of names) {
      const n = counts.get(name) ?? 0;
      const b = button("", () => options.onGlyphPick(name));
      b.className = "tb-button tb-glyph";
      const mark = document.createElement("span");
      mark.className = "glyph-atom";
      mark.dataset["glyph"] = name;
      mark.style.setProperty("--glyph-char", JSON.stringify(glyphChar(name)));
      b.appendChild(mark);
      if (n > 0) b.appendChild(document.createTextNode(String(n)));
      else b.setAttribute("data-empty", "");
      b.title =
        n === 0
          ? `${glyphChar(name)} ${name} — unused · select text in a card and press "mark ▸"`
          : `${glyphChar(name)} ${name} — ${count(n, "passage")} · marks/${name}.md`;
      toggle(b, name === activeGlyph);
      frag.appendChild(b);
    }
    glyphList.replaceChildren(frag);
    glyphFileButton.disabled = activeGlyph === null;
  }

  function setActiveGlyph(glyph: string | null): void {
    activeGlyph = glyph;
    refreshGlyphs();
  }

  /**
   * The verbs, as a readout of what they would do. The pull button carries its
   * own inverse: while a restore point is held it says "put back" and inverts,
   * which is the same state-is-geometry idiom the pins and chips use. The label
   * names the verb that will run, never the state it is in.
   */
  function refreshArrange(): void {
    pullButton.textContent = restoreOffer === null ? "pull taut" : "put back";
    toggle(pullButton, restoreOffer !== null);
    pullButton.title =
      restoreOffer === null
        ? "t — gather the selected thread onto an even arc (reversible)"
        : `t — put every card back where it was before the ${restoreOffer} (survives reload)`;
    combButton.disabled = !hasSelection;
    relaxButton.title = hasSelection
      ? "r — put this thread back where the wander left it · shift for the whole cloth"
      : "r — put every card back where the wander left it (nothing selected = whole cloth)";
  }

  /** the list IS the model's thread array — kept names, in the order kept */
  function refreshThreads(): void {
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

  function setActiveThread(threadId: string | null): void {
    activeThread = threadId;
    refreshThreads();
  }

  function setArrange(restore: ArrangeVerb | null, selected: boolean): void {
    restoreOffer = restore;
    hasSelection = selected;
    refreshArrange();
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
    setArrange,
    setActiveGlyph,
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

function button(label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tb-button";
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    b.blur();
    onClick(e);
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
