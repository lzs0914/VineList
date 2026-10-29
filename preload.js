const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setInteractive: (v) => ipcRenderer.send('ui:interactive', v),
  setRects: (rs) => ipcRenderer.send('ui:rects', rs),
  setLock: (v) => ipcRenderer.send('ui:lock', v),
  onCursor: (cb) => ipcRenderer.on('ui:cursor', (e, p) => cb(p)),
  focusWindow: () => ipcRenderer.send('ui:focus'),
  addNote: (text) => ipcRenderer.invoke('note:add', text),
  reorder: (ids) => ipcRenderer.send('items:reorder', ids),
  detach: (id, x, y) => ipcRenderer.invoke('item:detach', id, x, y),

  onState: (cb) => ipcRenderer.on('state:changed', (e, s) => cb(s)),
  composerClose: () => ipcRenderer.send('composer:close'),
  composerMinimize: () => ipcRenderer.send('composer:minimize'),
  composerResize: (b) => ipcRenderer.send('composer:resize', b),
  draftGet: () => ipcRenderer.invoke('composer:draft:get'),
  draftSet: (text) => ipcRenderer.send('composer:draft:set', text),

  onCaptureImage: (cb) => ipcRenderer.on('capture:image', (e, d) => cb(d)),
  captureDone: (p) => ipcRenderer.invoke('capture:done', p),
  captureCancel: () => ipcRenderer.send('capture:cancel'),

  cardGet: (id) => ipcRenderer.invoke('card:get', id),
  cardReturn: (id) => ipcRenderer.send('card:return', id),
  cardDone: (id) => ipcRenderer.send('card:done', id),
  cardCopy: (id) => ipcRenderer.invoke('card:copy', id),
  cardSize: (id, w, h) => ipcRenderer.send('card:size', id, w, h),
});

