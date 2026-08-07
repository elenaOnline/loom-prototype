// threads.ts — THREADS AS REAL OBJECTS (brief §3, ideation §6.6 — settled).
//
// A thread is an ordered run of node ids: a line of thought. Settled design says
// first-class — nameable, editable, pullable, handable to an agent — so this
// module has exactly five verbs and nothing else:
//
//   GRAB    click any trail edge → the whole connected run it belongs to is
//           selected as ONE object (upstream to the root, downstream along the
//           primary chain, taking the clicked branch where the walk forks).
//           The thread's edges thicken to ink; its cards invert their title
//           bars; everything else recedes to --s2/--ghost. Escape or a click on
//           paper lets go.
//   NAME    an inline mono nameplate floats at the root card. Enter commits and
//           the thread becomes persistent (model + codec x-powerset.threads) and
//           appears in the toolbar list. Clearing the name un-names it.
//   PULL    "t" gathers the thread's cards onto an even arc in trail order and
//           moves NOTHING else. Pressing "t" again restores every card to where
//           it was. A pull is a LENS, not a layout: reversible or it is a lie —
//           and since wave-2 §3 the restore point is board state, so the lens
//           does not silently become a layout when the page reloads.
//   COMB    "b" straightens and spaces the same run with the least motion that
//           will do (wave-2 §3, ideation §7.5 rung b). Local by construction.
//   RELAX   "r" puts cards back where the WANDER left them — `prov.x0/y0`, rung
//           (a), the truthful restore. Thread scope with a thread in hand, the
//           whole cloth without one (shift-r forces the whole cloth).
//   PIN     "p" freezes a named thread's membership. An unpinned thread FOLLOWS
//           ITS TIP (wave-2 §1): spawn from either end and the name comes with
//           you. Pinning says "this line of thought is these cards" and stops
//           that. Drawn as geometry — a filled atom on the nameplate and on the
//           toolbar chip — never a tint.
//   HAND    "c" types into the composer strip exactly what PowerSet would type:
//           the thread name, then one ref per card in order, and under each ref
//           the fibers that card carries — highlights as quoted lines, notes
//           quoted with their written text inline (fibers.ts, stage 5).
//
// THREAD IDENTITY (wave-2 §1, replacing wave-1's exact-run equality). Two rules,
// deliberately separate:
//
//   growth     is an EVENT — `model.growthForEdge` watches trail edges appear at
//              a thread's ends and extends the membership. It never fires on a
//              load, so a membership declared in a file is respected verbatim.
//   resolution is a MATCH — `model.resolveThreadForRun` decides which stored
//              thread a walked run just grabbed, by CONTAINMENT, not equality.
//
// And the invariant that keeps them from arguing: **a named thread's selection
// is exactly its stored membership.** The walked run only decides *which*
// thread you grabbed; it never silently becomes the thread.

import type { Camera, Insets } from "./camera";
import { boundsFrom, boundsOfRect } from "./camera";
import type {
  ArrangeSpot,
  ArrangeVerb,
  Board,
  Change,
  LoomEdge,
  LoomNode,
  Thread,
} from "./model";
import { growthForEdge, nowStamp, resolveThreadForRun, sameOrder } from "./model";
import type { Spot } from "./arrange";
import { SCOPE_BOARD, combSpots, relaxSpots, scopeKey, tautSpots } from "./arrange";
import type { EdgeLayer } from "./edges";
import type { Host } from "./host";
import { refOf } from "./codec";
import { collapse, elide } from "./quotes";

/** ms for the arrangement ease — long enough to read as one object moving */
const PULL_MS = 460;
/** a note is the reader's own writing: a longer leash than a quoted passage */
const NOTE_ECHO = 96;
/** screen px between the nameplate and the top of the root card */
const PLATE_LIFT = 30;

export interface ThreadSelection {
  /** set once the run has been named and persisted */
  threadId: string | null;
  /** trail order, root first */
  nodeIds: string[];
  edgeIds: string[];
}

export interface ThreadLayer {
  selection(): ThreadSelection | null;
  selectThread(threadId: string, opts?: { zoom?: boolean }): void;
  clear(): void;
  /** `t` — pull the selected run taut, or put back whatever a verb last moved */
  togglePull(): void;
  /** `b` — straighten and space the selected run, and nothing else (wave-2 §3) */
  comb(): void;
  /** `r` — every card back to where the wander left it; scope follows selection */
  relax(scope?: "auto" | "board"): void;
  /** which verb holds the live restore point for the current scope, if any */
  restoreVerb(): ArrangeVerb | null;
  /** freeze / unfreeze the selected named thread's membership */
  togglePin(): void;
  /** true when a thread was selected and the handoff was written */
  handOff(): boolean;
  destroy(): void;
}

export interface ThreadLayerOptions {
  board: Board;
  camera: Camera;
  viewport: HTMLElement;
  edgesSvg: SVGSVGElement;
  edges: EdgeLayer;
  host: Host;
  /** the card element for a node, so this module never rebuilds card DOM */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  getInsets?: () => Partial<Insets>;
  onStatus?: (text: string) => void;
  onSelectionChange?: (selection: ThreadSelection | null) => void;
  /**
   * an arrangement verb ran, or its restore point appeared/vanished. Separate
   * from `onSelectionChange` on purpose: a whole-board relax changes what the
   * chrome must offer while changing nothing about what is selected.
   */
  onArrange?: () => void;
}

export function createThreadLayer(options: ThreadLayerOptions): ThreadLayer {
  const { board, camera, viewport, edgesSvg, edges, host } = options;

  let selection: ThreadSelection | null = null;
  let selectedEdges = new Set<string>();
  let selectedNodes = new Set<string>();

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- the walk -----------------------------------------------------------
  // board.edges() is in creation order, which is what "primary" means here:
  // the first child a card ever spawned is the continuation of its line; later
  // ones are branches. That makes trail order and creation order the same story.

  function outgoing(nodeId: string): LoomEdge[] {
    return board.edges().filter((e) => e.kind === "trail" && e.from === nodeId);
  }

  function incoming(nodeId: string): LoomEdge[] {
    return board.edges().filter((e) => e.kind === "trail" && e.to === nodeId);
  }

  /**
   * The run a given edge belongs to. Upstream: follow the edge that placed each
   * card back to the root. Downstream: from the clicked edge's target, follow
   * the primary (first, unvisited) child each step — so a click on a branch
   * gives that branch's line, never every descendant.
   */
  function runFromEdge(edge: LoomEdge): string[] {
    const head = edge.from;
    const tail = edge.kind === "trail" ? edge.to : edge.from;

    const seen = new Set<string>([head]);
    const upstream: string[] = [];
    let cursor = head;
    for (;;) {
      const parent = incoming(cursor)[0];
      if (!parent || seen.has(parent.from)) break;
      cursor = parent.from;
      seen.add(cursor);
      upstream.unshift(cursor);
    }

    const run = [...upstream, head];
    if (tail !== head) {
      run.push(tail);
      seen.add(tail);
    }

    let last = run[run.length - 1];
    for (;;) {
      if (last === undefined) break;
      const child = outgoing(last).find((e) => !seen.has(e.to));
      if (!child) break;
      last = child.to;
      seen.add(last);
      run.push(last);
    }
    return run;
  }

  /** the edges that draw a run: its chain, plus returns that live inside it */
  function edgesOfRun(nodeIds: string[]): string[] {
    const set = new Set(nodeIds);
    const out: string[] = [];
    for (let i = 0; i < nodeIds.length - 1; i += 1) {
      const a = nodeIds[i];
      const b = nodeIds[i + 1];
      if (a === undefined || b === undefined) continue;
      const edge = board.findEdge(a, b, "trail");
      if (edge) out.push(edge.id);
    }
    for (const e of board.edges()) {
      if (e.kind !== "trail" && set.has(e.from) && set.has(e.to)) out.push(e.id);
    }
    return out;
  }

  // ---- selection ----------------------------------------------------------

  function setSelection(next: ThreadSelection | null): void {
    selection = next;
    selectedNodes = new Set(next?.nodeIds ?? []);
    selectedEdges = new Set(next?.edgeIds ?? []);
    edges.redraw();
    paintCards();
    paintPlate();
    options.onSelectionChange?.(next);
  }

  function selectRun(nodeIds: string[], threadId: string | null): void {
    if (nodeIds.length === 0) {
      setSelection(null);
      return;
    }
    setSelection({ threadId, nodeIds, edgeIds: edgesOfRun(nodeIds) });
  }

  function selectFromEdge(edgeId: string): void {
    const edge = board.edge(edgeId);
    if (!edge) return;
    if (edge.kind === "manual") {
      status("manual edges are assertions, not trails — nothing to pull");
      return;
    }
    if (edge.kind === "tether") {
      status("a tether holds a note to its source — grab the trail instead");
      return;
    }
    const run = runFromEdge(edge);
    const named = resolveThreadForRun(board.threads(), run, edge);
    if (!named) {
      selectRun(run, null);
      status(`thread unnamed — ${run.length} cards · name it, t to pull, c to hand off`);
      return;
    }
    // THE INVARIANT: what gets selected is the thread's membership, not the run
    // the walk happened to produce. A run that reaches past the thread (an
    // agent's anchor note, a branch you also crossed) frames the thread; it is
    // not absorbed by it.
    selectRun(named.nodeIds, named.id);
    status(describe(named, run));
  }

  /** the one line the status strip says about a grabbed thread */
  function describe(thread: Thread, run?: string[]): string {
    const n = thread.nodeIds.length;
    const bits = [`thread "${thread.name}" — ${n} card${n === 1 ? "" : "s"}`];
    if (thread.pinned) bits.push("pinned · membership frozen");
    if (thread.broken) bits.push(breakPhrase(thread));
    if (run && run.length > n) bits.push(`the run reaches ${run.length - n} card(s) further`);
    return bits.join(" · ");
  }

  function breakPhrase(thread: Thread): string {
    const missing = thread.broken?.missing ?? [];
    if (missing.length === 0) return "";
    const names = missing.map((m) => m.title || m.id).join(", ");
    return `BROKEN — lost ${names}`;
  }

  function selectThread(threadId: string, opts?: { zoom?: boolean }): void {
    const thread = board.thread(threadId);
    if (!thread) return;
    if (thread.nodeIds.length === 0) {
      // every card is gone but the NAME is not: wave 1 deleted the thread here,
      // which is the loudest silent detach of all. It stays in the list, dashed,
      // and says out loud what it lost.
      setSelection(null);
      status(`thread "${thread.name}" — ${breakPhrase(thread) || "no cards left"}`);
      return;
    }
    selectRun(thread.nodeIds, thread.id);
    if (opts?.zoom !== false) zoomToSelection();
    status(describe(thread));
  }

  function zoomToSelection(): void {
    if (!selection) return;
    const bounds = boundsFrom(
      selection.nodeIds
        .map((id) => board.node(id))
        .filter((n): n is LoomNode => n !== undefined)
        .map((n) => boundsOfRect(n.x, n.y, n.width, n.height)),
    );
    if (bounds) camera.flyTo(bounds);
  }

  function clear(): void {
    if (!selection) return;
    setSelection(null);
    status("");
  }

  // ---- paint --------------------------------------------------------------
  // Selection is geometry and inversion, never a tint: in-thread cards invert
  // their title bar, everything else recedes. The classifier is installed once;
  // the edge layer reads it at draw time.

  edges.setClassifier((edgeId) => {
    if (!selection) return null;
    return selectedEdges.has(edgeId) ? "in" : "out";
  });

  /**
   * A pulled thread crosses the cloth it did not move, so the selected line has
   * to sit on top or it stops reading as one object. The card layer owns
   * z-index, so the previous value is borrowed and handed straight back.
   */
  const Z_THREAD = 100000;
  const borrowedZ = new Map<string, string>();

  function paintCards(): void {
    const sel = selection;
    for (const node of board.nodes()) {
      const el = options.getCardEl(node.id);
      if (!el) continue;
      // membership is by CARD (wave-2 §4): every window on a card the thread
      // holds is lit, or a facet of a thread card would read as off-thread
      const inThread = sel !== null && selectedNodes.has(board.contentRoot(node.id));
      if (!sel) el.removeAttribute("data-thread");
      else el.setAttribute("data-thread", inThread ? "in" : "out");

      if (sel && inThread) {
        if (!borrowedZ.has(node.id)) borrowedZ.set(node.id, el.style.zIndex);
        el.style.zIndex = String(Z_THREAD + sel.nodeIds.indexOf(board.contentRoot(node.id)));
      } else if (borrowedZ.has(node.id)) {
        el.style.zIndex = borrowedZ.get(node.id) ?? "";
        borrowedZ.delete(node.id);
      }
    }
  }

  // ---- the nameplate ------------------------------------------------------

  const plate = document.createElement("div");
  plate.className = "thread-plate";
  plate.hidden = true;

  const nameInput = document.createElement("input");
  nameInput.className = "thread-name";
  nameInput.type = "text";
  nameInput.spellcheck = false;
  nameInput.autocomplete = "off";
  nameInput.placeholder = "name this thread";

  const plateCount = document.createElement("span");
  plateCount.className = "thread-plate-count";

  // Pin as GEOMETRY: an open 8px atom is "this thread still follows its tip",
  // the same atom filled is "frozen". Same idiom as the edge layer's fork ring
  // vs. return atom — no tint, no glow, nothing that needs a legend.
  const pinAtom = document.createElement("button");
  pinAtom.type = "button";
  pinAtom.className = "thread-pin";
  pinAtom.title = "p — freeze this thread's membership (pin)";

  // the break: never hidden, never healed behind your back. Click acknowledges.
  const breakEl = document.createElement("button");
  breakEl.type = "button";
  breakEl.className = "thread-break";
  breakEl.hidden = true;

  plate.append(pinAtom, nameInput, plateCount, breakEl);
  viewport.appendChild(plate);

  function currentThread(): Thread | undefined {
    return selection?.threadId ? board.thread(selection.threadId) : undefined;
  }

  function paintPlate(): void {
    if (!selection) {
      plate.hidden = true;
      return;
    }
    const root = board.node(selection.nodeIds[0] ?? "");
    if (!root) {
      plate.hidden = true;
      return;
    }
    plate.hidden = false;
    const count = selection.nodeIds.length;
    plateCount.textContent = `${count} card${count === 1 ? "" : "s"}`;
    if (document.activeElement !== nameInput) {
      nameInput.value = currentThread()?.name ?? "";
    }

    const thread = currentThread();
    if (thread?.pinned) pinAtom.setAttribute("data-pinned", "");
    else pinAtom.removeAttribute("data-pinned");
    // an un-named run has nothing to freeze: the atom recedes to a ghost outline
    if (thread) pinAtom.removeAttribute("data-off");
    else pinAtom.setAttribute("data-off", "");

    const missing = thread?.broken?.missing ?? [];
    breakEl.hidden = missing.length === 0;
    if (missing.length > 0) {
      breakEl.textContent = `${missing.length} lost`;
      breakEl.title = `${missing
        .map((m) => `"${m.title || m.id}" (was card ${m.index + 1})`)
        .join(", ")} — click to acknowledge the break`;
      plate.setAttribute("data-broken", "");
    } else {
      plate.removeAttribute("data-broken");
    }

    positionPlate(root);
  }

  function positionPlate(root: LoomNode): void {
    const p = camera.worldToScreen(root.x, root.y);
    const partial = options.getInsets?.() ?? {};
    const top = partial.top ?? 0;
    const rect = viewport.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.width - plate.offsetWidth - 8, p.x));
    const y = Math.max(top + 8, Math.min(rect.height - 40, p.y - PLATE_LIFT));
    plate.style.left = `${Math.round(x)}px`;
    plate.style.top = `${Math.round(y)}px`;
  }

  function commitName(): void {
    if (!selection) return;
    const name = nameInput.value.trim();
    const existing = currentThread();
    if (!name) {
      if (existing) {
        board.removeThread(existing.id);
        setSelection({ ...selection, threadId: null });
        status("thread un-named — it is a run again, not an object");
      }
      nameInput.blur();
      return;
    }
    if (existing) {
      // membership is NOT re-set from the selection here: the invariant says a
      // named thread's selection already IS its membership, and re-setting it
      // would let a rename quietly annex whatever the walk had reached (and
      // would walk straight through a pin).
      board.renameThread(existing.id, name);
      status(`thread renamed "${name}"`);
    } else {
      // naming is the moment a run is CAPTURED as an object; its root is its parent
      const thread = board.addThread(name, selection.nodeIds, {
        by: "human",
        how: "capture",
        from: selection.nodeIds[0] ?? null,
        src: null,
      });
      setSelection({ ...selection, threadId: thread.id });
      status(`thread "${name}" kept — ${selection.nodeIds.length} cards`);
    }
    nameInput.blur();
  }

  // ---- pin ----------------------------------------------------------------
  // The freeze. An unpinned thread tracks its tip, which is what makes a name
  // stay with a growing line of thought; pinning is how you say "no, THIS is
  // the thread" and take a snapshot. Reversible on purpose (ideation §7 meta-
  // rule: candidates stay toggleable) — unpinning hands the thread back to its
  // tip from wherever the trail has got to since.

  function togglePin(): void {
    const thread = currentThread();
    if (!thread) {
      status(
        selection
          ? "name this run before pinning it — a pin freezes a NAME's membership"
          : "no thread selected — click one of its edges first",
      );
      return;
    }
    const next = !thread.pinned;
    board.setThreadPinned(thread.id, next);
    const n = thread.nodeIds.length;
    status(
      next
        ? `thread "${thread.name}" pinned — ${n} card${n === 1 ? "" : "s"}, frozen`
        : `thread "${thread.name}" unpinned — it follows its tip again`,
    );
  }

  function mend(): void {
    const thread = currentThread();
    if (!thread?.broken) return;
    const lost = thread.broken.missing.length;
    board.mendThread(thread.id);
    const n = thread.nodeIds.length;
    status(`break acknowledged — "${thread.name}" is ${n} card${n === 1 ? "" : "s"} (lost ${lost})`);
  }

  pinAtom.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    pinAtom.blur();
    togglePin();
  });

  breakEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    breakEl.blur();
    mend();
  });

  nameInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitName();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      nameInput.value = currentThread()?.name ?? "";
      nameInput.blur();
    }
  });

  // ---- the entropy verbs (wave-2 §3, ideation §7.5) ------------------------
  //
  // Three verbs share one machine: compute a target position for a SET of cards,
  // take a restore point first, ease everything there together.
  //
  //   PULL   t — the selected run onto an even arc. A lens.
  //   COMB   b — the selected run straightened and spaced, minimal motion. Local
  //              by construction: `combSpots` can only name cards it was handed.
  //   RELAX  r — every card back to `prov.x0/y0`, where the wander put it.
  //              Scope follows the selection: a thread if one is grabbed, the
  //              whole cloth if not (shift-r forces the whole cloth).
  //
  // And one inverse: PUT BACK, the same `t`, which spends the restore point.
  //
  // The restore point lives in the BOARD now, not in this module (wave-1's known
  // issue: reload mid-pull and the arc was permanent — a lens that outlives the
  // session is just a layout you did not choose). It is keyed by scope and taken
  // first-writer-wins, so a comb on top of a pull still puts back to where the
  // HAND left the cards, not to the previous machine arrangement.
  //
  // Relax is the deeper undo and pull/comb are the shallower one, which is why
  // relax also takes a restore point: going back to the wander is a big move,
  // and the arrangement you spent an hour making by hand deserves one press to
  // get it back. Nothing here is a one-way door.

  let raf = 0;
  let guard = 0;

  /** the scope the verbs act on: the grabbed thread, else the whole cloth */
  function currentKey(): string {
    return selection ? scopeKey(selection.threadId, selection.nodeIds) : SCOPE_BOARD;
  }

  /** the verb that took the live restore point for this scope, if there is one */
  function restoreVerb(): ArrangeVerb | null {
    return board.arrangement(currentKey())?.verb ?? null;
  }

  function notifyArrange(): void {
    options.onArrange?.();
  }

  /** the grabbed run, as nodes, in trail order */
  function runNodes(): LoomNode[] {
    if (!selection) return [];
    return selection.nodeIds
      .map((id) => board.node(id))
      .filter((n): n is LoomNode => n !== undefined);
  }

  function spotsNow(ids: Iterable<string>): ArrangeSpot[] {
    const out: ArrangeSpot[] = [];
    for (const id of ids) {
      const n = board.node(id);
      if (n) out.push({ id, x: n.x, y: n.y });
    }
    return out;
  }

  function landOn(targets: Map<string, Spot>): void {
    board.moveNodes(Array.from(targets, ([id, s]) => ({ id, x: s.x, y: s.y })));
  }

  function animateTo(targets: Map<string, Spot>): void {
    const from = spotsNow(targets.keys());
    if (raf !== 0) cancelAnimationFrame(raf);
    if (guard !== 0) window.clearTimeout(guard);
    // THE EASE IS DECORATION; THE MOVE IS NOT. A background or throttled tab
    // starves requestAnimationFrame, and the restore point is spent the moment
    // the verb runs — so an animation that never gets a frame would consume the
    // undo without moving anything. This net puts the cards where the verb said
    // they go, late but certainly.
    guard = window.setTimeout(() => {
      guard = 0;
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
      landOn(targets);
    }, PULL_MS + 250);
    const startedAt = performance.now();
    const step = (now: number): void => {
      const raw = (now - startedAt) / PULL_MS;
      const t = raw >= 1 ? 1 : easeInOutCubic(raw < 0 ? 0 : raw);
      // one board change per frame, not one per card: a whole-board relax moves
      // 30 cards, and 30 emits a frame would have every layer downstream redraw
      // 30 times for one visible motion
      const frame: ArrangeSpot[] = [];
      for (const a of from) {
        const to = targets.get(a.id);
        if (!to) continue;
        frame.push({
          id: a.id,
          x: Math.round(a.x + (to.x - a.x) * t),
          y: Math.round(a.y + (to.y - a.y) * t),
        });
      }
      board.moveNodes(frame);
      if (raw >= 1) {
        raf = 0;
        if (guard !== 0) {
          window.clearTimeout(guard);
          guard = 0;
        }
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  /** take the restore point for this scope — a no-op if one is already held */
  function keep(verb: ArrangeVerb, ids: Iterable<string>): void {
    board.setArrangement({
      key: currentKey(),
      verb,
      at: nowStamp(),
      spots: spotsNow(ids),
    });
  }

  /** spend the restore point: every card back where the hand left it */
  function putBack(): boolean {
    const key = currentKey();
    const entry = board.arrangement(key);
    if (!entry) return false;
    const targets = new Map<string, Spot>();
    for (const s of entry.spots) {
      if (board.node(s.id)) targets.set(s.id, { x: s.x, y: s.y });
    }
    board.clearArrangement(key);
    if (targets.size === 0) {
      status("nothing left to put back — those cards have gone");
      notifyArrange();
      return true;
    }
    animateTo(targets);
    // pull → un-pulled · comb → un-combed · relax → un-relaxed
    status(`un-${entry.verb}ed — ${count(targets.size, "card")} back where the hand left ${
      targets.size === 1 ? "it" : "them"
    }`);
    notifyArrange();
    return true;
  }

  function pullTaut(): void {
    if (!selection) {
      status("no thread selected — click one of its edges first");
      return;
    }
    const nodes = runNodes();
    const targets = tautSpots(nodes);
    if (targets.size === 0) {
      status("a thread needs two cards before it can be pulled");
      return;
    }
    keep("pull", targets.keys());
    animateTo(targets);
    status(`pulled taut — ${targets.size} cards on the line · t again to put them back`);
    notifyArrange();
  }

  /**
   * Rung (b). The brief asks for a verb that is strictly local, and asks for the
   * wave-1 promise to be VERIFIED rather than believed: every id `combSpots`
   * returns came out of the array it was handed, so a card outside the run
   * cannot be moved by this code path even by accident.
   */
  function comb(): void {
    if (!selection) {
      status("comb works on a grabbed thread — click one of its edges first");
      return;
    }
    const nodes = runNodes();
    const targets = combSpots(nodes);
    if (targets.size === 0) {
      status("a thread needs two cards before it can be combed");
      return;
    }
    let moved = 0;
    for (const [id, spot] of targets) {
      const n = board.node(id);
      if (n && (Math.round(n.x) !== spot.x || Math.round(n.y) !== spot.y)) moved += 1;
    }
    if (moved === 0) {
      status("already combed — this thread is straight and has room");
      return;
    }
    keep("comb", targets.keys());
    animateTo(targets);
    status(`combed — ${count(moved, "card")} straightened, nothing else touched`);
    notifyArrange();
  }

  /**
   * Rung (a). The truthful one: every target is a coordinate this board itself
   * recorded when the card arrived. Where it has nothing recorded it says so
   * instead of inventing a tidy position, which is the whole difference between
   * this verb and the auto-sort it exists to make unnecessary.
   */
  function relax(scope: "auto" | "board" = "auto"): void {
    // asking for the whole cloth while a thread is grabbed LETS GO of it first:
    // the scope a verb acted on has to be the scope the chrome is showing, or
    // the restore point files itself somewhere the toolbar cannot offer back
    if (scope === "board" && selection) clear();
    const wholeBoard = selection === null;
    const nodes = wholeBoard ? board.nodes() : runNodes();
    if (nodes.length === 0) {
      status("nothing on the board to relax");
      return;
    }
    const where = wholeBoard ? "the cloth" : "this thread";
    const { targets, unknown, backfilled } = relaxSpots(nodes);
    if (targets.size === 0) {
      // say WHY there is nothing to do — "nothing happened" is the one status
      // line that teaches nothing
      if (unknown === nodes.length) {
        status(`${where}: no card here recorded where it was born — nothing to relax`);
      } else if (backfilled === nodes.length - unknown) {
        status(
          `${where} predates provenance: every birthplace was backfilled on first open, so this IS the as-wandered arrangement`,
        );
      } else {
        status(`${where} is already as the wander left it`);
      }
      return;
    }
    keep("relax", targets.keys());
    animateTo(targets);
    const aside = unknown === 0 ? "" : ` · ${count(unknown, "card")} never recorded a birthplace`;
    status(
      `relaxed ${where} — ${count(targets.size, "card")} back where the wander left ${
        targets.size === 1 ? "it" : "them"
      }${aside} · t to put them back`,
    );
    notifyArrange();
  }

  /** `t`: put back if there is something to put back, otherwise pull */
  function togglePull(): void {
    if (putBack()) return;
    pullTaut();
  }

  // ---- handoff ------------------------------------------------------------

  /**
   * Exactly what PowerSet's composer would receive — no prose, no decoration.
   *
   * ELISION (wave-2 §4, critique-ledger item 7). Quotes are echoed at PILL
   * LENGTH with counts rather than in full: the strip is a strip, and the whole
   * text is already kept in the two places that are supposed to hold it (the
   * board file and, for a glyph, `marks/<name>.md`). The counts are the promise
   * that nothing was silently dropped.
   *
   * And the handoff goes as ONE KEYED BLOCK, so pressing `c` twice collapses to
   * `×2` instead of typing the thread twice, and handing off a thread that has
   * since grown REPLACES the stale copy rather than sitting beside it. Wave 1
   * appended line by line and did neither (reproduced live: double keypress =
   * full duplicate).
   */
  function handOff(): boolean {
    if (!selection) return false;
    const nodes = selection.nodeIds
      .map((id) => board.node(id))
      .filter((n): n is LoomNode => n !== undefined);
    if (nodes.length === 0) return false;

    const thread = currentThread();
    const name = thread?.name ?? "unnamed thread";
    const frozen = thread?.pinned ? " · pinned" : "";
    const lines: string[] = [];
    let marks = 0;
    const body: string[] = [];

    // a broken thread hands off broken: the agent on the other end is told what
    // the line lost rather than being handed a shorter line as if it were whole
    for (const lost of thread?.broken?.missing ?? []) {
      body.push(`    (missing: ${lost.title || lost.id} — was card ${lost.index + 1})`);
    }
    for (const node of nodes) {
      const own = board.marksOf(node.id).filter((m) => collapse(m.quote).length > 0);
      const facets = board.placementsOf(node.id).length;
      body.push(
        `${refOf(node)}${own.length === 0 ? "" : ` · ${count(own.length, "mark")}`}` +
          `${facets > 1 ? ` · ${facets} facets` : ""}`,
      );
      // the fibers a card carries ride along under it: a highlight is quoted at
      // pill length, a note is quoted AND its text written inline
      for (const mark of own) {
        marks += 1;
        body.push(`    > ${elide(mark.quote)}`);
        if (mark.kind !== "note") continue;
        const text = mark.noteNodeId ? (board.node(mark.noteNodeId)?.text ?? "") : "";
        body.push(`      note: ${elide(text, NOTE_ECHO) || "(empty)"}`);
      }
    }
    const tally = marks === 0 ? "" : ` · ${count(marks, "mark")}`;
    lines.push(`thread: ${name} (${count(nodes.length, "card")}${tally})${frozen}`, ...body);

    const key = thread ? `thread:${thread.id}` : `run:${selection.nodeIds.join("|")}`;
    const result = host.sendBlock(key, lines);
    const how =
      result === "collapsed"
        ? " (already in the strip — marked ×n, not repeated)"
        : result === "replaced"
          ? " (replaced the earlier copy)"
          : "";
    status(`handed off "${name}" — ${nodes.length} refs in the composer${tally}${how}`);
    return true;
  }

  // ---- input --------------------------------------------------------------

  function onEdgeClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const hit = e.target.closest<SVGElement>(".edge-hit");
    const id = hit?.getAttribute("data-edge-id");
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    selectFromEdge(id);
  }

  /** paper means paper: not a card, not an edge, not the nameplate */
  function onPaperDown(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".card, .edge-hit, .thread-plate")) return;
    clear();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      clear();
      return;
    }
    if (isTyping(e.target)) return;
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      togglePull();
      return;
    }
    if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      comb();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      // shift asks for the whole cloth even with a thread in hand
      relax(e.shiftKey ? "board" : "auto");
      return;
    }
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      togglePin();
      return;
    }
    if (e.key === "n" || e.key === "N") {
      if (!selection) return;
      e.preventDefault();
      nameInput.focus();
      nameInput.select();
    }
  }

  edgesSvg.addEventListener("click", onEdgeClick);
  viewport.addEventListener("pointerdown", onPaperDown);
  window.addEventListener("keydown", onKeyDown);

  const unwatchCamera = camera.onChange(() => {
    if (!selection || plate.hidden) return;
    const root = board.node(selection.nodeIds[0] ?? "");
    if (root) positionPlate(root);
  });

  /**
   * TIP-TRACKING, applied. The rule itself is `model.growthForEdge` (a pure
   * statement about the graph, like `branchStartEdgeIds`); this is the one
   * place that acts on it. It runs whether or not anything is selected — a
   * thread grows because its trail grew, not because you were watching.
   *
   * It fires ONLY on edges the board has just gained. That is deliberate and
   * load-bearing: a `load()` emits `reset`, never `graph`, so opening a file
   * can never rewrite a membership the file declared.
   */
  function applyGrowth(edgeIds: string[] | undefined): void {
    if (!edgeIds || edgeIds.length === 0) return;
    for (const id of edgeIds) {
      const edge = board.edge(id);
      if (!edge) continue; // this id is a REMOVAL, not an addition
      for (const grown of growthForEdge(board.threads(), board.edges(), edge)) {
        board.setThreadNodes(grown.threadId, grown.nodeIds);
        const thread = board.thread(grown.threadId);
        if (!thread) continue;
        const where = grown.end === "tip" ? "followed its tip" : "grew from its root";
        status(`thread "${thread.name}" ${where} — ${thread.nodeIds.length} cards`);
      }
    }
  }

  const unsubscribe = board.onChange((change: Change) => {
    // a placement parked itself at a heading; nothing about any thread moved
    if (change.kind === "view") return;
    if (change.kind === "graph") applyGrowth(change.edgeIds);
    // a load brings its own restore points; a deletion can retire one. Either
    // way the chrome's offer has to be re-read from the model, not remembered.
    if (change.kind === "reset" || change.kind === "graph") notifyArrange();
    if (!selection) return;
    if (change.kind === "reset") {
      setSelection(null);
      return;
    }
    // the selected thread grew (or was edited) under the selection: re-select it
    // so the invariant holds — a named thread's selection IS its membership
    const thread = currentThread();
    if (thread && !sameOrder(thread.nodeIds, selection.nodeIds)) {
      if (thread.nodeIds.length === 0) setSelection(null);
      else selectRun(thread.nodeIds, thread.id);
      return;
    }
    // a placement can vanish under a selection (unpin); drop it from the run
    const alive = selection.nodeIds.filter((id) => board.node(id) !== undefined);
    if (alive.length !== selection.nodeIds.length) {
      selectRun(alive, selection.threadId);
      return;
    }
    if (change.kind === "graph" || change.kind === "content") paintCards();
    paintPlate();
  });

  return {
    selection: () => selection,
    selectThread,
    clear,
    togglePull,
    comb,
    relax,
    restoreVerb,
    togglePin,
    handOff,
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
      if (guard !== 0) window.clearTimeout(guard);
      for (const [id, z] of borrowedZ) {
        const el = options.getCardEl(id);
        if (el) el.style.zIndex = z;
      }
      borrowedZ.clear();
      unsubscribe();
      unwatchCamera();
      edges.setClassifier(null);
      edgesSvg.removeEventListener("click", onEdgeClick);
      viewport.removeEventListener("pointerdown", onPaperDown);
      window.removeEventListener("keydown", onKeyDown);
      plate.remove();
    },
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
