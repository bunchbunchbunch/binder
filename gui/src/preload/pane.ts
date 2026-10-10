import { contextBridge, ipcRenderer } from 'electron';
import type { BinderPane } from '../shared/api';

// A web pane's page and the app: `window.binderPane`, and nothing else. The
// page comes from a server, so the main process checks every call
// (src/main/paneBridge.ts).

const api: BinderPane = {
  home: () => ipcRenderer.invoke('pane:home'),
  open: (req) => ipcRenderer.invoke('pane:open', req),
  completeFolder: (input) => ipcRenderer.invoke('pane:completeFolder', input),
  missingFolder: (input) => ipcRenderer.invoke('pane:missingFolder', input),
  makeFolder: (path) => ipcRenderer.invoke('pane:makeFolder', path),
  onShow: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('pane:shown', listener);
    return () => void ipcRenderer.off('pane:shown', listener);
  },
};

contextBridge.exposeInMainWorld('binderPane', api);
