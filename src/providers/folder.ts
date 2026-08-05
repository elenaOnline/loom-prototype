// providers/folder.ts — a local folder as a content source (FS Access API).
//
// The other half of the brief: sparse links between real work docs. Kept
// deliberately simple — one recursive index at open time, `marked` for the
// body, relative `.md` links resolved against the linking file's directory.
// No watching, no writes: reading is enough to feel-test trail topology.

import { marked } from "marked";
import { LINK_REF_ATTR, LINK_ROLE_ATTR, sanitizeBody } from "./source";
import type { ContentSource, LinkTarget, LoadedBody } from "./source";

const MD_EXT = /\.(md|markdown|txt)$/i;
const MAX_DEPTH = 4;
const MAX_FILES = 600;

export interface FolderSource extends ContentSource {
  readonly folderName: string;
  /** every indexed markdown path, relative to the picked folder */
  entries(): string[];
}

/** normalize "a/./b/../c.md" → "a/c.md"; leading "./" and "/" are dropped */
export function resolvePath(fromDir: string, href: string): string {
  const base = href.startsWith("/") ? [] : fromDir.split("/").filter(Boolean);
  for (const part of href.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  const tail = path.split("/").pop() ?? path;
  return tail.replace(MD_EXT, "");
}

interface DirEntries {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export async function createFolderSource(
  root: FileSystemDirectoryHandle,
): Promise<FolderSource> {
  const files = new Map<string, FileSystemFileHandle>();
  await index(root, "", 0, files);

  const bodies = new Map<string, LoadedBody>();

  function tagAnchor(fromRef: string): (a: HTMLAnchorElement) => void {
    const dir = dirName(fromRef);
    return (a) => {
      const href = a.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) {
        a.setAttribute(LINK_ROLE_ATTR, "skip");
        return;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
        a.setAttribute(LINK_ROLE_ATTR, "external");
        return;
      }
      const ref = matchRef(resolvePath(dir, href.split("#")[0] ?? ""));
      if (!ref) {
        a.setAttribute(LINK_ROLE_ATTR, "missing");
        return;
      }
      a.setAttribute(LINK_REF_ATTR, ref);
      a.setAttribute(LINK_ROLE_ATTR, "internal");
    };
  }

  /** a resolved path → an indexed file, trying the bare name then `.md` */
  function matchRef(path: string): string | null {
    if (!path) return null;
    if (files.has(path)) return path;
    for (const ext of [".md", ".markdown", ".txt"]) {
      if (files.has(path + ext)) return path + ext;
    }
    const index = `${path}/index.md`;
    return files.has(index) ? index : null;
  }

  return {
    mode: "folder",
    nodeKind: "doc",
    folderName: root.name,
    entries: () => Array.from(files.keys()).sort(),

    label(ref) {
      return `${root.name}/${ref}`;
    },

    async load(ref): Promise<LoadedBody> {
      const cached = bodies.get(ref);
      if (cached) return cached;
      const handle = files.get(ref);
      if (!handle) throw new Error(`not in folder: ${ref}`);
      const text = await (await handle.getFile()).text();
      const rendered = MD_EXT.test(ref) && !/\.txt$/i.test(ref)
        ? marked.parse(text, { async: false })
        : `<pre>${text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`;
      const body: LoadedBody = {
        title: firstHeading(text) ?? baseName(ref),
        html: sanitizeBody(rendered, tagAnchor(ref)),
      };
      bodies.set(ref, body);
      return body;
    },

    resolveLink(href, fromRef, _text): LinkTarget | null {
      if (!href || href.startsWith("#")) return null;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
      const ref = matchRef(resolvePath(dirName(fromRef), href.split("#")[0] ?? ""));
      if (!ref) return null;
      return { kind: "doc", ref, title: baseName(ref) };
    },
  };
}

async function index(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  out: Map<string, FileSystemFileHandle>,
): Promise<void> {
  if (depth > MAX_DEPTH || out.size >= MAX_FILES) return;
  const iterable = dir as unknown as DirEntries;
  for await (const [name, handle] of iterable.entries()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await index(handle as FileSystemDirectoryHandle, path, depth + 1, out);
    } else if (MD_EXT.test(name)) {
      out.set(path, handle as FileSystemFileHandle);
    }
    if (out.size >= MAX_FILES) return;
  }
}

function firstHeading(markdown: string): string | null {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() ?? null;
}
