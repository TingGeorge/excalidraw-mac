// WebKit has no CanvasRenderingContext2D.filter, so Excalidraw hides "Dark mode" in its export
// dialog there. Exporting, it only ever sets one filter, on a fresh canvas before drawing the
// whole scene: its dark theme, "invert(93%) hue-rotate(180deg)" - a per-pixel colour transform.
// So: remember the filter on the canvas, show that canvas (the dialog's preview) through the same
// CSS filter (see mac.css), and apply it to the pixels when the image is written out.
//
// Imported before Excalidraw, which checks for the feature when it loads.

type Matrix = number[]; // 3x4, rows r g b: [m00 m01 m02 offset, ...]

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  // a after b
  const out: Matrix = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? a[r * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
      out.push(v);
    }
  }
  return out;
}

/** The colour matrix of a CSS filter list (invert, hue-rotate, saturate; others are ignored). */
export function filterMatrix(filter: string): Matrix {
  let m = IDENTITY;
  for (const [, name, arg] of filter.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    const n = parseFloat(arg);
    const amount = arg.trim().endsWith("%") ? n / 100 : n;
    let f: Matrix | null = null;
    if (name === "invert") {
      const a = 1 - 2 * amount;
      f = [a, 0, 0, amount, 0, a, 0, amount, 0, 0, a, amount];
    } else if (name === "hue-rotate") {
      const rad = (n * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      f = [
        0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928, 0,
        0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283, 0,
        0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072, 0,
      ];
    } else if (name === "saturate") {
      const s = amount;
      f = [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0,
      ];
    }
    if (f) m = multiply(f, m);
  }
  return m;
}

/** A copy of `canvas` with `filter` applied to its pixels. */
function filtered(canvas: HTMLCanvasElement, filter: string): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d");
  if (!ctx || !canvas.width || !canvas.height) return canvas;
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, copy.width, copy.height);
  const d = image.data;
  const m = filterMatrix(filter);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    d[i] = 255 * (m[0] * r + m[1] * g + m[2] * b + m[3]);
    d[i + 1] = 255 * (m[4] * r + m[5] * g + m[6] * b + m[7]);
    d[i + 2] = 255 * (m[8] * r + m[9] * g + m[10] * b + m[11]);
  }
  ctx.putImageData(image, 0, 0);
  return copy;
}

export function installCanvasFilter() {
  const proto = CanvasRenderingContext2D.prototype;
  if ("filter" in proto) return;
  Object.defineProperty(proto, "filter", {
    configurable: true,
    get(this: CanvasRenderingContext2D) {
      return this.canvas?.dataset?.macFilter ?? "none";
    },
    set(this: CanvasRenderingContext2D, value: string) {
      const data = this.canvas?.dataset;
      if (!data) return;
      if (value && value !== "none") data.macFilter = value;
      else delete data.macFilter;
    },
  });
  const { toBlob, toDataURL } = HTMLCanvasElement.prototype;
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback, type, quality) {
    const filter = this.dataset.macFilter;
    return toBlob.call(filter ? filtered(this, filter) : this, callback, type, quality);
  };
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, type?: string, quality?: number) {
    const filter = this.dataset.macFilter;
    return toDataURL.call(filter ? filtered(this, filter) : this, type, quality);
  };
}

installCanvasFilter();
