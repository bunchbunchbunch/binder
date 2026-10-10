import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { BinderApi, ControlRequest, PaneEvent, WebPaneEvent } from '../shared/api';
import type { KeyDesc } from '../shared/keys';
import type { HostMessage } from '../shared/wire';

// The window's only way to the main process: `window.binder`.

const api: BinderApi = {
  home: process.env.HOME ?? '',
  listSessions: () => ipcRenderer.invoke('listSessions'),
  open: (conn, req) => ipcRenderer.invoke('open', conn, req),
  request: (conn, t, fields) => ipcRenderer.invoke('request', conn, t, fields),
  close: (conn) => ipcRenderer.invoke('close', conn),
  onMessage: (cb) => {
    const listener = (_e: IpcRendererEvent, conn: string, msg: HostMessage) => cb(conn, msg);
    ipcRenderer.on('host', listener);
    return () => void ipcRenderer.off('host', listener);
  },
  repoInfo: (cwd) => ipcRenderer.invoke('repoInfo', cwd),
  sidebarScript: (input) => ipcRenderer.invoke('sidebarScript', input),
  isDirectory: (path) => ipcRenderer.invoke('isDirectory', path),
  chooseFolder: (opts) => ipcRenderer.invoke('chooseFolder', opts),
  pathForFile: (file) => webUtils.getPathForFile(file),
  clipboardImage: () => ipcRenderer.invoke('clipboardImage'),
  clipboardText: () => ipcRenderer.invoke('clipboardText'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  loadLayout: () => ipcRenderer.invoke('loadLayout'),
  saveLayout: (layout) => ipcRenderer.invoke('saveLayout', layout),
  loadSettings: () => ipcRenderer.invoke('loadSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('saveSettings', patch),
  onOpenSettings: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('openSettings', listener);
    return () => void ipcRenderer.off('openSettings', listener);
  },
  onOpenGuide: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('openGuide', listener);
    return () => void ipcRenderer.off('openGuide', listener);
  },
  panes: () => ipcRenderer.invoke('panes'),
  paneStart: (name, cols, rows) => ipcRenderer.invoke('paneStart', name, cols, rows),
  paneInput: (name, data) => ipcRenderer.send('paneInput', name, data),
  paneResize: (name, cols, rows) => ipcRenderer.send('paneResize', name, cols, rows),
  onPane: (cb) => {
    const listener = (_e: IpcRendererEvent, name: string, e: PaneEvent) => cb(name, e);
    ipcRenderer.on('pane', listener);
    return () => void ipcRenderer.off('pane', listener);
  },
  webPaneStart: (name) => ipcRenderer.invoke('webPaneStart', name),
  webPaneLayout: (name, box, show) => ipcRenderer.send('webPaneLayout', name, box, show),
  webPaneLoad: (name, url) => ipcRenderer.invoke('webPaneLoad', name, url),
  onWebPane: (cb) => {
    const listener = (_e: IpcRendererEvent, name: string, e: WebPaneEvent) => cb(name, e);
    ipcRenderer.on('webPane', listener);
    return () => void ipcRenderer.off('webPane', listener);
  },
  onAppKey: (cb) => {
    const listener = (_e: IpcRendererEvent, k: KeyDesc) => cb(k);
    ipcRenderer.on('appKey', listener);
    return () => void ipcRenderer.off('appKey', listener);
  },
  onControl: (cb) => {
    const listener = (_e: IpcRendererEvent, id: number, req: ControlRequest) => ipcRenderer.send('controlReply', id, cb(req));
    ipcRenderer.on('control', listener);
    return () => void ipcRenderer.off('control', listener);
  },
  setStatus: (status) => ipcRenderer.send('status', status),
  attention: () => ipcRenderer.send('attention'),
  quit: () => ipcRenderer.send('quit'),
};

contextBridge.exposeInMainWorld('binder', api);
