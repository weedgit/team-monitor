'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SegmentRecorder } = require('../lib/recorder');

const ffmpegPath = require('ffmpeg-static');

function makeJpeg() {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x3d8bfd:s=160x90',
      '-frames:v', '1', '-f', 'image2', 'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `ffmpeg ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

test('recorder writes an H.264 segment for one display', { timeout: 60000 }, async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static did not provide a binary');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rec-'));
  const jpeg = await makeJpeg();
  const produced = [];
  const errors = [];
  const recorder = new SegmentRecorder({
    ffmpegPath,
    directory,
    segmentMs: 60 * 1000,
    onSegment: async (segment) => { produced.push(segment); },
    onError: (error) => errors.push(error)
  });
  const started = new Date();
  recorder.push(0, jpeg, started, { width: 160, height: 90 });
  recorder.push(1, jpeg, new Date(started.getTime() + 1000), { width: 160, height: 90 });
  recorder.push(0, jpeg, new Date(started.getTime() + 1000), { width: 160, height: 90 });
  await recorder.stop();
  assert.deepEqual(errors.map((error) => error.message), []);
  assert.equal(produced.length, 2);
  const display0 = produced.find((segment) => segment.meta.displayIndex === 0);
  assert.equal(display0.meta.frameCount, 2);
  const bytes = fs.readFileSync(display0.filePath);
  assert.ok(bytes.includes(Buffer.from('ftyp')));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a still screen is held for the elapsed time instead of a new frame', { timeout: 60000 }, async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static did not provide a binary');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rec-hold-'));
  const jpeg = await makeJpeg();
  const produced = [];
  const errors = [];
  const recorder = new SegmentRecorder({
    ffmpegPath,
    directory,
    segmentMs: 60 * 1000,
    fps: 10,
    onSegment: async (segment) => { produced.push(segment); },
    onError: (error) => errors.push(error)
  });
  const started = new Date();
  recorder.push(0, jpeg, started, { changed: true, width: 160, height: 90 });
  recorder.push(0, null, new Date(started.getTime() + 5000), { changed: false, width: 160, height: 90 });
  await recorder.stop();
  assert.deepEqual(errors.map((error) => error.message), []);
  assert.equal(produced.length, 1);
  assert.equal(produced[0].meta.frameCount, 1);
  const duration = await mediaDuration(produced[0].filePath);
  assert.ok(duration >= 4.5 && duration <= 5.5, `duration ${duration}`);
  fs.rmSync(directory, { recursive: true, force: true });
});

function mediaDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) reject(new Error(stderr || 'no duration'));
      else resolve((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]));
    });
  });
}
