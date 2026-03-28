'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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
