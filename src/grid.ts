// grid.ts — the faint dot ground.
//
// Not decoration: on empty paper the grid is the only thing that proves the
// camera moved. It lives in a viewport-sized <svg> *under* #world (not as a
// CSS background on #world, which is a zero-size transform container), and is
// re-parameterised from the camera each frame so it reads as world-fixed:
// dots sit on world multiples of `step` and scale with z.
//
// The spacing halves/doubles by zoom decade so the screen spacing stays in a
// narrow band — at z=0.05 a fixed world step would collapse into a grey wash,
// which would break the "reading surfaces stay clean" rule.

import type { Camera } from "./camera";

const SVG_NS = "http://www.w3.org/2000/svg";
/** world units at z=1 */
const BASE_STEP = 48;
/** preferred on-screen spacing, px */
const TARGET_SCREEN_STEP = 56;
const DOT_RADIUS = 0.9;

export interface Grid {
  destroy(): void;
}

export function createGrid(viewport: HTMLElement, camera: Camera): Grid {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("id", "grid");

  const defs = document.createElementNS(SVG_NS, "defs");
  const pattern = document.createElementNS(SVG_NS, "pattern");
  pattern.setAttribute("id", "grid-dot");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", String(DOT_RADIUS));
  pattern.appendChild(dot);
  defs.appendChild(pattern);

  const fill = document.createElementNS(SVG_NS, "rect");
  fill.setAttribute("width", "100%");
  fill.setAttribute("height", "100%");
  fill.setAttribute("fill", "url(#grid-dot)");

  svg.appendChild(defs);
  svg.appendChild(fill);
  viewport.insertBefore(svg, viewport.firstChild);

  let lastStep = 0;
  let lastOffX = NaN;
  let lastOffY = NaN;

  const unsubscribe = camera.onChange((state) => {
    const decade = Math.round(Math.log2(TARGET_SCREEN_STEP / (BASE_STEP * state.z)));
    const step = BASE_STEP * Math.pow(2, decade);
    const screenStep = step * state.z;
    if (!Number.isFinite(screenStep) || screenStep <= 0) return;

    if (screenStep !== lastStep) {
      lastStep = screenStep;
      pattern.setAttribute("width", String(screenStep));
      pattern.setAttribute("height", String(screenStep));
      dot.setAttribute("cx", String(screenStep / 2));
      dot.setAttribute("cy", String(screenStep / 2));
    }

    // world origin sits at state.x/state.y; back the tile off by half a cell so
    // dot centres land on world multiples of `step`, not tile corners.
    const offX = mod(state.x - screenStep / 2, screenStep);
    const offY = mod(state.y - screenStep / 2, screenStep);
    if (offX !== lastOffX) {
      lastOffX = offX;
      pattern.setAttribute("x", String(offX));
    }
    if (offY !== lastOffY) {
      lastOffY = offY;
      pattern.setAttribute("y", String(offY));
    }
  });

  return {
    destroy() {
      unsubscribe();
      svg.remove();
    },
  };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
