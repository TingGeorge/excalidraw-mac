// Sharp emoji on a zoomed-in canvas. Excalidraw draws text at the element's font size on a
// canvas scaled by zoom × Retina. Letters are outlines and scale cleanly, but WebKit draws a
// colour emoji from the bitmap that fits the unscaled font size (Apple Color Emoji has bitmaps
// from 20 to 160 px) and then stretches it: at 268% a 36 px emoji came from a 40 px bitmap
// blown up five times. So text with an emoji in it is drawn at the size it shows on screen,
// with the scale taken out of the transform; the text ends up in the same place.

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function installSharpEmoji() {
  const proto = CanvasRenderingContext2D.prototype;
  for (const name of ["fillText", "strokeText"] as const) {
    const draw = proto[name];
    proto[name] = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
      const args = (sx: number, sy: number, sw?: number) => (maxWidth === undefined ? [text, sx, sy] : [text, sx, sy, sw]);
      const m = typeof text === "string" && EMOJI.test(text) ? this.getTransform() : null;
      const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
      const size = m && /(\d*\.?\d+)px/.exec(this.font);
      if (!m || !size || !(scale > 1.01) || !Number.isFinite(scale)) {
        return draw.apply(this, args(x, y, maxWidth) as [string, number, number]);
      }
      this.save();
      this.font = this.font.replace(size[0], `${parseFloat(size[1]) * scale}px`);
      if (name === "strokeText") this.lineWidth *= scale;
      this.setTransform(m.a / scale, m.b / scale, m.c / scale, m.d / scale, m.e, m.f);
      draw.apply(this, args(x * scale, y * scale, maxWidth === undefined ? undefined : maxWidth * scale) as [string, number, number]);
      this.restore();
    };
  }
}

installSharpEmoji();
