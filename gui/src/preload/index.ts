import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { BinderApi, ControlRequest, PaneEvent, PreviewEvent, WebPaneEvent, SidePaneEvent } from '../shared/api';
import type { KeyDesc } from '../shared/keys';
import type { HostMessage } from '../shared/wire';

// The window's only way to the main process: `window.binder`.

const api: BinderApi = {
  home: process.env.HOME ?? '',
  listSessions: (computer) => ipcRenderer.invoke('listSessions', computer),
  computers: () => ipcRenderer.invoke('computers'),
  open: (conn, req) => ipcRenderer.invoke('open', conn, req),
  request: (conn, t, fields) => ipcRenderer.invoke('request', conn, t, fields),
  close: (conn) => ipcRenderer.invoke('close', conn),
  newWindow: (ref) => ipcRenderer.invoke('newWindow', ref),
  onMessage: (cb) => {
    const listener = (_e: IpcRendererEvent, conn: string, msg: HostMessage) => cb(conn, msg);
    ipcRenderer.on('host', listener);
    return () => void ipcRenderer.off('host', listener);
  },
  repoInfo: (cwd, computer) => ipcRenderer.invoke('repoInfo', cwd, computer),
  sidebarScript: (input, computer) => ipcRenderer.invoke('sidebarScript', input, computer),
  isDirectory: (path, computer) => ipcRenderer.invoke('isDirectory', path, computer),
  subfolders: (dirs, computer) => ipcRenderer.invoke('subfolders', dirs, computer),
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
  termStart: (id, cwd, computer, cols, rows) => ipcRenderer.invoke('termStart', id, cwd, computer, cols, rows),
  termStop: (id) => ipcRenderer.send('termStop', id),
  paneInput: (name, data) => ipcRenderer.send('paneInput', name, data),
  paneResize: (name, cols, rows) => ipcRenderer.send('paneResize', name, cols, rows),
  previewCommand: (cwd) => ipcRenderer.invoke('previewCommand', cwd),
  previewServerStart: (conn, cwd, command, cols, rows) => ipcRenderer.invoke('previewServerStart', conn, cwd, command, cols, rows),
  previewServerStop: (conn) => ipcRenderer.send('previewServerStop', conn),
  previewOpen: (conn, url) => ipcRenderer.invoke('previewOpen', conn, url),
  previewLayout: (conn, box, show) => ipcRenderer.send('previewLayout', conn, box, show),
  previewReload: (conn) => ipcRenderer.send('previewReload', conn),
  previewCapture: (conn) => ipcRenderer.invoke('previewCapture', conn),
  previewClose: (conn) => ipcRenderer.send('previewClose', conn),
  simDevices: () => ipcRenderer.invoke('simDevices'),
  simBoot: (udid) => ipcRenderer.invoke('simBoot', udid),
  simShot: (udid, type) => ipcRenderer.invoke('simShot', udid, type),
  simOpenApp: (udid) => ipcRenderer.send('simOpenApp', udid),
  onPreview: (cb) => {
    const listener = (_e: IpcRendererEvent, conn: string, e: PreviewEvent) => cb(conn, e);
    ipcRenderer.on('preview', listener);
    return () => void ipcRenderer.removeListener('preview', listener);
  },
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
  notify: (note) => ipcRenderer.send('notify', note),
  openLink: (url) => ipcRenderer.invoke('openLink', url),
  searchSessions: (query) => ipcRenderer.invoke('searchSessions', query),
  archiveSession: (id, on, computer) => ipcRenderer.invoke('archiveSession', id, on, computer),
  schedule: (args) => ipcRenderer.invoke('schedule', args),
  localImage: (path, cwd) => ipcRenderer.invoke('localImage', path, cwd),
  openPath: (path, cwd, how, line) => ipcRenderer.invoke('openPath', path, cwd, how, line),
  fetchImage: (url) => ipcRenderer.invoke('fetchImage', url),
  sidePaneLayout: (box, show) => ipcRenderer.send('sidePaneLayout', box, show),
  onSidePane: (cb) => {
    const listener = (_e: IpcRendererEvent, e: SidePaneEvent) => cb(e);
    ipcRenderer.on('sidePane', listener);
    return () => void ipcRenderer.off('sidePane', listener);
  },
  onNotificationClick: (cb) => {
    const listener = (_e: IpcRendererEvent, conn: string) => cb(conn);
    ipcRenderer.on('notificationClick', listener);
    return () => void ipcRenderer.off('notificationClick', listener);
  },
  quit: () => ipcRenderer.send('quit'),
};

contextBridge.exposeInMainWorld('binder', api);
