const fill = { r: 250, g: 250, b: 250, a: 0.96 };
const outline = { r: 20, g: 20, b: 20, a: 0.9 };
const pressedFill = { r: 244, g: 211, b: 78, a: 0.96 };
const flashFill = { r: 244, g: 211, b: 78, a: 0.16 };
const flashOutline = { r: 244, g: 211, b: 78, a: 0.9 };
const frameMs = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const easeOut = (t) => 1 - (1 - t) ** 3;

function arrow(x, y, size) {
  return [x, y, x, y + 19 * size, x + 5.5 * size, y + 14.5 * size, x + 13 * size, y + 14 * size];
}

function dot(x, y, size) {
  const r = 11 * size;
  return [x, y - r, x + r, y, x, y + r, x - r, y];
}

export function createPointer(send, watched, touch, zoom) {
  let position;

  const draw = (x, y, pressed = false) => {
    const size = 1 / Math.min(1, Math.max(zoom(), 0.12));
    return send("Overlay.highlightQuad", { quad: touch() ? dot(x, y, size) : arrow(x, y, size), color: pressed ? pressedFill : fill, outlineColor: outline }).catch(() => {});
  };


  return {
    watched,
    async moveTo(x, y, duration = 260) {
      const from = position ?? { x: x - 60, y: y - 40 };
      position = { x, y };
      if (!watched()) return;
      const frames = Math.max(1, Math.round(duration / frameMs));
      for (let frame = 1; frame <= frames; frame++) {
        const t = easeOut(frame / frames);
        await draw(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        await sleep(frameMs);
      }
    },
    async drawAt(x, y, pressed = false) {
      position = { x, y };
      if (watched()) await draw(x, y, pressed);
    },
    async press(box) {
      if (!watched() || !position) return;
      if (box) {
        await send("Overlay.highlightRect", {
          x: Math.round(box.left),
          y: Math.round(box.top),
          width: Math.max(1, Math.round(box.right - box.left)),
          height: Math.max(1, Math.round(box.bottom - box.top)),
          color: flashFill,
          outlineColor: flashOutline,
        }).catch(() => {});
        await sleep(140);
      }
      await draw(position.x, position.y, true);
      await sleep(90);
    },
    async release() {
      if (watched() && position) await draw(position.x, position.y);
    },
    async hide() {
      await send("Overlay.hideHighlight").catch(() => {});
    },
  };
}
