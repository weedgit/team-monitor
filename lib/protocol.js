'use strict';

const LIVE_QUALITY = {
  low: { gridWidth: 640, focusWidth: 1280, jpegQuality: 70, liveIntervalMs: 500 },
  standard: { gridWidth: 960, focusWidth: 1600, jpegQuality: 82, liveIntervalMs: 250 },
  high: { gridWidth: 1280, focusWidth: 1920, jpegQuality: 90, liveIntervalMs: 120 },
  ultra: { gridWidth: 1600, focusWidth: 1920, jpegQuality: 95, liveIntervalMs: 100 }
};

const RECORD_FPS = [1, 5, 10, 15];
const RECORD_WIDTHS = [1280, 1920, 2560];
const SEGMENT_MINUTES = [1, 2, 5, 10];
const GRID_LAYOUTS = {
  '2x2': { cols: 2, rows: 2 },
  '2x3': { cols: 2, rows: 3 },
  '3x3': { cols: 3, rows: 3 }
};
const RETENTION_OPTIONS = [7, 14, 30, 90];

function normalizeQuality(input) {
  const liveQuality = LIVE_QUALITY[input && input.liveQuality] ? input.liveQuality : 'low';
  const live = LIVE_QUALITY[liveQuality];
  const recordFps = RECORD_FPS.includes(Number(input && input.recordFps))
    ? Number(input.recordFps)
    : 10;
  const recordWidth = RECORD_WIDTHS.includes(Number(input && input.recordWidth))
    ? Number(input.recordWidth)
    : 1920;
  const recordCrf = recordWidth >= 2560 ? 18 : recordWidth >= 1920 ? 20 : 23;
  const segmentMinutes = SEGMENT_MINUTES.includes(Number(input && input.segmentMinutes))
    ? Number(input.segmentMinutes)
    : 1;
  const grid = GRID_LAYOUTS[input && input.grid] ? input.grid : '2x2';
  const retentionDays = RETENTION_OPTIONS.includes(Number(input && input.retentionDays))
    ? Number(input.retentionDays)
    : 14;
  const archiveDir = String(input && input.archiveDir || '').trim();
  return {
    liveQuality,
    recordFps,
    recordWidth,
    gridWidth: live.gridWidth,
    focusWidth: live.focusWidth,
    jpegQuality: live.jpegQuality,
    liveIntervalMs: live.liveIntervalMs,
    tileIntervalMs: Math.max(1000, live.liveIntervalMs),
    recordJpegQuality: Math.max(live.jpegQuality, 82),
    recordIntervalMs: Math.round(1000 / recordFps),
    recordCrf,
    segmentMinutes,
    segmentMs: segmentMinutes * 60 * 1000,
    grid,
    gridCols: GRID_LAYOUTS[grid].cols,
    gridRows: GRID_LAYOUTS[grid].rows,
    retentionDays,
    archiveDir
  };
}

function qualityProfile(focusDisplay, quality) {
  const next = normalizeQuality(quality);
  const focused = focusDisplay === null || focusDisplay === undefined
    ? null
    : Number(focusDisplay);
  return {
    focusDisplay: Number.isInteger(focused) ? focused : null,
    liveQuality: next.liveQuality,
    recordFps: next.recordFps,
    recordWidth: next.recordWidth,
    gridWidth: next.gridWidth,
    focusWidth: next.focusWidth,
    jpegQuality: next.jpegQuality,
    liveIntervalMs: next.liveIntervalMs,
    tileIntervalMs: next.tileIntervalMs,
    recordJpegQuality: next.recordJpegQuality,
    recordIntervalMs: next.recordIntervalMs,
    recordCrf: next.recordCrf,
    segmentMinutes: next.segmentMinutes,
    segmentMs: next.segmentMs
  };
}

const DEFAULT_QUALITY = normalizeQuality(null);

module.exports = {
  DEFAULT_PORT: 3921,
  MAX_MEMBERS: 10,
  RETENTION_DAYS: 14,
  SEGMENT_MS: DEFAULT_QUALITY.segmentMs,
  RECORD_WIDTH: DEFAULT_QUALITY.recordWidth,
  GRID_WIDTH: DEFAULT_QUALITY.gridWidth,
  FOCUS_WIDTH: DEFAULT_QUALITY.focusWidth,
  MIN_FREE_BYTES: 2 * 1024 * 1024 * 1024,
  LIVE_QUALITY,
  RECORD_FPS,
  RECORD_WIDTHS,
  SEGMENT_MINUTES,
  GRID_LAYOUTS,
  RETENTION_OPTIONS,
  DEFAULT_QUALITY,
  normalizeQuality,
  qualityProfile
};
