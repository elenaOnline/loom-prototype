// camera.ts — the {x,y,z} camera over the loom.
//
// Contract (ARCHITECTURE.md): owns screen<->world conversion, wheel pan,
// ctrl/cmd+wheel zoom *around the cursor*, drag-pan on empty paper,
// zoom-to-fit and animated flyTo, plus an onChange registry for tiers.
// No DOM knowledge beyond applying the transform and reading viewport size.
//
// Feel rules: instant (state is mutated synchronously, only the DOM write is
// RAF-batched), no rubber-banding at the zoom clamps, no cuts (every
// programmatic move eases), and zoom NEVER drifts its anchor point.

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CameraState {
  /** screen px offset of world origin */
  x: number;
  y: number;
  /** scale */
  z: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type CameraListener = (state: Readonly<CameraState>) => void;

export interface FlyOptions {
  /** ms; default 320 */
  duration?: number;
  /** skip the ease and land immediately */
  immediate?: boolean;
}

export interface CameraOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  /** world-space bounds of everything on the board, for fit gestures */
  getContentBounds?: () => Bounds | null;
  /** chrome that overlays the viewport (toolbar / composer), screen px */
  getInsets?: () => Partial<Insets>;
  /** true when an event target counts as empty paper (drag-pan, dbl-click fit) */
  isPaper?: (target: EventTarget | null) => boolean;
  /**
   * true when a wheel event belongs to content rather than the canvas — a card
   * body that can still scroll in that direction. Zoom (ctrl/cmd) always wins.
   */
  shouldIgnoreWheel?: (e: WheelEvent) => boolean;
  /** world px of breathing room left around a fit */
  fitPadding?: number;
}

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  state(): Readonly<CameraState>;
  screenToWorld(screenX: number, screenY: number): Point;
  worldToScreen(worldX: number, worldY: number): Point;
  /** viewport-relative point from a mouse/pointer/wheel event */
  eventPoint(e: { clientX: number; clientY: number }): Point;
  panBy(dxScreen: number, dyScreen: number): void;
  /** multiply zoom, keeping the world point under `anchor` (screen px) fixed */
  zoomAt(anchor: Point, factor: number): void;
  /** set absolute zoom, keeping the world point under `anchor` fixed */
  zoomToAt(anchor: Point, z: number): void;
  moveTo(next: CameraState): void;
  /** the bench-transition primitive: ease the camera until `bounds` is framed */
  flyTo(bounds: Bounds, opts?: FlyOptions): void;
  flyToCamera(target: CameraState, opts?: FlyOptions): void;
  /** frame everything getContentBounds() reports; no-op when the board is empty */
  zoomToFit(opts?: FlyOptions): void;
  cameraForBounds(bounds: Bounds): CameraState;
  /** subscribe; fires once immediately, returns an unsubscribe */
  onChange(cb: CameraListener): () => void;
  destroy(): void;
}

export const MIN_Z = 0.05;
export const MAX_Z = 3;

/** fit never zooms *in* past this — framing three cards shouldn't magnify them */
const MAX_FIT_Z = 1;
/**
 * ...and never zooms *out* past this: below the title band (tiers.ts, 0.18) a
 * fit lands on a board of unreadable glyphs, which is how a fresh two-card board
 * came up looking like a speck. A genuinely huge board is allowed to land AT the
 * floor and overflow the frame — better cropped and legible than complete and
 * illegible.
 */
const MIN_FIT_Z = 0.25;
/** below this the viewport has not been laid out yet; fitting into it is garbage */
const MIN_VIEWPORT_PX = 50;
const DEFAULT_FIT_PADDING = 80;
const DEFAULT_FLY_MS = 320;

/** wheel-delta -> zoom exponent. Tuned against a macOS trackpad pinch. */
const ZOOM_SENSITIVITY = 0.012;
/** cap a single event's zoom step so a coarse mouse wheel can't jump a decade */
const MAX_STEP_FACTOR = 2;

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export function clampZ(z: number): number {
  return Math.min(MAX_Z, Math.max(MIN_Z, z));
}

export function boundsFrom(rects: Iterable<Bounds>): Bounds | null {
  let out: Bounds | null = null;
  for (const b of rects) {
    if (!out) {
      out = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      continue;
    }
    out.minX = Math.min(out.minX, b.minX);
    out.minY = Math.min(out.minY, b.minY);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.maxY = Math.max(out.maxY, b.maxY);
  }
  return out;
}

export function boundsOfRect(x: number, y: number, w: number, h: number): Bounds {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** normalize wheel deltas across deltaMode (pixel / line / page) */
function wheelPixels(e: WheelEvent): Point {
  let sx = e.deltaX;
  let sy = e.deltaY;
  if (e.deltaMode === 1) {
    sx *= 16;
    sy *= 16;
  } else if (e.deltaMode === 2) {
    sx *= window.innerWidth;
    sy *= window.innerHeight;
  }
  return { x: sx, y: sy };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

interface Anim {
  startedAt: number;
  duration: number;
  fromCenter: Point;
  toCenter: Point;
  fromLogZ: number;
  toLogZ: number;
}

export function createCamera(options: CameraOptions): Camera {
  const { viewport, world } = options;
  const fitPadding = options.fitPadding ?? DEFAULT_FIT_PADDING;
  const isPaper =
    options.isPaper ??
    ((target: EventTarget | null): boolean =>
      !(target instanceof Element) || !target.closest(".card"));

  const state: CameraState = { x: 0, y: 0, z: 1 };
  const listeners = new Set<CameraListener>();

  let rafId = 0;
  let dirty = true;
  let anim: Anim | null = null;

  // ---- geometry -----------------------------------------------------------

  function insets(): Insets {
    const partial = options.getInsets?.() ?? NO_INSETS;
    return {
      top: partial.top ?? 0,
      right: partial.right ?? 0,
      bottom: partial.bottom ?? 0,
      left: partial.left ?? 0,
    };
  }

  function viewportRect(): DOMRect {
    return viewport.getBoundingClientRect();
  }

  function screenToWorld(sx: number, sy: number): Point {
    return { x: (sx - state.x) / state.z, y: (sy - state.y) / state.z };
  }

  function worldToScreen(wx: number, wy: number): Point {
    return { x: wx * state.z + state.x, y: wy * state.z + state.y };
  }

  function eventPoint(e: { clientX: number; clientY: number }): Point {
    const r = viewportRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** centre of the viewport region not covered by chrome, in screen px */
  function usableCenter(): Point {
    const r = viewportRect();
    const i = insets();
    return {
      x: (i.left + (r.width - i.right)) / 2,
      y: (i.top + (r.height - i.bottom)) / 2,
    };
  }

  function cameraFromCenter(center: Point, z: number): CameraState {
    const c = usableCenter();
    return { x: c.x - center.x * z, y: c.y - center.y * z, z };
  }

  function centerOf(cam: CameraState): Point {
    const c = usableCenter();
    return { x: (c.x - cam.x) / cam.z, y: (c.y - cam.y) / cam.z };
  }

  function cameraForBounds(bounds: Bounds): CameraState {
    const r = viewportRect();
    const i = insets();
    const availW = Math.max(1, r.width - i.left - i.right - fitPadding * 2);
    const availH = Math.max(1, r.height - i.top - i.bottom - fitPadding * 2);
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const raw = Math.min(availW / bw, availH / bh);
    const z = clampZ(Math.min(MAX_FIT_Z, Math.max(MIN_FIT_Z, raw)));
    const center: Point = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    return cameraFromCenter(center, z);
  }

  // ---- frame loop ---------------------------------------------------------

  function schedule(): void {
    if (rafId === 0) rafId = requestAnimationFrame(frame);
  }

  function invalidate(): void {
    dirty = true;
    schedule();
  }

  function frame(now: number): void {
    rafId = 0;
    if (anim) stepAnim(now);
    if (dirty) apply();
    if (anim) schedule();
  }

  function apply(): void {
    dirty = false;
    world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.z})`;
    // published so world-space rules can divide by it — hairlines stay 1px on
    // screen at every zoom instead of thickening in and vanishing out.
    world.style.setProperty("--z", String(state.z));
    for (const cb of Array.from(listeners)) cb(state);
  }

  function stepAnim(now: number): void {
    const a = anim;
    if (!a) return;
    const raw = a.duration <= 0 ? 1 : (now - a.startedAt) / a.duration;
    const t = raw >= 1 ? 1 : easeInOutCubic(raw < 0 ? 0 : raw);
    // zoom eases geometrically; the framed point eases linearly
    const z = clampZ(Math.exp(a.fromLogZ + (a.toLogZ - a.fromLogZ) * t));
    const center: Point = {
      x: a.fromCenter.x + (a.toCenter.x - a.fromCenter.x) * t,
      y: a.fromCenter.y + (a.toCenter.y - a.fromCenter.y) * t,
    };
    const next = cameraFromCenter(center, z);
    state.x = next.x;
    state.y = next.y;
    state.z = next.z;
    dirty = true;
    if (raw >= 1) anim = null;
  }

  function cancelAnim(): void {
    anim = null;
  }

  // ---- movement -----------------------------------------------------------

  function moveTo(next: CameraState): void {
    state.x = next.x;
    state.y = next.y;
    state.z = clampZ(next.z);
    invalidate();
  }

  function panBy(dx: number, dy: number): void {
    state.x += dx;
    state.y += dy;
    invalidate();
  }

  function zoomToAt(anchor: Point, z: number): void {
    const next = clampZ(z);
    if (next === state.z) return;
    // world point under the anchor, computed from live state (never from the DOM)
    const wx = (anchor.x - state.x) / state.z;
    const wy = (anchor.y - state.y) / state.z;
    state.z = next;
    // ...pinned back under the same screen point. Exact by construction.
    state.x = anchor.x - wx * next;
    state.y = anchor.y - wy * next;
    invalidate();
  }

  function zoomAt(anchor: Point, factor: number): void {
    zoomToAt(anchor, state.z * factor);
  }

  function flyToCamera(target: CameraState, opts?: FlyOptions): void {
    const z = clampZ(target.z);
    const settled: CameraState = { x: target.x, y: target.y, z };
    if (opts?.immediate) {
      cancelAnim();
      moveTo(settled);
      return;
    }
    const near =
      Math.abs(settled.x - state.x) < 0.5 &&
      Math.abs(settled.y - state.y) < 0.5 &&
      Math.abs(settled.z - state.z) < 0.0005;
    if (near) {
      cancelAnim();
      moveTo(settled);
      return;
    }
    anim = {
      startedAt: performance.now(),
      duration: opts?.duration ?? DEFAULT_FLY_MS,
      fromCenter: centerOf(state),
      toCenter: centerOf(settled),
      fromLogZ: Math.log(state.z),
      toLogZ: Math.log(z),
    };
    schedule();
  }

  function flyTo(bounds: Bounds, opts?: FlyOptions): void {
    flyToCamera(cameraForBounds(bounds), opts);
  }

  /** true before first layout (and in a hidden/headless frame): fitting is a lie */
  function degenerateViewport(): boolean {
    const r = viewportRect();
    return r.width < MIN_VIEWPORT_PX || r.height < MIN_VIEWPORT_PX;
  }

  /** a fit asked for before the frame had a size, held until it has one */
  let pendingFit: FlyOptions | null = null;

  function zoomToFit(opts?: FlyOptions): void {
    if (degenerateViewport()) {
      // a fit computed against a 0-height frame clamps to MIN_Z and the board
      // opens as a speck; wait for the first real layout tick instead
      pendingFit = opts ?? {};
      return;
    }
    const bounds = options.getContentBounds?.() ?? null;
    if (!bounds) return;
    flyTo(bounds, opts);
  }

  function runPendingFit(): void {
    if (!pendingFit || degenerateViewport()) return;
    const opts = pendingFit;
    pendingFit = null;
    zoomToFit(opts);
  }

  // ---- input --------------------------------------------------------------

  function onWheel(e: WheelEvent): void {
    const zooming = e.ctrlKey || e.metaKey;
    // reading a long article is scrolling a card, not panning the cloth; let the
    // browser have the event until the body hits its end, then pan as usual
    if (!zooming && options.shouldIgnoreWheel?.(e)) return;
    e.preventDefault();
    cancelAnim();
    const d = wheelPixels(e);
    if (zooming) {
      // macOS trackpad pinch arrives here as ctrl+wheel
      let factor = Math.exp(-d.y * ZOOM_SENSITIVITY);
      factor = Math.min(MAX_STEP_FACTOR, Math.max(1 / MAX_STEP_FACTOR, factor));
      zoomAt(eventPoint(e), factor);
      return;
    }
    // shift+wheel gives a horizontal axis to single-axis mice
    if (e.shiftKey && d.x === 0) {
      panBy(-d.y, 0);
      return;
    }
    panBy(-d.x, -d.y);
  }

  let panPointer: number | null = null;
  let panStart: Point = { x: 0, y: 0 };
  let panOrigin: Point = { x: 0, y: 0 };

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || panPointer !== null) return;
    if (!isPaper(e.target)) return;
    cancelAnim();
    panPointer = e.pointerId;
    panStart = eventPoint(e);
    panOrigin = { x: state.x, y: state.y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent): void {
    if (panPointer !== e.pointerId) return;
    const p = eventPoint(e);
    // absolute from the grab point — deltas can't accumulate drift
    moveTo({
      x: panOrigin.x + (p.x - panStart.x),
      y: panOrigin.y + (p.y - panStart.y),
      z: state.z,
    });
  }

  function endPan(e: PointerEvent): void {
    if (panPointer !== e.pointerId) return;
    panPointer = null;
    viewport.classList.remove("panning");
    if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
  }

  function onDoubleClick(e: MouseEvent): void {
    if (!isPaper(e.target)) return;
    e.preventDefault();
    zoomToFit();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      zoomToFit();
    }
  }

  function onResize(): void {
    invalidate();
    runPendingFit();
  }

  // a first layout does not always arrive as a window resize (fonts, a hidden
  // pane opening, a headless first paint), so watch the frame itself too
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => onResize());
  observer?.observe(viewport);

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  invalidate();

  return {
    get x() {
      return state.x;
    },
    get y() {
      return state.y;
    },
    get z() {
      return state.z;
    },
    state: () => state,
    screenToWorld,
    worldToScreen,
    eventPoint,
    panBy,
    zoomAt,
    zoomToAt,
    moveTo,
    flyTo,
    flyToCamera,
    zoomToFit,
    cameraForBounds,
    onChange(cb: CameraListener) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    destroy() {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
      anim = null;
      pendingFit = null;
      observer?.disconnect();
      listeners.clear();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", endPan);
      viewport.removeEventListener("pointercancel", endPan);
      viewport.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    },
  };
}
