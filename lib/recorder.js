'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { newSegmentId } = require('./token');

class SegmentRecorder {
  constructor(options) {
    this.ffmpegPath = options.ffmpegPath;
    this.directory = options.directory;
    this.segmentMs = options.segmentMs;
    this.onSegment = options.onSegment;
    this.onError = options.onError || (() => {});
    this.fps = Math.max(1, Math.min(30, Number(options.fps) || 1));
    this.crf = Math.max(16, Math.min(32, Number(options.crf) || 23));
    this.open = new Map();
    this.pending = new Set();
    this.tail = Promise.resolve();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  configure(options) {
    const fps = options && options.fps != null
      ? Math.max(1, Math.min(30, Number(options.fps) || this.fps))
      : this.fps;
    const crf = options && options.crf != null
      ? Math.max(16, Math.min(32, Number(options.crf) || this.crf))
      : this.crf;
    const segmentMs = options && options.segmentMs != null
      ? Math.max(15 * 1000, Number(options.segmentMs) || this.segmentMs)
      : this.segmentMs;
    if (fps === this.fps && crf === this.crf && segmentMs === this.segmentMs) return;
    this.fps = fps;
    this.crf = crf;
    this.segmentMs = segmentMs;
    this.enqueue(async () => {
      const keys = [...this.open.keys()];
      for (const displayIndex of keys) await this.finish(displayIndex);
    });
  }

  push(displayIndex, jpeg, at = new Date(), info = {}) {
    this.enqueue(() => this.step(displayIndex, jpeg, at, info));
  }

  enqueue(job) {
    this.tail = this.tail.then(job).catch((error) => {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return this.tail;
  }

  targetFrames(elapsedMs, fps) {
    const rate = fps || this.fps;
    if (elapsedMs <= 0) return 1;
    return Math.max(1, Math.round((elapsedMs * rate) / 1000));
  }

  async holdUntil(state, atMs) {
    const target = this.targetFrames(atMs - state.startedMs, state.fps);
    while (state.written < target) {
      await this.writeJpeg(state, state.lastJpeg);
      state.written += 1;
    }
  }

  writeJpeg(state, jpeg) {
    return new Promise((resolve, reject) => {
      const input = state.child && state.child.stdin;
      if (!input || !input.writable) {
        reject(new Error('Encoder is not running.'));
        return;
      }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        input.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error) => finish(error);
      input.once('error', onError);
      const ok = input.write(jpeg, (error) => {
        if (error) finish(error);
      });
      if (ok) finish();
      else input.once('drain', () => finish());
    });
  }

  openEncoder(state) {
    if (!this.ffmpegPath) {
      state.stderr = 'Video encoder is not available.';
      state.child = null;
      return;
    }
    const child = spawn(this.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-framerate', String(this.fps),
      '-i', 'pipe:0',
      '-an',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', String(this.crf),
      '-movflags', '+faststart',
      state.outPath
    ], { windowsHide: true });
    state.child = child;
    state.stderr = '';
    child.stderr.on('data', (chunk) => {
      state.stderr += chunk.toString();
      if (state.stderr.length > 4000) state.stderr = state.stderr.slice(-4000);
    });
    child.on('error', (error) => {
      state.stderr = error.message;
    });
  }

  async begin(displayIndex, now, info, jpeg) {
    const segmentId = newSegmentId();
    const state = {
      segmentId,
      outPath: path.join(this.directory, `${segmentId}.mp4`),
      lastJpeg: jpeg,
      startedMs: now.getTime(),
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
      width: info.width || 0,
      height: info.height || 0,
      displayIndex,
      fps: this.fps,
      written: 0,
      frameCount: 1,
      child: null,
      stderr: ''
    };
    this.openEncoder(state);
    this.open.set(displayIndex, state);
    try {
      if (state.child) {
        await this.writeJpeg(state, jpeg);
        state.written = 1;
      }
    } catch (error) {
      this.open.delete(displayIndex);
      if (state.child) state.child.kill();
      throw error;
    }
    return state;
  }

  async step(displayIndex, jpeg, at, info = {}) {
    const now = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(now.getTime())) return;
    const picture = Buffer.isBuffer(jpeg) && jpeg.length >= 4 ? jpeg : null;
    const changed = info.changed !== false && picture;
    let state = this.open.get(displayIndex);
    if (state && now.getTime() - state.startedMs >= this.segmentMs) {
      const held = state.lastJpeg;
      await this.finish(displayIndex, state.startedMs + this.segmentMs);
      const nextPicture = changed ? picture : held;
      if (nextPicture) await this.begin(displayIndex, now, info, nextPicture);
      return;
    }
    if (!changed) {
      if (!state) return;
      state.endedAt = now.toISOString();
      if (info.width) state.width = info.width;
      if (info.height) state.height = info.height;
      await this.holdUntil(state, now.getTime());
      return;
    }
    if (!state) {
      await this.begin(displayIndex, now, info, picture);
      return;
    }
    await this.holdUntil(state, now.getTime());
    await this.writeJpeg(state, picture);
    state.written += 1;
    state.frameCount += 1;
    state.lastJpeg = picture;
    state.endedAt = now.toISOString();
    if (info.width) state.width = info.width;
    if (info.height) state.height = info.height;
  }

  finish(displayIndex, endMs) {
    const state = this.open.get(displayIndex);
    if (!state) return Promise.resolve();
    this.open.delete(displayIndex);
    const job = this.encode(state, endMs);
    this.pending.add(job);
    job.finally(() => this.pending.delete(job));
    return job;
  }

  async encode(state, endMs) {
    try {
      const end = Number.isFinite(endMs) ? endMs : Date.parse(state.endedAt);
      if (Number.isFinite(end)) {
        state.endedAt = new Date(end).toISOString();
        if (state.child) await this.holdUntil(state, end);
      }
      const code = await this.closeEncoder(state);
      const size = fs.existsSync(state.outPath) ? fs.statSync(state.outPath).size : 0;
      if (code !== 0 || state.frameCount < 1 || size < 1) {
        fs.rmSync(state.outPath, { force: true });
        throw new Error((state.stderr || '').trim() || `Encoder exited with code ${code}.`);
      }
      await this.onSegment({
        segmentId: state.segmentId,
        filePath: state.outPath,
        meta: {
          segmentId: state.segmentId,
          displayIndex: state.displayIndex,
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          frameCount: state.frameCount,
          width: state.width,
          height: state.height
        }
      });
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  closeEncoder(state) {
    const child = state.child;
    if (!child) return Promise.resolve(1);
    return new Promise((resolve) => {
      const finish = (code) => resolve(code == null ? 1 : code);
      child.on('close', finish);
      child.stdin.end();
    });
  }

  async stop() {
    await this.tail;
    const keys = [...this.open.keys()];
    for (const key of keys) this.enqueue(() => this.finish(key));
    await this.tail;
    await Promise.all([...this.pending]);
  }
}

module.exports = { SegmentRecorder };
