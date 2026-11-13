'use strict';

function memberTiles(members) {
  return (members || []).map((member) => {
    const displays = Array.isArray(member.displays) && member.displays.length
      ? member.displays
      : [{ index: 0 }];
    return {
      machineId: member.machineId,
      hostname: member.hostname || 'Teammate',
      online: Boolean(member.online),
      capture: member.online ? (member.capture || 'recording') : 'offline',
      pendingSegments: Number(member.pendingSegments) || 0,
      holdNetwork: Boolean(member.holdNetwork),
      displays: displays.map((display) => ({
        index: Number(display.index) || 0,
        label: `Display ${(Number(display.index) || 0) + 1}`,
        width: display.width || 0,
        height: display.height || 0
      }))
    };
  });
}

function seekWithin(segment, at) {
  const start = new Date(segment.startedAt).getTime();
  const end = new Date(segment.endedAt).getTime();
  const t = new Date(at).getTime();
  const span = Math.max(0, (end - start) / 1000);
  return Math.min(span, Math.max(0, (t - start) / 1000));
}

module.exports = {
  memberTiles,
  seekWithin
};
