// tabs.ts — the tab strip: bookmarks INTO the cloth (wave-4 §1).
//
// The oldest SETTLED-but-never-prototyped decision (ideation §6.5), finally on
// stage: the loom is the home screen, and a tab is a PLACE — a pinned
// world-space center + zoom — never a document and never a filter. The strip is
// a second full-width hairline row of the toolbar instrument: `flex-basis:100%`
// wraps it under the groups, and the viewport insets read `offsetHeight`, so
// the camera's usable area absorbs the extra row for free.
//
// Two rules the strip must not break:
//
//   HONEST ACTIVE STATE. A tab inverts only while the camera is ACTUALLY at
//   its place (a small tolerance, defined and defended below); pan away and no
//   tab is lit. Never "the last tab you clicked" — that is a lie about where
//   you are. The home tab plays by the same rule: it inverts only when the
//   camera sits at the zoomToFit framing, which moves when the cards do, so
//   the repaint listens to the board as well as the camera.
//
//   THE STRIP IS A READOUT. One tab per bookmark, in board order; the board is
//   the only state. Capture, rename and close go through the model's bookmark
//   API and the strip rebuilds on the `"bookmarks"` change like every other
//   surface — no shadow list, no reordering (deliberately not this wave).
//
// Keys: NONE this wave — 1/2/3 belong to topology; the strip steals nothing.

import type { Bounds, Camera, CameraState, Insets, Point } from "./camera";
import type { Board, Bookmark } from "./model";

export interface TabStrip {
  destroy(): void;
}

export interface TabStripOptions {
  toolbar: HTMLElement;
  viewport: HTMLElement;
  board: Board;
  camera: Camera;
  /** chrome overlaying the viewport — the same insets the camera frames within */
  getInsets?: () => Partial<Insets>;
  /** the §0 `from`: the card the view was captured over, if one is selected */
  getSelectedCardId: () => string | null;
  /** first name in the capture chain: the selected card's title */
  getSelectedCardTitle: () => string | null;
  /** second name in the capture chain: the active thread's name */
  getActiveThreadName: () => string | null;
  /** the fit framing, for the home tab's honesty (same source as zoomToFit) */
  getContentBounds: () => Bounds | null;
  onStatus?: (text: string) => void;
}

/**
 * How far the camera may sit from a bookmark's place and still count as AT it.
 * `flyToCamera` lands within 0.5 screen px and 0.0005 z of its target by
 * construction, and sub-pixel float error rides on top of that — 2px absorbs
 * both. A deliberate hand pan moves whole pixels and a deliberate zoom moves
 * whole percents, so the smallest real gesture un-lights the tab: the
 * tolerance forgives arithmetic, never wandering.
 */
const AT_TOL_PX = 2;
/** relative zoom tolerance, same reasoning: landing error yes, pinch no */
const AT_TOL_Z = 0.01;

/** names the `view N` fallback mints, so a recapture can find the gaps */
const VIEW_N = /^view (\d+)$/;

export function createTabStrip(options: TabStripOptions): TabStrip {
  const { toolbar, viewport, board, camera } = options;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- geometry -----------------------------------------------------------
  // Copied from camera.ts's usableCenter/cameraFromCenter, not invented: a
  // bookmark must mean the same point zoomToFit frames around — the center of
  // the viewport region the chrome does not cover. Drifting from the camera's
  // math here would make every captured tab land subtly off-center.

  function usableCenter(): Point {
    const r = viewport.getBoundingClientRect();
    const i = options.getInsets?.() ?? {};
    return {
      x: ((i.left ?? 0) + (r.width - (i.right ?? 0))) / 2,
      y: ((i.top ?? 0) + (r.height - (i.bottom ?? 0))) / 2,
    };
  }

  /** the camera that puts this bookmark's place under the CURRENT viewport's center */
  function cameraFor(b: Bookmark): CameraState {
    const c = usableCenter();
    return { x: c.x - b.cx * b.z, y: c.y - b.cy * b.z, z: b.z };
  }

  function isAt(target: CameraState, s: Readonly<CameraState>): boolean {
    return (
      Math.abs(target.x - s.x) <= AT_TOL_PX &&
      Math.abs(target.y - s.y) <= AT_TOL_PX &&
      Math.abs(s.z / target.z - 1) <= AT_TOL_Z
    );
  }

  // ---- capture ------------------------------------------------------------

  /** the name chain, at capture, no dialog: card title · thread name · view N */
  function captureName(): string {
    const card = options.getSelectedCardTitle()?.trim();
    if (card) return card;
    const thread = options.getActiveThreadName()?.trim();
    if (thread) return thread;
    const used = new Set<number>();
    for (const b of board.bookmarks()) {
      const m = VIEW_N.exec(b.name);
      if (m) used.add(Number(m[1] ?? "0"));
    }
    let n = 1;
    while (used.has(n)) n += 1;
    return `view ${n}`;
  }

  function capture(): void {
    const c = usableCenter();
    const w = camera.screenToWorld(c.x, c.y);
    const b = board.addBookmark({
      name: captureName(),
      cx: w.x,
      cy: w.y,
      z: camera.z,
      prov: { how: "place", from: options.getSelectedCardId() },
    });
    status(`tab "${b.name}" pinned — a place in the cloth, not a document`);
  }

  // ---- the strip ----------------------------------------------------------

  const row = document.createElement("div");
  row.className = "tb-tabs";

  const label = document.createElement("span");
  label.className = "tb-label";
  label.textContent = "tabs";

  // the home tab: permanent, leftmost, not closable, not renamable. The
  // home-screen fiction in one control — a new reader always has somewhere
  // to stand.
  const homeButton = tbButton("cloth", () => camera.zoomToFit());
  homeButton.classList.add("tb-tab-home");
  homeButton.title = "frame the whole cloth (f) — the home screen under every tab";

  const addButton = tbButton("+", () => capture());
  addButton.title = "pin the current view as a tab — named after the selected card, else the active thread, else view N";

  /** the live tabs, for the active-state repaint — rebuilt, never patched */
  let entries: { tab: HTMLSpanElement; bookmark: Bookmark }[] = [];

  function rebuild(): void {
    entries = [];
    const frag = document.createDocumentFragment();
    frag.append(label, homeButton);
    for (const bookmark of board.bookmarks()) {
      const tab = document.createElement("span");
      tab.className = "tb-tab";

      const go = document.createElement("button");
      go.type = "button";
      go.className = "tb-tab-go";
      go.textContent = bookmark.name;
      go.title = `fly to "${bookmark.name}" · double-click renames`;
      go.addEventListener("click", (e) => {
        e.preventDefault();
        go.blur();
        camera.flyToCamera(cameraFor(bookmark));
      });
      go.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginRename(tab, bookmark);
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "tb-tab-x";
      close.textContent = "×";
      close.title = `close "${bookmark.name}" — the place stays, unpinned`;
      close.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        board.removeBookmark(bookmark.id);
        status(`tab "${bookmark.name}" closed — the place is still there, unpinned`);
      });

      tab.append(go, close);
      entries.push({ tab, bookmark });
      frag.appendChild(tab);
    }
    frag.appendChild(addButton);
    row.replaceChildren(frag);
    paintActive(camera.state());
  }

  /**
   * The inline rename — the thread nameplate's event discipline, copied whole:
   * keys typed here are TEXT (stopPropagation before any global handler can
   * read them as gestures), Enter commits, Escape reverts-then-blurs, and blur
   * itself commits, so clicking away keeps the name that was standing when the
   * hand left. The commit goes through the model; the `"bookmarks"` change
   * rebuilds the strip and the input leaves with it.
   */
  function beginRename(tab: HTMLSpanElement, bookmark: Bookmark): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tb-tab-input";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = bookmark.name;
    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name && name !== bookmark.name) {
        board.renameBookmark(bookmark.id, name);
        status(`tab renamed "${name}"`);
      } else {
        // nothing to say to the model — put the label back ourselves
        rebuild();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        input.value = bookmark.name;
        input.blur();
      }
    });
    input.addEventListener("blur", () => commit());
    tab.replaceChildren(input);
    input.focus();
    input.select();
  }

  // ---- honest active state ------------------------------------------------

  function paintActive(s: Readonly<CameraState>): void {
    for (const { tab, bookmark } of entries) {
      if (isAt(cameraFor(bookmark), s)) tab.setAttribute("data-active", "");
      else tab.removeAttribute("data-active");
    }
    const bounds = options.getContentBounds();
    const home = bounds !== null && isAt(camera.cameraForBounds(bounds), s);
    if (home) homeButton.setAttribute("data-active", "");
    else homeButton.removeAttribute("data-active");
  }

  // appended AFTER createUi has run — the ui replaceChildren()s the toolbar,
  // and a row appended earlier would be swept away with the previous chrome
  toolbar.appendChild(row);
  rebuild();

  const unBoard = board.onChange((change) => {
    if (change.kind === "bookmarks" || change.kind === "reset") {
      rebuild();
      return;
    }
    // the fit framing follows the cards: a card added, removed or dragged
    // moves where "home" is, and the home tab's honesty must follow
    if (change.kind === "graph" || change.kind === "position") paintActive(camera.state());
  });
  const unCamera = camera.onChange((s) => paintActive(s));

  return {
    destroy() {
      unBoard();
      unCamera();
      row.remove();
    },
  };
}

/** the toolbar's button idiom (ui.ts `button`), local because ui exports chrome, not parts */
function tbButton(text: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tb-button";
  b.textContent = text;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    b.blur();
    onClick(e);
  });
  return b;
}
