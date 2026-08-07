// quotes.ts — anchoring a stored quote back into a live card body.
//
// Extracted from fibers.ts (wave-2 §2) because there are now TWO species of
// mark that anchor the same way and must not drift apart:
//
//   fibers  (--sig hairline)  — this sentence mattered *here*
//   glyphs  (ink atom)        — this sentence is an instance of a thought that
//                               recurs in several places
//
// The rule both obey (ARCHITECTURE.md): a mark anchors by its QUOTED TEXT, at
// the first occurrence, never by an offset. Provider HTML is re-fetched and
// re-assigned wholesale, so an index would rot silently; a quote either matches
// or it does not, and a quote that no longer occurs draws NOTHING rather than
// underlining the wrong words.
//
// Matching is over the body's text with runs of whitespace collapsed, through a
// char→text-node map, so a quote crossing <a>/<i>/<b> boundaries wraps once per
// text node and still reads as one continuous mark.
//
// Note for anyone adding a third decorator: whatever you insert into a body must
// contribute NO text nodes, or it corrupts this index for the other species.
// That is why glyph atoms carry their character in a CSS `content:` (see
// styles.css `.glyph-atom`), not as a text child.

/** one line, one space between words — what gets stored, matched and typed */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * PILL LENGTH (wave-2 §4, critique-ledger item 7). The composer strip is a
 * strip: a handoff that pastes six 400-character Wikipedia sentences into it is
 * unreadable, and the full text is already kept in two better places (the board
 * file and `marks/<glyph>.md`). So every quote the chrome echoes — the status
 * line, a note's title, a handoff — is elided to the same length, and the
 * ellipsis is the honest signal that there is more where that came from.
 */
export const ECHO = 48;

export function elide(text: string, max = ECHO): string {
  const one = collapse(text);
  if (one.length <= max) return one;
  // break on a word boundary when there is one near the end, else hard-cut
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

interface Slot {
  node: Text;
  offset: number;
}

/** the body's text with runs of whitespace collapsed, plus a char→node map */
export function indexBody(root: HTMLElement): { text: string; slots: Slot[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const slots: Slot[] = [];
  let text = "";
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const t = n as Text;
    const data = t.data;
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i] ?? "";
      if (/\s/.test(ch)) {
        if (text.length === 0 || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += ch;
      }
      slots.push({ node: t, offset: i });
    }
  }
  return { text, slots };
}

/**
 * Wrap the first occurrence of `quote` in `root`, one element per text node the
 * quote crosses. Returns the wrappers in document order — empty when the quote
 * is not present, which is the honest failure.
 */
export function wrapQuote(
  root: HTMLElement,
  quote: string,
  make: () => HTMLElement,
): HTMLElement[] {
  const wanted = collapse(quote);
  if (wanted.length < 2) return [];
  const { text, slots } = indexBody(root);
  const at = text.indexOf(wanted);
  if (at < 0) return [];

  type Run = { node: Text; start: number; end: number };
  const runs: Run[] = [];
  for (let i = at; i < at + wanted.length; i += 1) {
    const slot = slots[i];
    if (!slot) break;
    const last = runs[runs.length - 1];
    if (last && last.node === slot.node && last.end === slot.offset) {
      last.end = slot.offset + 1;
      continue;
    }
    runs.push({ node: slot.node, start: slot.offset, end: slot.offset + 1 });
  }

  const out: HTMLElement[] = [];
  for (const run of runs) {
    let target = run.node;
    if (run.start > 0) target = target.splitText(run.start);
    if (run.end - run.start < target.data.length) target.splitText(run.end - run.start);
    const parent = target.parentNode;
    if (!parent) continue;
    const span = make();
    parent.insertBefore(span, target);
    span.appendChild(target);
    out.push(span);
  }
  return out;
}

/** take every wrapper matching `selector` back off, leaving the text as it was */
export function unwrapAll(root: HTMLElement, selector: string): void {
  const spans = Array.from(root.querySelectorAll<HTMLElement>(selector));
  if (spans.length === 0) return;
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  root.normalize();
}
