'use strict';

function hitDisplay(x, y, displays) {
  return (displays || []).find((display) => {
    const bounds = display.bounds;
    if (!bounds) return false;
    return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
  });
}

function displayIndexForWindow(rect, displays) {
  const list = displays || [];
  const cx = (Number(rect.left) + Number(rect.right)) / 2;
  const cy = (Number(rect.top) + Number(rect.bottom)) / 2;
  const raw = hitDisplay(cx, cy, list);
  if (raw) return raw.index;
  for (const display of list) {
    const scale = Number(display.scaleFactor) || 1;
    if (scale === 1) continue;
    const found = hitDisplay(cx / scale, cy / scale, [display]);
    if (found) return found.index;
  }
  return list.length ? list[0].index : 0;
}

module.exports = {
  displayIndexForWindow
};
