// host.ts — every environment touch goes through this seam (brief §Ground rules).
//
// Two impls: localStorage (the default, key `loom:board`) and a File System
// Access path. `sendToComposer` is not a stub in spirit: the #composer strip is
// a visible, read-only log of exactly what a handoff would type into PowerSet's
// composer. We need to *see* it.
//
// A board file can be BOUND: once open… or save… hands back a writable handle,
// the debounced autosave writes that real file on every change, so a board can
// be hand-edited, re-opened, A/B'd, and round-tripped through an agent — which
// is the whole reason the format is JSON Canvas. localStorage is never dropped;
// it stays the fallback and keeps taking every write.

export interface Host {
  readonly name: string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  sendToComposer(text: string): void;
  /** best-effort; null when the platform has no picker or the user cancels */
  pickFolder(): Promise<FileSystemDirectoryHandle | null>;
  /** write the board file through to a real file from now on (null unbinds) */
  bindFile(handle: FileSystemFileHandle | null): void;
  /** the bound file's name, if the board is writing to disk */
  boundFile(): string | null;
}

interface FilePickerOptions {
  suggestedName?: string;
  multiple?: boolean;
  mode?: "read" | "readwrite";
  types?: { description?: string; accept: Record<string, string[]> }[];
}

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
  }
}

/** the permission methods are not in lib.dom yet; treat them as best-effort */
interface Permissioned {
  queryPermission?: (d: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

export const STORAGE_KEY = "loom:board";
/** the one path that is a real file when a handle is bound */
const BOARD_FILE = "board.canvas";

const CANVAS_TYPES = [
  { description: "JSON Canvas", accept: { "application/json": [".canvas", ".json"] } },
];

export function supportsFileSystemAccess(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/** the "load…" affordance only exists where the picker does */
export function supportsOpenFilePicker(): boolean {
  return typeof window.showOpenFilePicker === "function";
}

export function createLocalStorageHost(composer: HTMLElement): Host {
  let bound: FileSystemFileHandle | null = null;

  return {
    name: "localStorage",

    async readFile(path) {
      try {
        return window.localStorage.getItem(storageKey(path));
      } catch {
        return null;
      }
    },

    async writeFile(path, text) {
      // localStorage first and always: the file is the durable copy, the key is
      // the one that survives a browser with no picker and a reload with no
      // re-pick, and a board that only lived in a file would vanish on reload.
      try {
        window.localStorage.setItem(storageKey(path), text);
      } catch (err) {
        throw new Error(`loom: could not write ${path}: ${String(err)}`);
      }
      if (!bound || path !== BOARD_FILE) return;
      const handle = bound;
      try {
        if (!(await writable(handle))) throw new Error("permission to write was withdrawn");
        const stream = await handle.createWritable();
        await stream.write(text);
        await stream.close();
      } catch (err) {
        // stop pretending: unbind, and let the readout say the file went away
        bound = null;
        throw new Error(`loom: ${handle.name} is no longer being written (${String(err)})`);
      }
    },

    sendToComposer(text) {
      appendToComposer(composer, text);
    },

    async pickFolder() {
      const picker = window.showDirectoryPicker;
      if (!picker) return null;
      try {
        return await picker({ mode: "read" });
      } catch {
        return null; // user cancelled
      }
    },

    bindFile(handle) {
      bound = handle;
    },

    boundFile: () => bound?.name ?? null,
  };
}

async function writable(handle: FileSystemFileHandle): Promise<boolean> {
  const p = handle as FileSystemFileHandle & Permissioned;
  if (!p.queryPermission) return true; // no permission API: try the write itself
  const state = await p.queryPermission({ mode: "readwrite" });
  if (state === "granted") return true;
  if (!p.requestPermission) return false;
  return (await p.requestPermission({ mode: "readwrite" })) === "granted";
}

function storageKey(path: string): string {
  return path === BOARD_FILE ? STORAGE_KEY : `loom:${path}`;
}

/** append one line to the visible composer strip; returns the line element */
export function appendToComposer(composer: HTMLElement, text: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "composer-line";
  line.textContent = text;
  composer.appendChild(line);
  composer.scrollTop = composer.scrollHeight;
  return line;
}

/** what a disk save produced: whether it landed, and a handle worth keeping */
export interface DiskSave {
  ok: boolean;
  /** present only on the FS Access path — bind it and autosave writes the file */
  handle: FileSystemFileHandle | null;
}

/**
 * Explicit "save to disk". Uses the FS Access picker when present and falls
 * back to a plain download — no dependency, no silent failure. The handle comes
 * back so the caller can keep writing to that file.
 */
export async function saveTextToDisk(text: string, suggestedName: string): Promise<DiskSave> {
  const picker = window.showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: CANVAS_TYPES });
      const stream = await handle.createWritable();
      await stream.write(text);
      await stream.close();
      return { ok: true, handle };
    } catch {
      return { ok: false, handle: null }; // cancelled or denied
    }
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, handle: null };
}

export interface DiskOpen {
  name: string;
  text: string;
  /** null when the file could be read but not kept writable */
  handle: FileSystemFileHandle | null;
}

/**
 * Explicit "open a board file". Asks for readwrite up front so the same handle
 * can carry the autosave afterwards; a read-only grant still opens the board,
 * it just does not bind.
 */
export async function openTextFromDisk(): Promise<DiskOpen | null> {
  const picker = window.showOpenFilePicker;
  if (!picker) return null;
  let handle: FileSystemFileHandle | undefined;
  try {
    const picked = await picker({ multiple: false, mode: "readwrite", types: CANVAS_TYPES });
    handle = picked[0];
  } catch {
    return null; // cancelled or denied
  }
  if (!handle) return null;
  const file = await handle.getFile();
  const text = await file.text();
  const keep = await writable(handle).catch(() => false);
  return { name: handle.name, text, handle: keep ? handle : null };
}
