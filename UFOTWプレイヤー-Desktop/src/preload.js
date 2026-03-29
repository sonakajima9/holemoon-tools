'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder:         ()                    => ipcRenderer.invoke('dialog:openFolder'),
  readTextFile:       (filePath)            => ipcRenderer.invoke('fs:readText',   filePath),
  toFileUrl:          (filePath)            => ipcRenderer.invoke('fs:toFileUrl',  filePath),
  writeTextFile:      (filePath, content)   => ipcRenderer.invoke('fs:writeText',  filePath, content),
  showSaveDialog:     (defaultPath)         => ipcRenderer.invoke('dialog:showSave',     defaultPath),
  showOpenJsonDialog: ()                    => ipcRenderer.invoke('dialog:showOpenJson'),
  cancelScan:         ()                    => ipcRenderer.send('bluetooth-cancel'),
});
