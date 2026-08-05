// providers/source.ts — the seam every content mode implements.
//
// trail.ts and cards.ts know only this interface: they never import wiki.ts or
// folder.ts directly, so switching content mode is swapping one object.

import DOMPurify from "dompurify";
import type { ContentMode, NodeKind } from "../model";

export interface LoadedBody {
  /** canonical title, when the provider knows better than the link text */
  title?: string;
  /** sanitized, link-normalized HTML — safe to assign to innerHTML */
  html: string;
}

export interface LinkTarget {
  kind: NodeKind;
  /** identity inside this mode — wiki title or folder-relative path */
  ref: string;
  title: string;
}

export interface ContentSource {
  readonly mode: ContentMode;
  readonly nodeKind: NodeKind;
  /** one line of mono chrome under a card title */
  label(ref: string): string;
  /** cheap first paint while the full body is in flight; null when unavailable */
  preview?(ref: string): Promise<LoadedBody | null>;
  load(ref: string): Promise<LoadedBody>;
  /** an anchor inside a card body → something spawnable, or null to ignore it */
  resolveLink(href: string, fromRef: string, text: string): LinkTarget | null;
}

export const LINK_REF_ATTR = "data-loom-ref";
export const LINK_ROLE_ATTR = "data-loom-link";

/**
 * Sanitize, then tag anchors. Tagging *after* DOMPurify means our own
 * attributes can never be laundered in from the source document.
 */
export function sanitizeBody(dirty: string, tagAnchor: (a: HTMLAnchorElement) => void): string {
  const frag = DOMPurify.sanitize(dirty, { RETURN_DOM_FRAGMENT: true });
  const host = document.createElement("div");
  host.appendChild(frag);
  for (const a of Array.from(host.querySelectorAll("a"))) {
    a.removeAttribute(LINK_REF_ATTR);
    a.removeAttribute(LINK_ROLE_ATTR);
    a.removeAttribute("target");
    tagAnchor(a);
  }
  // ids would collide across cards and mean nothing once the article is a card
  for (const el of Array.from(host.querySelectorAll("[id]"))) el.removeAttribute("id");
  return host.innerHTML;
}
