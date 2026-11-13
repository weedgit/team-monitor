'use strict';

const path = require('path');

function loadFrameChange() {
  const packaged = __dirname.includes('app.asar');
  const target = packaged
    ? path.join(__dirname, 'lib', 'framechange')
    : path.join(__dirname, '..', 'lib', 'framechange');
  return require(target);
}

const { screenChanged } = loadFrameChange();

function focusIndex(profile) {
  if (!profile || profile.focusDisplay === null || profile.focusDisplay === undefined) return null;
  const value = Number(profile.focusDisplay);
  return Number.isInteger(value) ? value : null;
}

function liveRole(index, focus, primary) {
  if (focus === null) return index === primary ? 'tile' : null;
  return index === focus ? 'focus' : 'tile';
}

function jpegAt(image, width, quality) {
  if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null;
  const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0 };
  const target = Math.max(160, Math.min(Number(width) || size.width || 160, size.width || width || 160));
  const scaled = size.width > target + 8 && typeof image.resize === 'function'
    ? image.resize({ width: target })
    : image;
  return typeof scaled.toJPEG === 'function' ? scaled.toJPEG(Math.max(40, Math.min(95, Number(quality) || 82))) : null;
}

function startCaptureLoop(options) {
  let stopped = false;
  let busy = false;
  let lastRecord = 0;
  let lastTile = 0;
  let lastFocus = 0;
  const recordPrints = new Map();

  function profile() {
    return options.getProfile() || {};
  }

  async function tick() {
    if (stopped || busy) return;
    if (options.isLocked && options.isLocked()) return;
    const next = profile();
    const paused = Boolean(options.isPaused && options.isPaused());
    const online = Boolean(options.isOnline && options.isOnline());
    const focus = focusIndex(next);
    const now = Date.now();
    const recordGap = Math.max(50, Number(next.recordIntervalMs) || 1000);
    const tileGap = Math.max(250, Number(next.tileIntervalMs) || 1000);
    const focusGap = Math.max(50, Number(next.liveIntervalMs) || 500);
    const recordDue = !paused && now - lastRecord >= recordGap - 20;
    const tileDue = online && now - lastTile >= tileGap - 20;
    const focusDue = online && focus !== null && now - lastFocus >= focusGap - 20;
    if (!recordDue && !tileDue && !focusDue) return;
    const force = online && (tileDue || focusDue) && options.forceLive
      ? Boolean(options.forceLive())
      : false;
    busy = true;
    try {
      const recordWidth = Number(next.recordWidth) || options.recordWidth;
      const gridWidth = Number(next.gridWidth) || options.gridWidth;
      const focusWidth = Number(next.focusWidth) || options.focusWidth;
      let width = 320;
      if (recordDue) width = Math.max(width, recordWidth);
      if (tileDue || force) width = Math.max(width, gridWidth);
      if (focusDue || (force && focus !== null)) width = Math.max(width, focusWidth);
      const shots = await options.grab(width);
      if (options.onOk) options.onOk();
      const grabbedAt = Date.now();
      if (recordDue) lastRecord = grabbedAt;
      if (tileDue || force) lastTile = grabbedAt;
      if (focusDue || (force && focus !== null)) lastFocus = grabbedAt;
      options.onDisplays(shots.map((shot) => shot.display));
      const indexes = shots.map((shot) => shot.display.index).filter((index) => Number.isInteger(index));
      const primary = indexes.length ? Math.min(...indexes) : 0;
      const seen = new Set();
      shots.forEach((shot) => {
        const index = shot.display.index;
        seen.add(index);
        if (recordDue) {
          const changed = screenChanged(recordPrints.get(index), shot.signature);
          if (shot.signature) recordPrints.set(index, shot.signature);
          shot.jpeg = changed && shot.image
            ? jpegAt(shot.image, recordWidth, Number(next.recordJpegQuality) || Number(next.jpegQuality) || 82)
            : null;
          options.onRecord(shot, new Date(), Boolean(shot.jpeg));
        }
        if (!online) return;
        const role = liveRole(index, focus, primary);
        const roleDue = role === 'focus' ? (focusDue || force) : role === 'tile' && (tileDue || force);
        if (!roleDue || !shot.image) return;
        const liveWidth = role === 'focus' ? focusWidth : gridWidth;
        const liveJpeg = jpegAt(shot.image, liveWidth, Number(next.jpegQuality) || 70);
        if (!liveJpeg) return;
        options.onLive({ ...shot, jpeg: liveJpeg });
      });
      [...recordPrints.keys()].forEach((index) => {
        if (!seen.has(index)) recordPrints.delete(index);
      });
    } catch (error) {
      options.onError(error);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, 50);
  void tick();

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startCaptureLoop };

