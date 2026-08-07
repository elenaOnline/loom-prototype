// glyphs.ts — MEANING-MARKS: the second species of thread (wave-2 §2, ideation §7.6).
//
// A trail records MOVEMENT — where attention went, drawn as edges. A glyph
// records MEANING — one thought recurring in several places, drawn as a stamp
// that appears in every place it recurred. The owner's sketch: highlight a
// sentence in A and stamp ✳; another in B, same ✳; a third in A stamped ◇. Each
// glyph then accrues its own commonplace file.
//
// Five verbs, and the first one is the whole design:
//
//   STAMP     select text → the fiber pill's fourth action opens the palette →
//             one click and the passage is stamped. NO dialog, NO naming step,
//             NO edge to draw. The palette expander is STICKY, so from the
//             second stamp onward it is a single click — highlight speed, which
//             is the brief's bar. (The pill itself is fibers.ts's; it calls
//             `board.addGlyph` and this layer draws the result.)
//   DRAW      by tier, because a glyph must answer a different question at each
//             altitude: FIBER — the glyph in the margin beside the passage;
//             THREAD — the glyphs on the card head; CLOTH — the CONSTELLATION:
//             the atoms float over the knots, and they stay lit even where
//             captions are suppressed. That last one is the §7.6 experiment:
//             "where did this thought appear?" answered by looking, not reading.
//   SELECT    click any stamp (margin, head, or a toolbar chip) and every
//             location lights while the rest of the cloth recedes — the exact
//             inversion idiom threads use, because a glyph is the same KIND of
//             object as a thread: a set of places, held together by a name.
//   FILE      each glyph accrues `marks/<name>.md` through the Host seam,
//             regenerated on every change: ordered quotes with their source
//             refs. Files-are-the-API — an agent reads a commonplace book.
//   HAND      `c` on a selected glyph types the whole collection into the
//             composer: the glyph, then every quote with its ref.
//
// What is deliberately NOT here: edges from a glyph to its marked cards. The
// ideation sketch floats them (§7.6) and §9.3 answers it — "the tie of the edge"
// is the anti-pattern at scale. The set IS the binding; selection is how you see
// it. Drawing 20 edges from one card would bury the trail the board is about.

import type { Camera } from "./camera";
import { boundsFrom, boundsOfRect } from "./camera";
import type { Board, Change, GlyphStamp, LoomNode } from "./model";
import { GLYPH_PALETTE, glyphChar } from "./model";
import type { Host } from "./host";
import { refOf } from "./codec";
import { unwrapAll, wrapQuote } from "./quotes";

/** world px — a glyph file is a document, not a margin note */
const FILE_W = 320;
const FILE_H = 420;
/** ms to coalesce file writes: a burst of stamps writes the file once */
const FILE_DEBOUNCE = 220;

/** the blocks a marginal stamp can hang beside */
const BLOCK = "p,li,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,td,th";

export interface GlyphLayer {
  /** the glyph currently selected as a unit, if any */
  selected(): string | null;
  select(glyph: string | null, opts?: { zoom?: boolean }): void;
  clear(): void;
  /** every glyph name present on the board, palette order first */
  present(): string[];
  /** true when a glyph was selected and its collection was written out */
  handOff(): boolean;
  /** put the selected glyph's file on the board as a card (or fly to it) */
  placeFile(): void;
  /** re-draw the stamps on one card (or all of them) */
  apply(nodeId?: string): void;
  destroy(): void;
}

export interface GlyphLayerOptions {
  board: Board;
  camera: Camera;
  viewport: HTMLElement;
  host: Host;
  /** the card layer owns card DOM; this module only decorates it */
  getCardEl: (nodeId: string) => HTMLElement | undefined;
  onStatus?: (text: string) => void;
  /** a glyph selection and a thread selection are two names for the same cloth */
  onSelect?: (glyph: string | null) => void;
}

export function createGlyphLayer(options: GlyphLayerOptions): GlyphLayer {
  const { board, camera, viewport, host } = options;

  let selected: string | null = null;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- the atom -----------------------------------------------------------
  // The drawn glyph carries its character in a CSS custom property, NOT as a
  // text node. That is load-bearing: fibers.ts and this module both index a card
  // body's TEXT to anchor quotes, and a stray "●" in the flow would shift every
  // subsequent match by one character. Nothing either layer inserts into a body
  // may contribute text. See quotes.ts.

  function atom(glyph: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "glyph-atom";
    el.dataset["glyph"] = glyph;
    el.style.setProperty("--glyph-char", JSON.stringify(glyphChar(glyph)));
    el.title = `${glyphChar(glyph)} ${glyph} — click to light every place it was stamped`;
    return el;
  }

  // ---- drawing ------------------------------------------------------------

  function apply(nodeId?: string): void {
    if (nodeId === undefined) {
      for (const n of board.nodes()) apply(n.id);
      return;
    }
    const el = options.getCardEl(nodeId);
    if (!el) return;
    const stamps = board.glyphsOf(nodeId);
    paintBody(el, stamps);
    paintHead(el, stamps);
    paintState(el, stamps);
  }

  /** the margin marks: a glyph beside the paragraph the passage lives in */
  function paintBody(el: HTMLElement, stamps: GlyphStamp[]): void {
    const body = el.querySelector<HTMLElement>(".card-body");
    if (!body) return;
    for (const margin of Array.from(body.querySelectorAll(".glyph-margin"))) margin.remove();
    for (const row of Array.from(body.querySelectorAll<HTMLElement>(".glyph-row"))) {
      row.classList.remove("glyph-row");
    }
    unwrapAll(body, ".glyph-mark");
    // a note being typed is a fiber itself; it is not stamped
    if (body.isContentEditable || stamps.length === 0) return;
    for (const stamp of stamps) drawStamp(body, stamp);
  }

  function drawStamp(body: HTMLElement, stamp: GlyphStamp): void {
    const spans = wrapQuote(body, stamp.quote, () => {
      const span = document.createElement("span");
      span.className = "glyph-mark";
      span.dataset["stampId"] = stamp.id;
      span.dataset["glyph"] = stamp.glyph;
      return span;
    });
    const first = spans[0];
    // a quote the provider no longer serves draws NOTHING — the same honest
    // failure a fiber mark makes, rather than marking the wrong words
    if (!first) return;
    marginFor(body, first).appendChild(atom(stamp.glyph));
  }

  /**
   * Where a marginal mark goes: beside the BLOCK the passage starts in, not
   * beside the words. A mark tied to the exact line would need measurement and
   * would move on every reflow of a card you are resizing or scrolling; tied to
   * the paragraph it is stable, and it is what a marginal mark has always been.
   */
  function marginFor(body: HTMLElement, first: HTMLElement): HTMLElement {
    const block = first.closest<HTMLElement>(BLOCK);
    if (!block || !body.contains(block) || block === body) {
      // no block ancestor (bare text in the body): sit inline, right before the
      // words. Rare — provider HTML is paragraphs — but it must not vanish.
      const inline = document.createElement("span");
      inline.className = "glyph-margin glyph-margin-inline";
      first.parentNode?.insertBefore(inline, first);
      return inline;
    }
    block.classList.add("glyph-row");
    const existing = block.querySelector<HTMLElement>(":scope > .glyph-margin");
    if (existing) return existing;
    const margin = document.createElement("span");
    margin.className = "glyph-margin";
    block.insertBefore(margin, block.firstChild);
    return margin;
  }

  /**
   * The head badge — one atom per DISTINCT glyph on the card, with its count.
   * One element, three drawings: at reading range it is a quiet row beside the
   * title; at thread range it grows with the title card; at cloth range CSS
   * lifts it above the knot and it becomes the constellation. Same trick the
   * card itself uses, so there is no third rendering path to keep in step.
   */
  function paintHead(el: HTMLElement, stamps: GlyphStamp[]): void {
    const head = el.querySelector<HTMLElement>(".card-head");
    if (!head) return;
    const existing = head.querySelector<HTMLElement>(":scope > .card-glyphs");
    if (stamps.length === 0) {
      existing?.remove();
      el.removeAttribute("data-glyphs");
      return;
    }
    el.setAttribute("data-glyphs", "");
    const row = existing ?? document.createElement("span");
    if (!existing) {
      row.className = "card-glyphs";
      head.insertBefore(row, head.querySelector(".card-unpin"));
    }
    const counts = new Map<string, number>();
    for (const stamp of stamps) counts.set(stamp.glyph, (counts.get(stamp.glyph) ?? 0) + 1);
    const frag = document.createDocumentFragment();
    for (const [glyph, n] of counts) {
      const cell = document.createElement("span");
      cell.className = "glyph-cell";
      cell.appendChild(atom(glyph));
      if (n > 1) {
        const count = document.createElement("span");
        count.className = "glyph-count";
        count.textContent = String(n);
        cell.appendChild(count);
      }
      frag.appendChild(cell);
    }
    row.replaceChildren(frag);
  }

  /**
   * Selection as INVERSION, exactly as a thread does it: the cards holding this
   * glyph come forward, everything else recedes, and the atoms of other glyphs
   * go quiet. One idiom for both species of thread — that was critique-ledger
   * item 8's request, and it costs nothing to honour here.
   */
  function paintState(el: HTMLElement, stamps: GlyphStamp[]): void {
    if (!selected) el.removeAttribute("data-glyphsel");
    else el.setAttribute("data-glyphsel", stamps.some((s) => s.glyph === selected) ? "in" : "out");
    for (const mark of Array.from(el.querySelectorAll<HTMLElement>(".glyph-atom, .glyph-mark"))) {
      if (!selected) mark.removeAttribute("data-sel");
      else mark.setAttribute("data-sel", mark.dataset["glyph"] === selected ? "in" : "out");
    }
  }

  // ---- selection ----------------------------------------------------------

  function present(): string[] {
    const seen = new Set(board.glyphs().map((g) => g.glyph));
    const out = GLYPH_PALETTE.map((g) => g.name).filter((n) => seen.has(n));
    for (const name of seen) {
      if (!out.includes(name)) out.push(name); // a glyph the file brought with it
    }
    return out;
  }

  function select(glyph: string | null, opts?: { zoom?: boolean }): void {
    selected = glyph;
    options.onSelect?.(glyph);
    apply();
    if (!glyph) return;
    const stamps = board.stampsOf(glyph);
    const cards = new Set(stamps.map((s) => s.nodeId));
    if (opts?.zoom !== false) frame(cards);
    status(
      stamps.length === 0
        ? `${glyphChar(glyph)} ${glyph} — nothing stamped yet`
        : `${glyphChar(glyph)} ${glyph} — ${count(stamps.length, "passage")} across ` +
          `${count(cards.size, "card")} · c to hand off`,
    );
  }

  function clear(): void {
    if (!selected) return;
    selected = null;
    options.onSelect?.(null);
    apply();
    status("");
  }

  function frame(ids: Set<string>): void {
    const bounds = boundsFrom(
      Array.from(ids)
        .map((id) => board.node(id))
        .filter((n): n is LoomNode => n !== undefined)
        .map((n) => boundsOfRect(n.x, n.y, n.width, n.height)),
    );
    if (bounds) camera.flyTo(bounds);
  }

  // ---- the glyph file -----------------------------------------------------
  // files-are-the-API. `host.writeFile("marks/star.md", …)` — under the
  // localStorage host that IS the file seam: it lands at the key
  // `loom:marks/star.md` (see host.ts `storageKey`). On a File System Access
  // host it would be a real file in the folder, and nothing here changes.
  //
  // Regenerated wholesale on every change rather than patched: the board is the
  // source of truth and the file is its rendering, so there is exactly one way
  // for them to disagree — and it is fixed by writing again.

  /** filename-safe, because the glyph NAME is the file name */
  function safeName(glyph: string): string {
    return glyph.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "glyph";
  }

  function filePath(glyph: string): string {
    return `marks/${safeName(glyph)}.md`;
  }

  function mdText(s: string): string {
    return s.replace(/\s+/g, " ").trim();
  }

  function sourceLine(stamp: GlyphStamp): string {
    const node = board.node(stamp.nodeId);
    if (!node) return `— (the card this was stamped on has left the board)`;
    const ref = refOf(node);
    if (node.kind === "note") return `— ${ref}`;
    const label = (node.title || node.ref).replace(/[[\]]/g, "");
    return `— [${label}](${ref})`;
  }

  /** ordered quotes + source refs, in STAMP order: the order the thought accrued */
  function fileText(glyph: string): string {
    const stamps = board.stampsOf(glyph);
    const cards = new Set(stamps.map((s) => s.nodeId));
    const lines: string[] = [
      `# ${glyphChar(glyph)} ${glyph}`,
      "",
      `${count(stamps.length, "passage")} · ${count(cards.size, "card")}`,
      "",
      "*A loom glyph file. Regenerated from the board on every change — the board",
      "is the source of truth, so edits here are overwritten.*",
      "",
      "---",
      "",
    ];
    if (stamps.length === 0) {
      lines.push("*Nothing is stamped with this glyph.*", "");
    }
    for (const stamp of stamps) {
      lines.push(`> ${mdText(stamp.quote)}`, ">", `> ${sourceLine(stamp)}`, "");
    }
    return lines.join("\n");
  }

  /** every glyph whose file we have ever written, so an emptied one is cleared */
  const written = new Set<string>();
  let fileTimer = 0;

  function regenerate(): void {
    const names = new Set<string>([...present(), ...written]);
    for (const glyph of names) {
      written.add(glyph);
      const text = fileText(glyph);
      void host.writeFile(filePath(glyph), text).catch(() => {
        status(`could not write ${filePath(glyph)}`);
      });
      // the file's window on the board, if one was placed, is the same rendering
      for (const node of board.nodes()) {
        if (node.glyphFile === glyph && node.text !== text) {
          board.setContent(node.id, { text });
        }
      }
    }
  }

  function scheduleFiles(): void {
    if (fileTimer !== 0) window.clearTimeout(fileTimer);
    fileTimer = window.setTimeout(() => {
      fileTimer = 0;
      regenerate();
    }, FILE_DEBOUNCE);
  }

  /**
   * The glyph file, placed. Ideation §7.6 says the file is itself placeable, and
   * it very nearly falls out of the note card: a note is a text body already.
   * The one thing that did NOT come free is that a note is editable and this is
   * a RENDERING — so `LoomNode.glyphFile` marks it, cards.ts leaves it
   * read-only, and this layer rewrites its text whenever the collection changes.
   * That is the whole cost, and it buys the files-are-the-API claim a face.
   */
  function placeFile(): void {
    const glyph = selected;
    if (!glyph) {
      status("select a glyph first — click one of its stamps, or a toolbar chip");
      return;
    }
    const already = board.nodes().find((n) => n.glyphFile === glyph);
    if (already) {
      camera.flyTo(boundsOfRect(already.x, already.y, already.width, already.height));
      status(`${filePath(glyph)} is already on the board`);
      return;
    }
    const spot = freeSpot();
    board.addNode({
      kind: "note",
      ref: "",
      title: filePath(glyph),
      glyphFile: glyph,
      x: spot.x,
      y: spot.y,
      width: FILE_W,
      height: FILE_H,
      text: fileText(glyph),
      status: "ready",
      // deliberate placement of a thing that already existed — not a wander,
      // and not the `mark` that made the stamps
      prov: { by: "human", how: "place", from: null, src: filePath(glyph) },
    });
    status(`${filePath(glyph)} placed — it rewrites itself as the glyph grows`);
  }

  /** clear air inside the frame the reader is looking at, else the middle of it */
  function freeSpot(): { x: number; y: number } {
    const r = viewport.getBoundingClientRect();
    const a = camera.screenToWorld(0, 0);
    const b = camera.screenToWorld(r.width, r.height);
    const startX = Math.round(a.x + (b.x - a.x) * 0.55);
    const startY = Math.round(a.y + (b.y - a.y) * 0.2);
    for (let i = 0; i < 12; i += 1) {
      const x = startX + (i % 3) * (FILE_W + 40);
      const y = startY + Math.floor(i / 3) * (FILE_H + 40);
      if (!collides(x, y)) return { x, y };
    }
    return { x: startX, y: startY };
  }

  function collides(x: number, y: number): boolean {
    const pad = 16;
    for (const n of board.nodes()) {
      if (
        x < n.x + n.width + pad &&
        x + FILE_W + pad > n.x &&
        y < n.y + n.height + pad &&
        y + FILE_H + pad > n.y
      ) {
        return true;
      }
    }
    return false;
  }

  // ---- handoff ------------------------------------------------------------

  /** the glyph as a line of thought: what PowerSet's composer would receive */
  function handOff(): boolean {
    const glyph = selected;
    if (!glyph) return false;
    const stamps = board.stampsOf(glyph);
    const cards = new Set(stamps.map((s) => s.nodeId));
    host.sendToComposer(
      `glyph: ${glyphChar(glyph)} ${glyph} (${count(stamps.length, "passage")} · ` +
        `${count(cards.size, "card")}) — ${filePath(glyph)}`,
    );
    for (const stamp of stamps) {
      host.sendToComposer(`    > ${mdText(stamp.quote)}`);
      const node = board.node(stamp.nodeId);
      host.sendToComposer(`      from ${node ? refOf(node) : "(card gone)"}`);
    }
    status(`handed off ${glyphChar(glyph)} ${glyph} — ${count(stamps.length, "passage")}`);
    return true;
  }

  // ---- input --------------------------------------------------------------

  /** an atom is a control, not paper: it must not start a card drag or a pan */
  function onPointerDownCapture(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest(".glyph-atom")) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const hit = e.target.closest<HTMLElement>(".glyph-atom, .glyph-mark");
    const glyph = hit?.dataset["glyph"];
    if (!glyph) return;
    // a click that ENDED a text drag is somebody choosing words, not grabbing a
    // glyph — the fiber pill is about to rise on that selection, leave it alone
    const live = window.getSelection();
    if (hit.classList.contains("glyph-mark") && live !== null && !live.isCollapsed) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected === glyph) clear();
    else select(glyph, { zoom: false });
  }

  function onPaperDown(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".card, .edge-hit, .thread-plate, .fiber-pill")) return;
    clear();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") clear();
  }

  viewport.addEventListener("pointerdown", onPointerDownCapture, true);
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("pointerdown", onPaperDown);
  window.addEventListener("keydown", onKeyDown);

  const unsubscribe = board.onChange((change: Change) => {
    if (change.kind === "position" || change.kind === "meta" || change.kind === "threads") return;
    if (change.kind === "reset") {
      selected = null;
      written.clear();
      options.onSelect?.(null);
    }
    // a `marks` change re-writes fiber spans in a body but never removes ours,
    // so only the changes that can move a STAMP are worth a redraw
    if (change.kind === "marks") return;
    const ids = change.kind === "content" || change.kind === "glyphs" ? change.nodeIds : null;
    if (!ids || ids.length === 0) apply();
    else for (const id of ids) apply(id);
    if (change.kind !== "content") scheduleFiles();
  });

  apply();
  scheduleFiles();

  return {
    selected: () => selected,
    select,
    clear,
    present,
    handOff,
    placeFile,
    apply,
    destroy() {
      if (fileTimer !== 0) window.clearTimeout(fileTimer);
      unsubscribe();
      viewport.removeEventListener("pointerdown", onPointerDownCapture, true);
      viewport.removeEventListener("click", onClick, true);
      viewport.removeEventListener("pointerdown", onPaperDown);
      window.removeEventListener("keydown", onKeyDown);
      selected = null;
      for (const n of board.nodes()) {
        const el = options.getCardEl(n.id);
        if (!el) continue;
        paintBody(el, []);
        paintHead(el, []);
        el.removeAttribute("data-glyphsel");
      }
    },
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
