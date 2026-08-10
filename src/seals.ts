// seals.ts — THE CARD-LEVEL GLYPH SPECIES (wave-4 §2).
//
// The passage stamps (glyphs.ts) mark THOUGHTS in text; a seal marks a whole
// CARD, so disparate cards stay connected by a shared mark WITHOUT an edge.
// This module is glyphs.ts's sibling, not its twin: it rhymes — same
// selection-as-a-unit inversion, same chip readout, same file through the Host
// seam — but it never touches a card BODY. A seal has no quote, no margin, no
// text-wrapping machinery; it sits on the card head, and at cloth range on the
// knot itself. That difference is the species line, and it is why the two
// modules share idioms rather than code.
//
// Five verbs, the same shape as the sibling's:
//
//   STAMP     two paths, ONE rule: the card head's ◪ opens a 5-chip popover
//             (one click, no dialog — the fiber pill's discipline: fixed near
//             the button, dead the moment the world moves under it), and
//             shift+1..5 seals the selected card from the keyboard. Both go
//             through `board.addSeal`, where the toggle LIVES — a second stamp
//             of the same glyph is the unstamp, and no gesture path can drift
//             from that.
//   DRAW      the card's seals on the head, right end, before the controls —
//             after the stamp row, so the two species read left-to-right as
//             "what recurs in this card · what this card belongs to". At title
//             range the row counter-scales with the sheet; at cloth range CSS
//             moves the same DOM inside the knot square — the knot CARRIES its
//             seal, visually apart from the stamp constellation floating above.
//   SELECT    click any seal mark (or its toolbar chip) and every card
//             carrying it lights while the cloth recedes — data-sealsel, the
//             established inversion, at the same specificity the glyph layer
//             claims. Mutually exclusive with thread and stamp selections:
//             one recede idiom on stage (main.ts holds the three-way contract).
//   FILE      `marks/seal-<name>.md` regenerated on every change through the
//             Host seam: the seal, then one ref line per carrying card.
//             Files-are-the-API — an agent reads a membership list.
//   HAND      `c` on a selected seal types the membership into the composer:
//             the seal, then every carrying card's ref, one keyed block.
//
// What is deliberately NOT here: edges from a seal to its cards (the §9.3
// answer binds this species too — the set IS the binding), and a placeable
// seal-file card (deliberately not this wave; the file itself is written).

import type { Camera, Insets } from "./camera";
import { boundsFrom, boundsOfRect } from "./camera";
import type { Board, Change, LoomNode, Seal } from "./model";
import { SEAL_PALETTE, sealChar } from "./model";
import type { Host } from "./host";
import { refOf } from "./codec";

/** ms to coalesce file writes: a burst of seals writes the file once */
const FILE_DEBOUNCE = 220;
/** screen px between the ◪ button and the popover */
const POP_LIFT = 6;

export interface SealLayer {
  /** the seal currently selected as a unit, if any */
  selected(): string | null;
  select(glyph: string | null, opts?: { zoom?: boolean }): void;
  clear(): void;
  /** true when a seal was selected and its membership was written out */
  handOff(): boolean;
  /** re-draw the seals on one card (or all of them) */
  apply(nodeId?: string): void;
  destroy(): void;
}

export interface SealLayerOptions {
  board: Board;
  camera: Camera;
  viewport: HTMLElement;
  host: Host;
  /**
   * EVERY placement of the card: a seal binds to the card (contentRoot), so it
   * draws on every window open on it (wave-2 §4). The card layer owns card
   * DOM; this module only decorates its heads.
   */
  getCardEls: (nodeId: string) => HTMLElement[];
  getInsets?: () => Partial<Insets>;
  /** shift+1..5 seals the card in hand — the card layer holds the hand */
  getSelectedCardId: () => string | null;
  onStatus?: (text: string) => void;
  /** a seal selection claims the same cloth threads and stamps claim */
  onSelect?: (glyph: string | null) => void;
}

export function createSealLayer(options: SealLayerOptions): SealLayer {
  const { board, camera, viewport, host } = options;

  let selected: string | null = null;

  function status(text: string): void {
    options.onStatus?.(text);
  }

  // ---- the atom -----------------------------------------------------------
  // The character rides in a CSS custom property, exactly as the glyph atom's
  // does. A head is not indexed for quotes the way a body is, so nothing here
  // NEEDS the text-free rule — but two atom species with two insertion rules
  // would be a trap for the next reader, so the house rule binds both.

  function atom(glyph: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "seal-atom";
    el.dataset["seal"] = glyph;
    el.style.setProperty("--seal-char", JSON.stringify(sealChar(glyph)));
    el.title = `${sealChar(glyph)} ${glyph} — click to light every card carrying this seal`;
    return el;
  }

  // ---- drawing ------------------------------------------------------------

  function apply(nodeId?: string): void {
    if (nodeId === undefined) {
      for (const n of board.nodes()) apply(n.id);
      return;
    }
    const seals = board.sealsOf(nodeId);
    for (const el of options.getCardEls(nodeId)) {
      paintHead(el, seals);
      paintState(el, seals);
    }
  }

  /**
   * The head row — one atom per seal, and never a count: a card carries at
   * most one of each glyph (the model's toggle), so a count would always read
   * "1" and say nothing. The row parks immediately before the controls, and it
   * RE-ASSERTS that seat on every paint: the stamp row (glyphs.ts) parks at
   * the same reference node when it is born, and whichever row moved last
   * would otherwise sit rightmost. Seals are the card's outermost mark — what
   * the card belongs to reads last, right before the chrome.
   */
  function paintHead(el: HTMLElement, seals: Seal[]): void {
    const head = el.querySelector<HTMLElement>(".card-head");
    if (!head) return;
    const existing = head.querySelector<HTMLElement>(":scope > .card-seals");
    if (seals.length === 0) {
      existing?.remove();
      el.removeAttribute("data-seals");
      return;
    }
    el.setAttribute("data-seals", "");
    const row = existing ?? document.createElement("span");
    row.className = "card-seals";
    const frag = document.createDocumentFragment();
    for (const seal of seals) frag.appendChild(atom(seal.glyph));
    row.replaceChildren(frag);
    // insertBefore MOVES a connected node, so this is creation and re-seating
    // in one call — the row ends rightmost whether or not a stamp row was
    // born after it
    head.insertBefore(row, head.querySelector(":scope > .card-controls"));
  }

  /** the stamp row was just (re)born at the controls: take the outer seat back */
  function reseat(nodeId: string): void {
    for (const el of options.getCardEls(nodeId)) {
      const head = el.querySelector<HTMLElement>(".card-head");
      const row = head?.querySelector<HTMLElement>(":scope > .card-seals");
      if (!head || !row) continue;
      head.insertBefore(row, head.querySelector(":scope > .card-controls"));
    }
  }

  /**
   * Selection as INVERSION at the glyph layer's exact specificity: the cards
   * carrying this seal come forward via data-sealsel, everything else recedes,
   * and the atoms of other seals go quiet. Third species, same one idiom.
   */
  function paintState(el: HTMLElement, seals: Seal[]): void {
    if (!selected) el.removeAttribute("data-sealsel");
    else el.setAttribute("data-sealsel", seals.some((s) => s.glyph === selected) ? "in" : "out");
    for (const mark of Array.from(el.querySelectorAll<HTMLElement>(".seal-atom"))) {
      if (!selected) mark.removeAttribute("data-sel");
      else mark.setAttribute("data-sel", mark.dataset["seal"] === selected ? "in" : "out");
    }
  }

  // ---- selection ----------------------------------------------------------

  function present(): string[] {
    const seen = new Set(board.seals().map((s) => s.glyph));
    const out = SEAL_PALETTE.map((g) => g.name).filter((n) => seen.has(n));
    for (const name of seen) {
      if (!out.includes(name)) out.push(name); // a seal the file brought with it
    }
    return out;
  }

  function select(glyph: string | null, opts?: { zoom?: boolean }): void {
    selected = glyph;
    options.onSelect?.(glyph);
    apply();
    if (!glyph) return;
    const cards = board.cardsOfSeal(glyph);
    if (opts?.zoom !== false) frame(cards);
    status(
      cards.length === 0
        ? `${sealChar(glyph)} ${glyph} — no card carries this seal yet`
        : `${sealChar(glyph)} ${glyph} — ${count(cards.length, "card")} · c to hand off`,
    );
  }

  function clear(): void {
    if (!selected) return;
    selected = null;
    options.onSelect?.(null);
    apply();
    status("");
  }

  function frame(ids: readonly string[]): void {
    const bounds = boundsFrom(
      ids
        .map((id) => board.node(id))
        .filter((n): n is LoomNode => n !== undefined)
        .map((n) => boundsOfRect(n.x, n.y, n.width, n.height)),
    );
    if (bounds) camera.flyTo(bounds);
  }

  // ---- stamping -----------------------------------------------------------
  // Both gesture paths end here, and this function is deliberately thin: the
  // toggle is the MODEL's (`addSeal` returns null ⇔ it unsealed), so the
  // popover, the keys, and an agent's file all share one rule.

  function stamp(nodeId: string, glyph: string): void {
    const made = board.addSeal({ glyph, nodeId });
    const n = board.cardsOfSeal(glyph).length;
    status(
      made
        ? `${sealChar(glyph)} ${glyph} sealed — ${count(n, "card")} · marks/${safeName(glyph)}.md`
        : `${sealChar(glyph)} ${glyph} unsealed`,
    );
  }

  // ---- the popover --------------------------------------------------------
  // The fiber pill's discipline, for a click instead of a selection: rise
  // fixed near the ◪ that asked, one click per chip, and die the moment the
  // world moves under it — click-away, any scroll, any camera change. A
  // popover anchored to stale coordinates is worse than no popover.

  let pop: HTMLElement | null = null;
  let popFor: string | null = null;
  let popAnchor: HTMLElement | null = null;

  function openPop(nodeId: string, anchor: HTMLElement): void {
    closePop();
    const el = document.createElement("div");
    el.className = "seal-pop";
    // the popover is chrome over the paper, not paper: its pointerdown must
    // not start a pan (the same guard the fiber pill carries)
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    for (const g of SEAL_PALETTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = sealChar(g.name);
      b.title = `${g.name} — one click seals; the same click on a carried seal takes it off`;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        stamp(nodeId, g.name);
        paintPop();
      });
      el.appendChild(b);
    }
    pop = el;
    popFor = nodeId;
    popAnchor = anchor;
    anchor.setAttribute("data-open", "");
    viewport.appendChild(el);
    paintPop();
    positionPop(anchor);
  }

  /** a chip the card already carries inverts: pressing it takes the seal off */
  function paintPop(): void {
    if (!pop || !popFor) return;
    const carried = new Set(board.sealsOf(popFor).map((s) => s.glyph));
    const chips = Array.from(pop.querySelectorAll<HTMLButtonElement>("button"));
    SEAL_PALETTE.forEach((g, i) => {
      const chip = chips[i];
      if (!chip) return;
      if (carried.has(g.name)) chip.setAttribute("data-active", "");
      else chip.removeAttribute("data-active");
    });
  }

  function positionPop(anchor: HTMLElement): void {
    if (!pop) return;
    const vp = viewport.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const partial = options.getInsets?.() ?? {};
    const top = partial.top ?? 0;
    const bottom = partial.bottom ?? 0;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;

    let x = rect.right - vp.left - w;
    x = Math.max(8, Math.min(vp.width - w - 8, x));

    let y = rect.bottom - vp.top + POP_LIFT;
    // no room under the button → sit above it rather than under the composer
    if (y + h > vp.height - bottom - 4) y = rect.top - vp.top - h - POP_LIFT;
    y = Math.max(top + 4, Math.min(vp.height - bottom - h - 4, y));

    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
  }

  function closePop(): void {
    popAnchor?.removeAttribute("data-open");
    pop?.remove();
    pop = null;
    popFor = null;
    popAnchor = null;
  }

  // ---- input --------------------------------------------------------------

  /** an atom or the ◪ is a control, not paper: no card drag, no pan */
  function onPointerDownCapture(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest(".seal-atom, .card-seal-btn")) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onClickCapture(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>(".card-seal-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const nodeId = btn.closest<HTMLElement>(".card")?.dataset["nodeId"];
      if (!nodeId) return;
      if (pop && popAnchor === btn) closePop();
      else openPop(nodeId, btn);
      return;
    }
    const mark = e.target.closest<HTMLElement>(".seal-atom");
    const glyph = mark?.dataset["seal"];
    if (!glyph) return;
    e.preventDefault();
    e.stopPropagation();
    // a mark click never moves the camera (the chip click is the framing
    // gesture) — the same split the glyph layer keeps
    if (selected === glyph) clear();
    else select(glyph, { zoom: false });
  }

  function onWindowPointerDown(e: PointerEvent): void {
    if (!pop) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".seal-pop")) return;
    // the owning ◪ toggles on click; closing on ITS pointerdown would re-open
    if (target && popAnchor && target.closest(".card-seal-btn") === popAnchor) return;
    closePop();
  }

  function onPaperDown(e: PointerEvent): void {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".card, .edge-hit, .thread-plate, .fiber-pill, .seal-pop")) return;
    clear();
  }

  function onScrollCapture(e: Event): void {
    if (!pop) return;
    if (e.target instanceof Element && e.target.closest(".seal-pop")) return;
    closePop();
  }

  /**
   * shift+1..5 seals the card in hand — by e.code, not e.key: shift turns the
   * digit row into !@#$% on most layouts, and a shortcut that depends on the
   * layout's punctuation is a shortcut that works for one keyboard. Bare 1/2/3
   * stay topology's (ui.ts); the shift is the species line on the keyboard too.
   */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (pop) closePop();
      else clear();
      return;
    }
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const index = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].indexOf(e.code);
    if (index < 0) return;
    const glyph = SEAL_PALETTE[index];
    if (!glyph) return;
    e.preventDefault();
    const id = options.getSelectedCardId();
    if (!id) {
      status("click a card first — shift+1..5 seals the selected card");
      return;
    }
    stamp(id, glyph.name);
  }

  // ---- the seal file ------------------------------------------------------
  // files-are-the-API, the sibling's discipline verbatim: regenerated
  // wholesale on every change rather than patched — the board is the source of
  // truth and the file is its rendering, so there is exactly one way for them
  // to disagree, and it is fixed by writing again. The `seal-` prefix keeps a
  // seal named like a stamp from silently sharing the stamp's file.

  /** filename-safe, because the seal NAME is the file name */
  function safeName(glyph: string): string {
    return glyph.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "seal";
  }

  function filePath(glyph: string): string {
    return `marks/seal-${safeName(glyph)}.md`;
  }

  function refLine(nodeId: string): string {
    const node = board.node(nodeId);
    if (!node) return `- (the card this seal was on has left the board)`;
    const ref = refOf(node);
    if (node.kind === "note") return `- ${ref}`;
    const label = (node.title || node.ref).replace(/[[\]]/g, "");
    return `- [${label}](${ref})`;
  }

  /** the membership, in STAMP order: the order the cards joined */
  function fileText(glyph: string): string {
    const cards = board.cardsOfSeal(glyph);
    const lines: string[] = [
      `# ${sealChar(glyph)} ${glyph}`,
      "",
      count(cards.length, "card"),
      "",
      "*A loom seal file. Regenerated from the board on every change — the board",
      "is the source of truth, so edits here are overwritten.*",
      "",
      "---",
      "",
    ];
    if (cards.length === 0) {
      lines.push("*No card carries this seal.*", "");
    }
    for (const id of cards) lines.push(refLine(id));
    if (cards.length > 0) lines.push("");
    return lines.join("\n");
  }

  /** every seal whose file we have ever written, so an emptied one is cleared */
  const written = new Set<string>();
  let fileTimer = 0;

  function regenerate(): void {
    const names = new Set<string>([...present(), ...written]);
    for (const glyph of names) {
      written.add(glyph);
      void host.writeFile(filePath(glyph), fileText(glyph)).catch(() => {
        status(`could not write ${filePath(glyph)}`);
      });
    }
  }

  function scheduleFiles(): void {
    if (fileTimer !== 0) window.clearTimeout(fileTimer);
    fileTimer = window.setTimeout(() => {
      fileTimer = 0;
      regenerate();
    }, FILE_DEBOUNCE);
  }

  // ---- handoff ------------------------------------------------------------

  /**
   * The seal as a membership: what PowerSet's composer would receive. One
   * keyed block — the seal and its count, then one ref per carrying card. No
   * quotes to elide: a seal never held any, and the file (which the header
   * names by count line convention with the sibling) carries the same list.
   */
  function handOff(): boolean {
    const glyph = selected;
    if (!glyph) return false;
    const cards = board.cardsOfSeal(glyph);
    const lines = [`seal ${sealChar(glyph)} ${glyph} (${count(cards.length, "card")})`];
    for (const id of cards) {
      const node = board.node(id);
      lines.push(`    ${node ? refOf(node) : "(card gone)"}`);
    }
    const result = host.sendBlock(`seal:${glyph}`, lines);
    const how =
      result === "collapsed"
        ? " (already in the strip — marked ×n)"
        : result === "replaced"
          ? " (replaced the earlier copy)"
          : "";
    status(`handed off ${sealChar(glyph)} ${glyph} — ${count(cards.length, "card")}${how}`);
    return true;
  }

  // ---- wiring -------------------------------------------------------------

  viewport.addEventListener("pointerdown", onPointerDownCapture, true);
  viewport.addEventListener("click", onClickCapture, true);
  viewport.addEventListener("pointerdown", onPaperDown);
  window.addEventListener("pointerdown", onWindowPointerDown, true);
  window.addEventListener("scroll", onScrollCapture, true);
  window.addEventListener("keydown", onKeyDown);

  // any camera move invalidates the anchor; the popover goes rather than drifts
  const unwatchCamera = camera.onChange(() => {
    if (pop) closePop();
  });

  const unsubscribe = board.onChange((change: Change) => {
    if (
      change.kind === "position" ||
      change.kind === "meta" ||
      change.kind === "threads" ||
      change.kind === "arrange" ||
      change.kind === "marks" ||
      change.kind === "bookmarks" ||
      change.kind === "view" ||
      // a title change re-writes head text nodes, never our row; the file
      // shows titles but does not chase them, exactly as the sibling's doesn't
      change.kind === "content"
    ) {
      return;
    }
    // a stamp row (re)born at the controls takes our seat; take it back —
    // a reposition, not a repaint, so a stamping burst stays cheap
    if (change.kind === "glyphs") {
      for (const id of change.nodeIds ?? []) reseat(id);
      return;
    }
    if (change.kind === "reset") {
      selected = null;
      written.clear();
      options.onSelect?.(null);
      closePop();
    }
    // graph: a removal may have re-pointed seals at an heir or dropped them —
    // and the popover's card may be gone
    if (change.kind === "graph" && popFor && !board.node(popFor)) closePop();
    const ids = change.kind === "seals" ? change.nodeIds : null;
    if (!ids || ids.length === 0) apply();
    else for (const id of ids) apply(id);
    if (pop) paintPop(); // the carried set under the open popover may have moved
    scheduleFiles();
  });

  apply();
  scheduleFiles();

  return {
    selected: () => selected,
    select,
    clear,
    handOff,
    apply,
    destroy() {
      if (fileTimer !== 0) window.clearTimeout(fileTimer);
      unsubscribe();
      unwatchCamera();
      closePop();
      viewport.removeEventListener("pointerdown", onPointerDownCapture, true);
      viewport.removeEventListener("click", onClickCapture, true);
      viewport.removeEventListener("pointerdown", onPaperDown);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("scroll", onScrollCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      selected = null;
      for (const n of board.nodes()) {
        for (const el of options.getCardEls(n.id)) {
          paintHead(el, []);
          el.removeAttribute("data-sealsel");
        }
      }
    },
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
