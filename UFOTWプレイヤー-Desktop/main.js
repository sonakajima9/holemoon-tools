'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs   = require('fs');

// ===== local:// カスタムプロトコル =====
// app.whenReady() より前に呼び出す必要がある
protocol.registerSchemesAsPrivileged([{
  scheme: 'local',
  privileges: {
    // standard: true は NOT 設定。設定するとChromiumが local:// をナビゲーション可能な
    // スキームとして扱い、audioEl.src への代入がページ遷移トリガーになってしまう。
    // <audio>/<video> 要素のメディアロードは stream: true だけで動作する。
    secure: true,          // HTTPS扱いにして制限を回避
    supportFetchAPI: true, // fetch() でアクセス可能
    stream: true,          // 音声シーク用 Range リクエストをストリームで処理 ＋ <audio>/<video> 要素対応
    bypassCSP: true,
    corsEnabled: true,
  }
}]);

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
      // webSecurity: false は不要（local:// プロトコルで file:// 制限を根本回避）
      preload: path.join(__dirname, 'src', 'preload.js'),
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Bluetooth ペアリング要求を自動承認
  mainWindow.webContents.session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: true });
  });

  // navigator.bluetooth.requestDevice() が呼ばれるとこのイベントが発火する
  // ★ 注意: スキャン中に新デバイスが見つかるたびに同じ requestDevice() に対して
  //   複数回発火する。毎回古いコールバックを '' でキャンセルすると requestDevice()
  //   が途中で拒否されてしまい、その後でユーザーがデバイスを選択した際にクラッシュする。
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();

    if (pickerWindow && !pickerWindow.isDestroyed()) {
      // ピッカーが既に開いている = 同じ requestDevice() スキャンのデバイスリスト更新。
      // コールバックを上書きするだけで、古いコールバックは呼ばない。
      bluetoothSelectCallback = callback;
      pickerWindow.webContents.send('bluetooth-devices', deviceList);
    } else {
      // ピッカーが閉じている = 新しい requestDevice() 呼び出し。
      // 前回の残留コールバックがあれば明示的にキャンセルしてから開始する。
      if (bluetoothSelectCallback) {
        bluetoothSelectCallback('');
      }
      bluetoothSelectCallback = callback;
      // deviceList が空でも即座にピッカーを開く（スキャン中表示＋キャンセル手段を確保）
      openDevicePicker(deviceList);
    }
  });

  // ドラッグ&ドロップで音声ファイルをウィンドウ外に落としたとき
  // Electron が file:// URLへナビゲートするのをメインプロセス側でも防ぐ
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = 'file://' + path.join(__dirname, 'src', 'index.html').replace(/\\/g, '/');
    if (url !== appUrl) {
      event.preventDefault();
    }
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
  // setImmediate で遅延: IPCメッセージの送信元ウィンドウを同一ターン内で destroy() すると
  // Electron 28+ でクラッシュするため、次のイベントループで破棄する
  setImmediate(() => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.destroy();
    }
  });
});

ipcMain.on('bluetooth-cancel', () => {
  if (bluetoothSelectCallback) {
    bluetoothSelectCallback('');
    bluetoothSelectCallback = null;
  }
  setImmediate(() => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.destroy();
    }
  });
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
  // base64url エンコード（+ → -、/ → _、= 除去）して local:// URL を生成
  // file:// の代わりに特権スキーム local:// を使うことで
  // Electron 28 の file:// 制限・日本語パス問題・パッケージ版の制限をすべて回避する
  const b64url = Buffer.from(filePath, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `local:///${b64url}`;
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
  // local:// プロトコルハンドラ
  // net.fetch 委譲では Range リクエストが正しく処理されず音声シークが壊れるため
  // fs で直接読み出して 206 Partial Content を自前で返す
  protocol.handle('local', async (request) => {
    try {
      const url = new URL(request.url);
      let b64 = url.pathname.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const filePath = Buffer.from(b64, 'base64').toString('utf-8');

      const stat = await fs.promises.stat(filePath);
      const total = stat.size;

      const MIME = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav',  '.ogg': 'audio/ogg',
        '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.wma': 'audio/x-ms-wma',
      };
      const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (match) {
          const start    = parseInt(match[1], 10);
          const end      = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
          const chunkLen = end - start + 1;

          const buf = Buffer.allocUnsafe(chunkLen);
          const fh  = await fs.promises.open(filePath, 'r');
          await fh.read(buf, 0, chunkLen, start);
          await fh.close();

          return new Response(buf, {
            status: 206,
            headers: {
              'Content-Type':   contentType,
              'Content-Range':  `bytes ${start}-${end}/${total}`,
              'Content-Length': String(chunkLen),
              'Accept-Ranges':  'bytes',
            },
          });
        }
      }

      // Range なし — ファイル全体を返す
      const buf = await fs.promises.readFile(filePath);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type':   contentType,
          'Content-Length': String(total),
          'Accept-Ranges':  'bytes',
        },
      });
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });

  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
