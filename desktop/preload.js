'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/*
 * The only bridge between the shell and the web app. The page keeps running
 * exactly as it does in a browser; this just hands it the window powers a
 * browser cannot offer.
 */
contextBridge.exposeInMainWorld('cuelineShell', {
  isShell: true,
  info: () => ipcRenderer.invoke('cueline:shellInfo'),
  send: (type, payload) => ipcRenderer.send('cueline:shellAction', { type, ...payload }),
  on(callback) {
    const handler = (_e, msg) => callback(msg);
    ipcRenderer.on('cueline:shell', handler);
    return () => ipcRenderer.removeListener('cueline:shell', handler);
  },
});
