'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow = null;
let pickerWindow = null;
let bluetoothSelectCallback = null;

// Web Bluetooth を有効化
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// ===== メインウィンドウ =====
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 920,
    minWidth: 640,
    minHeight: 500,
    title: 'UFOTW プレイヤー',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'preload.js'),
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Bluetooth ペアリング要求を自動承認
  mainWindow.webContents.session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: true });
  });

  // navigator.bluetooth.requestDevice() が呼ばれるとこのイベントが発火する
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    bluetoothSelectCallback = callback;

    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.webContents.send('bluetooth-devices', deviceList);
    } else if (deviceList.length > 0) {
      openDevicePicker(deviceList);
    }
    // deviceList が空の場合はスキャン継続（ピッカーは開かない）
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
  });
}

// ===== Bluetooth デバイス選択ウィンドウ =====
function openDevicePicker(deviceList) {
  pickerWindow = new BrowserWindow({
    width: 520,
    height: 420,
    parent: mainWindow,
    modal: true,
    title: 'Bluetooth デバイスを選択',
    backgroundColor: '#1a1a2e',
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'device-picker-preload.js')
    }
  });

  pickerWindow.setMenuBarVisibility(false);
  pickerWindow.loadFile(path.join(__dirname, 'src', 'device-picker.html'));

  pickerWindow.webContents.once('did-finish-load', () => {
    pickerWindow.webContents.send('bluetooth-devices', deviceList);
  });

  pickerWindow.on('closed', () => {
    if (bluetoothSelectCallback) {
      bluetoothSelectCallback('');
      bluetoothSelectCallback = null;
    }
    pickerWindow = null;
  });
}

// ===== IPC: デバイス選択・キャンセル =====
ipcMain.on('bluetooth-select', (_event, deviceId) => {
  if (bluetoothSelectCallback) {
    bluetoothSelectCallback(deviceId);
    bluetoothSelectCallback = null;
  }
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.destroy();
  }
});

ipcMain.on('bluetooth-cancel', () => {
  if (bluetoothSelectCallback) {
    bluetoothSelectCallback('');
    bluetoothSelectCallback = null;
  }
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.destroy();
  }
});

// ===== File System / Dialog IPC =====
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '音声作品フォルダを選択',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const folderPath = result.filePaths[0];
  const audioExts  = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma']);
  const csvExts    = new Set(['.csv', '.txt']);

  let entries = [];
  try { entries = await fs.promises.readdir(folderPath); } catch (_) {}

  return {
    path: folderPath,
    audioFiles: entries
      .filter(f => audioExts.has(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, path: path.join(folderPath, f) })),
    csvFiles: entries
      .filter(f => csvExts.has(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, path: path.join(folderPath, f) })),
  };
});

ipcMain.handle('fs:readText', async (_e, filePath) => {
  return fs.promises.readFile(filePath, 'utf-8');
});

ipcMain.handle('fs:readBinary', async (_e, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  // Return as plain Uint8Array so contextBridge can clone it
  return new Uint8Array(buf);
});

ipcMain.handle('fs:toFileUrl', (_e, filePath) => {
  const { pathToFileURL } = require('url');
  return pathToFileURL(filePath).href;
});

ipcMain.handle('fs:writeText', async (_e, filePath, content) => {
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('dialog:showSave', async (_e, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name: 'プレイリスト JSON', extensions: ['json'] }],
    title: 'プレイリストを保存',
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:showOpenJson', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'プレイリスト JSON', extensions: ['json'] }],
    title: 'プレイリストを読み込む',
  });
  return (result.canceled || result.filePaths.length === 0) ? null : result.filePaths[0];
});

// ===== アプリ起動 =====
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
