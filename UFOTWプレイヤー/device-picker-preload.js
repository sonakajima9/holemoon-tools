'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bluetoothPicker', {
  onDevices: (callback) => {
    ipcRenderer.on('bluetooth-devices', (_event, devices) => callback(devices));
  },
  select: (deviceId) => ipcRenderer.send('bluetooth-select', deviceId),
  cancel: () => ipcRenderer.send('bluetooth-cancel')
});
