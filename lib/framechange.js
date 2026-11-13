'use strict';

function screenChanged(previous, next) {
  if (!previous || !next || previous.length !== next.length || previous.length < 4) return true;
  let strong = 0;
  let mild = 0;
  for (let i = 0; i < next.length; i += 4) {
    const peak = Math.max(
      Math.abs(previous[i] - next[i]),
      Math.abs(previous[i + 1] - next[i + 1]),
      Math.abs(previous[i + 2] - next[i + 2])
    );
    if (peak > 48) return true;
    if (peak > 10) strong += 1;
    else if (peak > 5) mild += 1;
  }
  if (strong >= 4) return true;
  if (mild + strong >= 24) return true;
  return false;
}

module.exports = { screenChanged };
