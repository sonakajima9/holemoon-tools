'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder:        ()             => ipcRenderer.invoke('dialog:openFolder'),
  readTextFile:      (filePath)     => ipcRenderer.invoke('fs:readText',   filePath),
  readBinaryFile:    (filePath)     => ipcRenderer.invoke('fs:readBinary', filePath),
  writeTextFile:     (filePath, content) => ipcRenderer.invoke('fs:writeText', filePath, content),
  showSaveDialog:    (defaultPath)  => ipcRenderer.invoke('dialog:showSave',     defaultPath),
  showOpenJsonDialog: ()            => ipcRenderer.invoke('dialog:showOpenJson'),
});
