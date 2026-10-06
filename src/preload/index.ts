import { contextBridge, ipcRenderer } from 'electron'
import type { HermitApi, MenuAction } from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: HermitApi = {
  platform: process.platform,
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name, folder) => ipcRenderer.invoke('projects:create', name, folder),
  renameProject: (projectId, name) => ipcRenderer.invoke('projects:rename', projectId, name),
  deleteProject: (projectId) => ipcRenderer.invoke('projects:delete', projectId),
  revealProject: (projectId) => ipcRenderer.invoke('projects:reveal', projectId),
  updateProjectSettings: (projectId, patch) => ipcRenderer.invoke('projects:update-settings', projectId, patch),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  createFolder: (name, parent) => ipcRenderer.invoke('folders:create', name, parent),
  renameFolder: (folder, name) => ipcRenderer.invoke('folders:rename', folder, name),
  deleteFolder: (folder) => ipcRenderer.invoke('folders:delete', folder),
  moveInLibrary: (libraryPath, folder) => ipcRenderer.invoke('library:move', libraryPath, folder),
  listOutline: (projectId) => ipcRenderer.invoke('outline:list', projectId),
  readSheet: (projectId, sheetId) => ipcRenderer.invoke('sheets:read', projectId, sheetId),
  writeSheet: (projectId, sheetId, content) => ipcRenderer.invoke('sheets:write', projectId, sheetId, content),
  createSheet: (projectId, content, afterId, place) =>
    ipcRenderer.invoke('sheets:create', projectId, content, afterId, place),
  createCanvas: (projectId, place, name, content, afterId) =>
    ipcRenderer.invoke('canvases:create', projectId, place, name, content, afterId),
  renameCanvas: (projectId, sheetId, name) => ipcRenderer.invoke('canvases:rename', projectId, sheetId, name),
  saveAttachment: (projectId, name, data) => ipcRenderer.invoke('attachments:save', projectId, name, data),
  deleteSheet: (projectId, sheetId) => ipcRenderer.invoke('sheets:delete', projectId, sheetId),
  moveSheet: (fromProject, sheetId, toProject) => ipcRenderer.invoke('sheets:move', fromProject, sheetId, toProject),
  moveInOutline: (projectId, item, target) => ipcRenderer.invoke('outline:move', projectId, item, target),
  createSubsection: (projectId, parent, name) => ipcRenderer.invoke('subsections:create', projectId, parent, name),
  renameSubsection: (projectId, place, name) => ipcRenderer.invoke('subsections:rename', projectId, place, name),
  deleteSubsection: (projectId, place) => ipcRenderer.invoke('subsections:delete', projectId, place),
  searchSheets: (projectId, query) => ipcRenderer.invoke('sheets:search', projectId, query),
  exportSheets: (projectId, sheetIds, format) => ipcRenderer.invoke('export', projectId, sheetIds, format),
  showContextMenu: (items, at) => ipcRenderer.invoke('context-menu', items, at),
  setAppIcon: (dataUrl) => ipcRenderer.send('app:set-icon', dataUrl),
  getSyncState: () => ipcRenderer.invoke('sync:state'),
  updateSyncSettings: (patch) => ipcRenderer.invoke('sync:update-settings', patch),
  connectSync: (url) => ipcRenderer.invoke('sync:connect', url),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  listConflicts: () => ipcRenderer.invoke('sync:conflicts'),
  resolveConflict: (path, content) => ipcRenderer.invoke('sync:resolve', path, content),
  finishMerge: () => ipcRenderer.invoke('sync:finish-merge'),
  resolveWithAgent: () => ipcRenderer.invoke('sync:agent'),
  cancelAgent: () => ipcRenderer.invoke('sync:cancel-agent'),

  onSyncState: (listener) => subscribe('sync:state', listener),
  onSyncChanged: (listener) => subscribe('sync:changed', listener),
  onAgentOutput: (listener) => subscribe('sync:agent-output', listener),

  onSyncFlush(listener) {
    const handler = async (_: Electron.IpcRendererEvent, id: number) => {
      try {
        await listener()
      } finally {
        ipcRenderer.send('sync:flushed', id)
      }
    }
    ipcRenderer.on('sync:flush', handler)
    return () => ipcRenderer.off('sync:flush', handler)
  },

  onMenu(listener) {
    const handler = (_: Electron.IpcRendererEvent, action: MenuAction) => listener(action)
    ipcRenderer.on('menu', handler)
    return () => ipcRenderer.off('menu', handler)
  },

  onBeforeClose(listener) {
    const handler = async () => {
      try {
        await listener()
      } finally {
        ipcRenderer.send('app:close-ready')
      }
    }
    ipcRenderer.on('app:before-close', handler)
    return () => ipcRenderer.off('app:before-close', handler)
  }
}

contextBridge.exposeInMainWorld('hermit', api)
