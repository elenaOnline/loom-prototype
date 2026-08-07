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
//           it was. A pull is a LENS, not a layout: reversible or it is a lie.
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
import type { Board, Change, LoomEdge, LoomNode, Thread } from "./model";
import { growthForEdge, resolveThreadForRun, sameOrder } from "./model";
import type { EdgeLayer } from "./edges";
import type { Host } from "./host";
import { refOf } from "./codec";

/** ms for the pull/relax ease — long enough to read as one object moving */
const PULL_MS = 460;
/** world px of clear air between cards on a taut thread */
const TAUT_GAP = 56;
/** a taut thread still hangs: bow as a fraction of its length, capped */
const SAG_RATIO = 0.1;
const SAG_MAX = 200;
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
  /** the experimental gesture; toggles */
  togglePull(): void;
  pulled(): boolean;
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
      const inThread = sel !== null && selectedNodes.has(node.id);
      if (!sel) el.removeAttribute("data-thread");
      else el.setAttribute("data-thread", inThread ? "in" : "out");

      if (sel && inThread) {
        if (!borrowedZ.has(node.id)) borrowedZ.set(node.id, el.style.zIndex);
        el.style.zIndex = String(Z_THREAD + sel.nodeIds.indexOf(node.id));
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

  // ---- pull taut ----------------------------------------------------------
  // Reversible by construction: the previous positions of exactly the thread's
  // cards are stashed, keyed by the run itself, before anything moves. Nothing
  // outside the thread is ever touched — the rest of the cloth stays where the
  // hand left it, which is the whole point of calling this a lens.

  type Spot = { x: number; y: number };

  const stashes = new Map<string, Map<string, Spot>>();
  let raf = 0;

  /**
   * A named thread is keyed by its IDENTITY, not by its membership: a thread
   * that follows its tip while pulled would otherwise change key mid-pull and
   * strand the stash, making the pull irreversible — the exact failure wave 1
   * already logs for reloads. An unnamed run has nothing but its membership to
   * be keyed by. (Stage 3 persists this stash; keying by thread id is also the
   * only form of it that can survive a reload.)
   */
  function stashKey(sel: ThreadSelection): string {
    return sel.threadId ?? `run:${sel.nodeIds.join("|")}`;
  }

  function pulled(): boolean {
    return selection !== null && stashes.has(stashKey(selection));
  }

  function spotsNow(nodeIds: string[]): Map<string, Spot> {
    const out = new Map<string, Spot>();
    for (const id of nodeIds) {
      const n = board.node(id);
      if (n) out.set(id, { x: n.x, y: n.y });
    }
    return out;
  }

  /**
   * An even arc through the thread's own centroid, aimed along its own
   * root→tip heading, so a pull reads as *tidying what is there* rather than
   * teleporting it somewhere new.
   */
  function tautSpots(nodeIds: string[]): Map<string, Spot> {
    const nodes = nodeIds
      .map((id) => board.node(id))
      .filter((n): n is LoomNode => n !== undefined);
    const out = new Map<string, Spot>();
    if (nodes.length < 2) return out;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return out;

    let ux = last.x + last.width / 2 - (first.x + first.width / 2);
    let uy = last.y + last.height / 2 - (first.y + first.height / 2);
    let span = Math.hypot(ux, uy);
    if (span < 1) {
      ux = 1;
      uy = 0;
      span = 1;
    }
    ux /= span;
    uy /= span;

    let widthSum = 0;
    let cx = 0;
    let cy = 0;
    for (const n of nodes) {
      widthSum += n.width;
      cx += n.x + n.width / 2;
      cy += n.y + n.height / 2;
    }
    cx /= nodes.length;
    cy /= nodes.length;

    const step = Math.max(widthSum / nodes.length + TAUT_GAP, span / (nodes.length - 1));
    const total = step * (nodes.length - 1);
    const startX = cx - (ux * total) / 2;
    const startY = cy - (uy * total) / 2;
    // perpendicular, rotated so the bow rises against the reading direction
    const px = uy;
    const py = -ux;
    const sag = Math.min(SAG_MAX, total * SAG_RATIO);

    nodes.forEach((n, i) => {
      const t = i / (nodes.length - 1);
      const bow = Math.sin(Math.PI * t) * sag;
      out.set(n.id, {
        x: Math.round(startX + ux * step * i + px * bow - n.width / 2),
        y: Math.round(startY + uy * step * i + py * bow - n.height / 2),
      });
    });
    return out;
  }

  function animateTo(targets: Map<string, Spot>): void {
    const from = spotsNow(Array.from(targets.keys()));
    if (raf !== 0) cancelAnimationFrame(raf);
    const startedAt = performance.now();
    const step = (now: number): void => {
      const raw = (now - startedAt) / PULL_MS;
      const t = raw >= 1 ? 1 : easeInOutCubic(raw < 0 ? 0 : raw);
      for (const [id, to] of targets) {
        const a = from.get(id);
        if (!a) continue;
        board.moveNode(
          id,
          Math.round(a.x + (to.x - a.x) * t),
          Math.round(a.y + (to.y - a.y) * t),
        );
      }
      if (raw >= 1) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function togglePull(): void {
    if (!selection) {
      status("no thread selected — click one of its edges first");
      return;
    }
    const key = stashKey(selection);
    const stashed = stashes.get(key);
    if (stashed) {
      stashes.delete(key);
      animateTo(stashed);
      status("thread relaxed — every card back where it was");
      options.onSelectionChange?.(selection);
      return;
    }
    const targets = tautSpots(selection.nodeIds);
    if (targets.size === 0) {
      status("a thread needs two cards before it can be pulled");
      return;
    }
    stashes.set(key, spotsNow(selection.nodeIds));
    animateTo(targets);
    status(`pulled taut — ${targets.size} cards on the line · t again to relax`);
    options.onSelectionChange?.(selection);
  }

  // ---- handoff ------------------------------------------------------------

  /** exactly what PowerSet's composer would receive — no prose, no decoration */
  function handOff(): boolean {
    if (!selection) return false;
    const nodes = selection.nodeIds
      .map((id) => board.node(id))
      .filter((n): n is LoomNode => n !== undefined);
    if (nodes.length === 0) return false;

    const thread = currentThread();
    const name = thread?.name ?? "unnamed thread";
    const frozen = thread?.pinned ? " · pinned" : "";
    host.sendToComposer(
      `thread: ${name} (${nodes.length} card${nodes.length === 1 ? "" : "s"})${frozen}`,
    );
    // a broken thread hands off broken: the agent on the other end is told what
    // the line lost rather than being handed a shorter line as if it were whole
    for (const lost of thread?.broken?.missing ?? []) {
      host.sendToComposer(`    (missing: ${lost.title || lost.id} — was card ${lost.index + 1})`);
    }
    let marks = 0;
    for (const node of nodes) {
      host.sendToComposer(refOf(node));
      // the fibers a card carries ride along under it: a highlight is quoted,
      // a note is quoted AND its text is written inline, so the handoff reads
      // as the line of thought plus what was thought about it
      for (const mark of board.marksOf(node.id)) {
        const quote = mark.quote.replace(/\s+/g, " ").trim();
        if (!quote) continue;
        marks += 1;
        host.sendToComposer(`    > ${quote}`);
        if (mark.kind !== "note") continue;
        const text = mark.noteNodeId ? (board.node(mark.noteNodeId)?.text ?? "") : "";
        const written = text.replace(/\s+/g, " ").trim();
        host.sendToComposer(`      note: ${written || "(empty)"}`);
      }
    }
    const tail = marks === 0 ? "" : ` · ${marks} mark${marks === 1 ? "" : "s"}`;
    status(`handed off "${name}" — ${nodes.length} refs in the composer${tail}`);
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
    if (change.kind === "graph") applyGrowth(change.edgeIds);
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
    pulled,
    togglePin,
    handOff,
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
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

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
