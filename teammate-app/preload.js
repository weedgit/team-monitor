'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teammate', {
  status: () => ipcRenderer.invoke('status'),
  enroll: (payload) => ipcRenderer.invoke('enroll', payload),
  setName: (name) => ipcRenderer.invoke('set-name', name),
  setHoldNetwork: (on) => ipcRenderer.invoke('set-hold-network', on),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  }
});
