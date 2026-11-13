'use strict';

const fs = require('fs');
const { isLocalHostName, resolveLocalHost, LOCAL_ONLY } = require('./localnet');

function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) {
    throw new Error('Enter the admin address.');
  }
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error('That admin address is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use an http address.');
  }
  if (!isLocalHostName(url.hostname)) {
    throw new Error(LOCAL_ONLY);
  }
  return `${url.protocol}//${url.host}`;
}

async function resolveLocalServerUrl(input) {
  const origin = normalizeServerUrl(input);
  await resolveLocalHost(new URL(origin).hostname);
  return origin;
}

function joinUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}${pathname}`;
}

async function checkHealth(baseUrl, timeoutMs = 4000) {
  try {
    const origin = await resolveLocalServerUrl(baseUrl);
    const response = await fetch(joinUrl(origin, '/api/health'), {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body && body.ok);
  } catch (_error) {
    return false;
  }
}

async function enrollRequest(baseUrl, hostname, pcId, machineId) {
  const serverUrl = await resolveLocalServerUrl(baseUrl);
  let response;
  try {
    response = await fetch(joinUrl(serverUrl, '/api/enroll'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname,
        pcId: pcId || undefined,
        machineId: machineId || undefined
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_error) {
    throw new Error('Cannot reach the admin PC. Check the address and that the admin app is open.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Enrollment failed.');
  }
  return { serverUrl, ...body };
}

async function leaveRequest(baseUrl, memberToken) {
  const serverUrl = await resolveLocalServerUrl(baseUrl);
  const response = await fetch(joinUrl(serverUrl, '/api/leave'), {
    method: 'POST',
    headers: { authorization: `Bearer ${memberToken}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Could not remove this PC from the admin.');
  return true;
}

async function syncOnce({ baseUrl, memberToken, outbox }) {
  let origin;
  try {
    origin = await resolveLocalServerUrl(baseUrl);
  } catch (_error) {
    return { online: false, uploadedSegments: 0, uploadedActivities: 0, error: LOCAL_ONLY };
  }
  const online = await checkHealth(origin);
  if (!online) {
    return { online: false, uploadedSegments: 0, uploadedActivities: 0 };
  }

  let uploadedActivities = 0;
  const pending = outbox.pendingActivities();
  if (pending.length) {
    const batch = pending.slice(0, 200);
    try {
      const response = await fetch(joinUrl(origin, '/api/activity'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${memberToken}`
        },
        body: JSON.stringify({ events: batch.map((row) => row.event) }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error('Activity upload failed.');
      const body = await response.json().catch(() => ({}));
      outbox.ackActivities(body.accepted || batch.map((row) => row.event.id));
      uploadedActivities = batch.length;
    } catch (error) {
      return { online: true, uploadedSegments: 0, uploadedActivities: 0, error: error.message };
    }
  }

  const missing = typeof outbox.missingPendingSegments === 'function'
    ? outbox.missingPendingSegments()
    : [];
  const missingError = missing.length ? 'A local recording file is missing.' : '';
  const segment = typeof outbox.nextPresentSegment === 'function'
    ? outbox.nextPresentSegment()
    : outbox.nextPendingSegment();
  if (!segment) {
    return {
      online: true,
      uploadedSegments: 0,
      uploadedActivities,
      error: missingError || undefined
    };
  }

  outbox.markSegment(segment.segmentId, 'uploading');
  try {
    const response = await fetch(joinUrl(origin, '/api/segments'), {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${memberToken}`,
        'x-segment-id': segment.segmentId,
        'x-display-index': String(segment.meta.displayIndex),
        'x-started-at': segment.meta.startedAt,
        'x-ended-at': segment.meta.endedAt,
        'x-frame-count': String(segment.meta.frameCount || 0),
        'x-width': String(segment.meta.width || 0),
        'x-height': String(segment.meta.height || 0)
      },
      body: fs.readFileSync(segment.filePath),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Recording upload failed (${response.status}).`);
    }
    outbox.markSegment(segment.segmentId, 'acked');
    fs.rmSync(segment.filePath, { force: true });
    return { online: true, uploadedSegments: 1, uploadedActivities, error: missingError || undefined };
  } catch (error) {
    outbox.markSegment(segment.segmentId, 'pending');
    return { online: true, uploadedSegments: 0, uploadedActivities, error: error.message };
  }
}

module.exports = {
  normalizeServerUrl,
  resolveLocalServerUrl,
  checkHealth,
  enrollRequest,
  leaveRequest,
  syncOnce
};
