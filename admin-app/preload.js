'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('admin', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  setWatch: (payload) => ipcRenderer.invoke('set-watch', payload),
  recordings: (query) => ipcRenderer.invoke('recordings', query),
  activity: (query) => ipcRenderer.invoke('activity', query),
  loadSegment: (segmentId) => ipcRenderer.invoke('load-segment', segmentId),
  findSegment: (query) => ipcRenderer.invoke('find-segment', query),
  removeMember: (machineId) => ipcRenderer.invoke('remove-member', machineId),
  commandMember: (machineId, action) => ipcRenderer.invoke('command-member', { machineId, action }),
  archiveDisk: () => ipcRenderer.invoke('archive-disk'),
  setQuality: (payload) => ipcRenderer.invoke('set-quality', payload),
  chooseArchiveDir: () => ipcRenderer.invoke('choose-archive-dir'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  onMembers: (callback) => {
    const listener = (_event, members) => callback(members);
    ipcRenderer.on('members', listener);
    return () => ipcRenderer.removeListener('members', listener);
  },
  onFrame: (callback) => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('frame', listener);
    return () => ipcRenderer.removeListener('frame', listener);
  }
});
