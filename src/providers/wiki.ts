// providers/wiki.ts — Wikipedia REST as a content source.
//
// The Wikiboard trick (brief §Two content modes): a dense, real, infinite linked
// corpus is the only way to tangle a board fast enough to feel-test topology.
// Lorem ipsum lies.
//
// Two endpoints: `page/summary` lands a readable card in ~one round trip, then
// `page/html` (Parsoid) replaces the body with the link-dense real article. Both
// are cached in memory for the session — re-treading a trail must be instant, or
// the topology toggle is measuring latency instead of legibility.

import { normalizeRef } from "../model";
import { LINK_REF_ATTR, LINK_ROLE_ATTR, sanitizeBody } from "./source";
import type { ContentSource, LinkTarget, LoadedBody } from "./source";

const API = "https://en.wikipedia.org/api/rest_v1";

/** how much of a long article to keep — enough links to tangle, not the whole tail */
const MAX_SECTIONS = 8;

/** Parsoid furniture that is noise once an article is a card */
const STRIP = [
  "style",
  "link",
  "meta",
  "script",
  "noscript",
  "img",
  "figure",
  "audio",
  "video",
  "table.infobox",
  "table.sidebar",
  "table.ambox",
  ".mw-editsection",
  ".mw-empty-elt",
  ".navbox",
  ".metadata",
  ".reflist",
  ".mw-references-wrap",
  ".mw-ref",
  ".shortdescription",
  ".noprint",
].join(",");

export function titleToRef(raw: string): string {
  let t = raw.trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* malformed escape — use it raw */
  }
  return t.replace(/_/g, " ").replace(/\s+/g, " ");
}

function apiTitle(ref: string): string {
  return encodeURIComponent(ref.trim().replace(/ /g, "_"));
}

/** an href from Parsoid output → the wiki title it points at, or null */
export function wikiTitleFromHref(href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (raw.startsWith("./")) return trimTitle(raw.slice(2));
  const m = /^(?:https?:)?\/\/(?:[a-z-]+\.)?wikipedia\.org\/wiki\/(.+)$/i.exec(raw);
  if (m?.[1]) return trimTitle(m[1]);
  if (/^https?:/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return trimTitle(raw);
}

function trimTitle(slug: string): string | null {
  const cut = slug.split("#")[0]?.split("?")[0] ?? "";
  if (!cut) return null;
  const title = titleToRef(cut);
  // namespaced pages (File:, Help:, Template:…) are not articles worth spawning
  if (/^(file|image|template|category|help|special|portal|wikipedia|talk|module):/i.test(title)) {
    return null;
  }
  return title || null;
}

export function createWikiSource(): ContentSource {
  const bodies = new Map<string, LoadedBody>();
  const previews = new Map<string, LoadedBody>();
  const inflight = new Map<string, Promise<LoadedBody>>();

  function tagAnchor(a: HTMLAnchorElement): void {
    const href = a.getAttribute("href") ?? "";
    const title = wikiTitleFromHref(href);
    if (title) {
      a.setAttribute(LINK_REF_ATTR, title);
      a.setAttribute(LINK_ROLE_ATTR, "internal");
      a.setAttribute("href", `https://en.wikipedia.org/wiki/${apiTitle(title)}`);
      return;
    }
    a.setAttribute(LINK_ROLE_ATTR, href.startsWith("#") ? "skip" : "external");
  }

  async function fetchSummary(ref: string): Promise<LoadedBody | null> {
    const key = normalizeRef(ref);
    const hit = previews.get(key);
    if (hit) return hit;
    const res = await fetch(`${API}/page/summary/${apiTitle(ref)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null) return null;
    const rec = json as Record<string, unknown>;
    const extract = typeof rec["extract"] === "string" ? rec["extract"] : "";
    const canonical = typeof rec["title"] === "string" ? rec["title"] : ref;
    if (!extract) return null;
    const body: LoadedBody = {
      title: canonical,
      html: sanitizeBody(`<p>${escapeHtml(extract)}</p>`, tagAnchor),
    };
    previews.set(key, body);
    return body;
  }

  async function fetchArticle(ref: string): Promise<LoadedBody> {
    const res = await fetch(`${API}/page/html/${apiTitle(ref)}`, {
      headers: { accept: "text/html" },
    });
    if (!res.ok) throw new Error(`wikipedia ${res.status} for "${ref}"`);
    const raw = await res.text();
    const doc = new DOMParser().parseFromString(raw, "text/html");
    const body = doc.body;

    const sections = Array.from(body.querySelectorAll(":scope > section"));
    if (sections.length > MAX_SECTIONS) {
      for (const s of sections.slice(MAX_SECTIONS)) s.remove();
    }
    for (const el of Array.from(body.querySelectorAll(STRIP))) el.remove();

    const canonical = doc.querySelector("title")?.textContent?.trim();
    return {
      ...(canonical ? { title: canonical } : {}),
      html: sanitizeBody(body.innerHTML, tagAnchor),
    };
  }

  return {
    mode: "wiki",
    nodeKind: "wiki",

    label(ref) {
      return `wiki · ${ref.replace(/ /g, "_")}`;
    },

    async preview(ref) {
      try {
        return await fetchSummary(ref);
      } catch {
        return null;
      }
    },

    async load(ref) {
      const key = normalizeRef(ref);
      const cached = bodies.get(key);
      if (cached) return cached;
      const pending = inflight.get(key);
      if (pending) return pending;
      const run = fetchArticle(ref)
        .then((body) => {
          bodies.set(key, body);
          return body;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, run);
      return run;
    },

    resolveLink(href, _fromRef, _text) {
      const title = wikiTitleFromHref(href);
      if (!title) return null;
      // deliberately the *article* title, not the link text: two links reading
      // "universal machine" and "Turing machine" must land on one identity, or
      // the linkback/return modes would never recognise a revisit.
      return { kind: "wiki", ref: title, title };
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
