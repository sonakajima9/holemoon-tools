'use strict';

// ===== State =====
let bluetoothDevice = null;
let gattCharacteristic = null;
let isConnected = false;
let isUserDisconnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 2000;

// 接続済みのサービス/キャラクタリスティックUUID（再接続用）
let connectedServiceUUID = null;
let connectedCharUUID = null;

const KNOWN_SERVICE_UUIDS = [
  '40ee1111-63ec-4b7f-8ce7-712efd55b90e', // ★ Vorze UFO TW / UFO SA / A10 Cyclone SA / Piston (正式UUID)
  '0000fff0-0000-1000-8000-00805f9b34fb', // 汎用BLE制御（多数の玩具）
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service (NUS)
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip BM70
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 BLE Serial
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ab00-0000-1000-8000-00805f9b34fb',
  '0000ffd0-0000-1000-8000-00805f9b34fb',
  '0000ffc0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000fee9-0000-1000-8000-00805f9b34fb',
  'd0611e78-bbb4-4591-a5f8-487910ae4366', // Lovense 新型
  'f0006900-0451-4000-b000-000000000000', // Lelo / 汎用
];

let audioEl = null;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let waveformRAF = null;

let csvRows = []; // [{time(sec), direction, speed}] or [{time, leftDir, leftSpeed, rightDir, rightSpeed}]
let csvFormat = 3;

let commandTimer = null;
let testStopTimer = null;
let sendCount = 0;
let isPlaying = false;

let audioQueue = [];
let csvQueue = [];
let currentTrackIndex = 0;

// pathTracks: null = ドラッグ&ドロップモード
//             array = パスベース（作品管理 / プレイリスト）モード
// 各要素: { audioPath, audioName, csvPath, csvName }
let pathTracks = null;

// ===== Work / Folder Management State =====
let currentWork        = null; // { path, audioFiles:[{name,path}], csvFiles:[{name,path}] }
let selectedWorkAudio  = null; // { name, path }
let selectedWorkCsv    = null; // { name, path } | null

// ===== Playlist State =====
let playlists       = []; // [{ id, name, items:[{id,audioName,audioPath,csvName,csvPath}] }]
let activePlaylistId = null;

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  audioEl = document.getElementById('audioElement');

  if (!navigator.bluetooth) {
    document.getElementById('noBtWarning').style.display = 'block';
  }

  setupDragDrop('audioDrop', 'audio/*', loadAudioFile);
  setupDragDrop('csvDrop', '.csv,.txt', loadCSVFile);

  audioEl.addEventListener('timeupdate', onTimeUpdate);
  audioEl.addEventListener('ended', onAudioEnded);
  audioEl.addEventListener('error', () => {
    const code = audioEl.error ? audioEl.error.code : '?';
    showToast(`音声読み込み失敗 (code ${code}): ファイルが見つからないか形式に対応していません`, true);
    document.getElementById('playBtn').disabled = true;
    isPlaying = false;
    document.getElementById('playBtn').classList.remove('playing');
    document.getElementById('playBtn').textContent = '▶';
  });

  document.getElementById('waveformCanvas').addEventListener('click', seekFromWaveform);
  document.getElementById('patternCanvas').addEventListener('click', seekFromPattern);

  drawWaveformEmpty();
  updateTrackUI();
});

// ===== Drag & Drop helpers =====
function setupDragDrop(zoneId, accept, handler) {
  const zone = document.getElementById(zoneId);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length) handler({ target: { files } });
  });
}

// ===== Bluetooth =====
function connectGattWithTimeout(gatt, ms = 10000) {
  return Promise.race([
    gatt.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('接続タイムアウト（10秒）'), { name: 'TimeoutError' })), ms)
    )
  ]);
}

// カスタムUUID入力欄を読む
function getCustomUUIDs() {
  const svc  = (document.getElementById('customServiceUUID')?.value  || '').trim().toLowerCase();
  const char = (document.getElementById('customCharUUID')?.value     || '').trim().toLowerCase();
  return { customSvcUUID: svc || null, customCharUUID: char || null };
}

// サービスをスキャンして書き込み可能な最初のキャラクタリスティックを返す
// 戻り値: { serviceUUID, charUUID, characteristic } | null
// 失敗時の診断用に { _diag: { serviceCount, charCount } } を追加で返す
async function findWritableCharacteristic(server) {
  const { customSvcUUID, customCharUUID } = getCustomUUIDs();

  // --- カスタムUUIDが両方指定されている場合は直接取得 ---
  if (customSvcUUID && customCharUUID) {
    try {
      const svc  = await server.getPrimaryService(customSvcUUID);
      const char = await svc.getCharacteristic(customCharUUID);
      if (char.properties.write || char.properties.writeWithoutResponse) {
        return { serviceUUID: svc.uuid, charUUID: char.uuid, characteristic: char };
      }
    } catch (_) {}
  }

  // --- 自動スキャン ---
  let services = [];
  try {
    services = await server.getPrimaryServices();
  } catch (_) {}

  // getPrimaryServices() が空配列を返した場合もフォールバックを試みる
  if (services.length === 0) {
    const candidates = customSvcUUID
      ? [customSvcUUID, ...KNOWN_SERVICE_UUIDS]
      : KNOWN_SERVICE_UUIDS;
    for (const uuid of candidates) {
      try {
        services.push(await server.getPrimaryService(uuid));
      } catch (_) {}
    }
  }

  let totalCharCount = 0;
  for (const service of services) {
    let chars;
    try { chars = await service.getCharacteristics(); } catch (_) { continue; }
    totalCharCount += chars.length;
    for (const char of chars) {
      if (char.properties.write || char.properties.writeWithoutResponse) {
        return { serviceUUID: service.uuid, charUUID: char.uuid, characteristic: char };
      }
    }
  }

  // 見つからなかった場合は診断情報を付けて null を返す
  return { _notFound: true, _diag: { serviceCount: services.length, charCount: totalCharCount } };
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth API 非対応の環境です', true);
    return;
  }
  const nameFilter = document.getElementById('btNameFilter').value.trim();

  setBtStatus('connecting', '接続中...');
  document.getElementById('btConnectBtn').disabled = true;
  try {
    const { customSvcUUID } = getCustomUUIDs();
    const optionalServices = customSvcUUID
      ? [customSvcUUID, ...KNOWN_SERVICE_UUIDS]
      : KNOWN_SERVICE_UUIDS;

    const filters = nameFilter ? [{ namePrefix: nameFilter }] : undefined;
    const device = await navigator.bluetooth.requestDevice({
      filters,
      acceptAllDevices: !nameFilter,
      optionalServices,
    });

    device.removeEventListener('gattserverdisconnected', onBtDisconnected);
    device.addEventListener('gattserverdisconnected', onBtDisconnected);

    showToast('GATT 接続中...');
    const server = await connectGattWithTimeout(device.gatt);
    const found  = await findWritableCharacteristic(server);

    if (!found || found._notFound) {
      server.disconnect();
      document.getElementById('btConnectBtn').disabled = false;
      const diag = found?._diag;
      const diagMsg = diag
        ? `（検出: サービス ${diag.serviceCount} 件 / キャラクタリスティック ${diag.charCount} 件）`
        : '';
      const hint = diag?.serviceCount > 0
        ? ' 詳細設定でサービスUUID・キャラクタリスティックUUIDを手動指定してください。'
        : ' UFOTWのサービスUUIDが未登録の可能性があります。詳細設定で手動指定してください。';
      setBtStatus('error', `接続失敗: 書き込み可能なキャラクタリスティックが見つかりませんでした${diagMsg}`);
      showToast(`キャラクタリスティックが見つかりません${diagMsg}${hint}`, true);
      return;
    }

    bluetoothDevice       = device;
    gattCharacteristic    = found.characteristic;
    connectedServiceUUID  = found.serviceUUID;
    connectedCharUUID     = found.charUUID;
    isConnected           = true;
    isUserDisconnected    = false;
    reconnectAttempts     = 0;

    setBtStatus('connected', `接続済み: ${device.name || '(名前なし)'}`);
    document.getElementById('btConnectBtn').disabled    = true;
    document.getElementById('btDisconnectBtn').disabled = false;
    showToast('Bluetooth 接続しました');
  } catch (err) {
    document.getElementById('btConnectBtn').disabled = false;
    bluetoothDevice = null;
    if (err.name !== 'NotFoundError') {
      const detail = err.name === 'NetworkError'
        ? 'デバイスとの通信に失敗しました。デバイスが近くにあるか確認してください'
        : `${err.name}: ${err.message}`;
      setBtStatus('error', `接続失敗: ${detail}`);
      showToast(`接続失敗: ${detail}`, true);
    } else {
      setBtStatus('', '未接続');
    }
  }
}

function disconnectBluetooth() {
  isUserDisconnected = true;
  reconnectAttempts = 0;
  clearTimeout(reconnectTimer);
  if (bluetoothDevice && bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  } else {
    onBtDisconnected();
  }
}

function onBtDisconnected() {
  isConnected = false;
  gattCharacteristic = null;

  const autoReconnect = document.getElementById('btAutoReconnect').checked;
  if (!isUserDisconnected && autoReconnect && bluetoothDevice) {
    scheduleReconnect();
  } else {
    isUserDisconnected = false;
    reconnectAttempts = 0;
    setBtStatus('', '未接続');
    document.getElementById('btConnectBtn').disabled = false;
    document.getElementById('btDisconnectBtn').disabled = true;
    showToast('Bluetooth 切断されました');
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts = 0;
    setBtStatus('error', '再接続失敗（上限到達）');
    document.getElementById('btConnectBtn').disabled = false;
    document.getElementById('btDisconnectBtn').disabled = true;
    showToast('自動再接続に失敗しました。手動で接続してください。', true);
    return;
  }
  const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  setBtStatus('connecting', `再接続中... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  showToast(`切断されました。${delay / 1000}秒後に再接続を試みます (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnectTimer = setTimeout(attemptReconnect, delay);
}

async function attemptReconnect() {
  if (!bluetoothDevice) return;
  try {
    const server = await connectGattWithTimeout(bluetoothDevice.gatt);
    let found = null;
    // まず前回と同じサービス/キャラクタリスティックで再接続を試みる
    if (connectedServiceUUID && connectedCharUUID) {
      try {
        const svc  = await server.getPrimaryService(connectedServiceUUID);
        const char = await svc.getCharacteristic(connectedCharUUID);
        found = { characteristic: char };
      } catch (_) {}
    }
    if (!found) {
      found = await findWritableCharacteristic(server);
    }
    if (!found || found._notFound) throw new Error('キャラクタリスティック取得失敗');

    gattCharacteristic = found.characteristic;
    isConnected = true;
    reconnectAttempts = 0;
    setBtStatus('connected', `接続済み: ${bluetoothDevice.name || '(名前なし)'}`);
    document.getElementById('btConnectBtn').disabled    = true;
    document.getElementById('btDisconnectBtn').disabled = false;
    showToast('Bluetooth 再接続しました');
  } catch (err) {
    scheduleReconnect();
  }
}

function setBtStatus(state, label) {
  const dot = document.getElementById('btDot');
  dot.className = 'bt-dot' + (state ? ' ' + state : '');
  document.getElementById('btLabel').textContent = label;
}

async function testCommand() {
  if (!isConnected) { showToast('未接続です', true); return; }

  const target  = document.getElementById('testTarget').value; // 'both' | 'left' | 'right'
  const dir     = parseInt(document.getElementById('testDir').value) || 0; // 0=正転, 1=逆転
  const speed   = clamp(parseInt(document.getElementById('testSpeed').value) || 50, 0, 100);
  const fmt     = document.getElementById('cmdFormat').value;
  const isDual  = (fmt === 'vorze_tw' || fmt === 'raw4'); // デュアルモーター判定はデバイス種別で行う

  const dirLabel    = dir ? '逆転' : '正転';
  const targetLabel = target === 'both' ? '両方' : target === 'left' ? '左' : '右';

  // 前回のテスト停止タイマーをクリア
  if (testStopTimer) { clearTimeout(testStopTimer); testStopTimer = null; }

  try {
    if (isDual) {
      const lSpeed = target !== 'right' ? speed : 0;
      const rSpeed = target !== 'left'  ? speed : 0;
      const lDir   = target !== 'right' ? dir   : 0;
      const rDir   = target !== 'left'  ? dir   : 0;
      const bytes  = buildCommandBytes(lDir, lSpeed, rDir, rSpeed);
      const hex    = Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      await sendRawCommand(lDir, lSpeed, rDir, rSpeed);
      showToast(`テスト送信OK（${targetLabel} ${dirLabel} ${speed}） → [${hex}]`);
      document.getElementById('testStopBtn').disabled = false;
      testStopTimer = setTimeout(() => stopTestCommand(), 1000);
    } else {
      const bytes = buildCommandBytes(dir, speed, 0, 0);
      const hex   = Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      await sendRawCommand(dir, speed);
      showToast(`テスト送信OK（${dirLabel} ${speed}） → [${hex}]`);
      document.getElementById('testStopBtn').disabled = false;
      testStopTimer = setTimeout(() => stopTestCommand(), 1000);
    }
  } catch (err) {
    showToast(`送信失敗: ${err.message}`, true);
  }
}

async function stopTestCommand() {
  if (testStopTimer) { clearTimeout(testStopTimer); testStopTimer = null; }
  document.getElementById('testStopBtn').disabled = true;
  if (!isConnected) return;
  try {
    const fmt = document.getElementById('cmdFormat').value;
    if (fmt === 'vorze_tw' || fmt === 'raw4') {
      await sendRawCommand(0, 0, 0, 0);
    } else {
      await sendRawCommand(0, 0);
    }
  } catch (_) {}
}

// ===== Command Building =====
function buildCommandBytes(dir, speed, rightDir, rightSpeed) {
  const fmt = document.getElementById('cmdFormat').value;
  speed = Math.round(Math.min(100, Math.max(0, speed)));
  const speedByte = Math.round(speed * 2.55); // 0-100 → 0-255

  switch (fmt) {
    case 'vorze_tw': {
      // UFO TW / UFO SA: [0x01, leftByte, rightByte]
      // 各バイト: (direction << 7) | speed(0-100)
      const rs = Math.round(Math.min(100, Math.max(0, rightSpeed || 0)));
      const leftByte  = ((dir & 0x01) << 7) | speed;
      const rightByte = (((rightDir || 0) & 0x01) << 7) | rs;
      return new Uint8Array([0x01, leftByte, rightByte]);
    }
    case 'vorze_sa': {
      // A10 Cyclone SA / Piston: [0x01, motorByte]
      // motorByte: (direction << 7) | speed(0-100)
      const motorByte = ((dir & 0x01) << 7) | speed;
      return new Uint8Array([0x01, motorByte]);
    }
    case 'lovense': {
      const text = `Vibrate:${speed};\r\n`;
      return new TextEncoder().encode(text);
    }
    case 'raw1':
      return new Uint8Array([speedByte]);
    case 'raw2':
      return new Uint8Array([dir & 0x01, speedByte]);
    case 'raw4': {
      const rs  = Math.round(Math.min(100, Math.max(0, rightSpeed || 0)) * 2.55);
      return new Uint8Array([(dir & 0x01), speedByte, ((rightDir || 0) & 0x01), rs]);
    }
    case 'kiiroo':
      return new Uint8Array([0x01, speedByte, 0x00, 0x00]);
    default:
      return new Uint8Array([speedByte]);
  }
}

async function sendRawCommand(dir, speed, rightDir = 0, rightSpeed = 0) {
  if (!gattCharacteristic) return;
  const bytes = buildCommandBytes(dir, speed, rightDir, rightSpeed);
  if (gattCharacteristic.properties.writeWithoutResponse) {
    await gattCharacteristic.writeValueWithoutResponse(bytes);
  } else {
    await gattCharacteristic.writeValue(bytes);
  }
}

// ===== CSV =====
function loadCSVFile(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  csvQueue = files;
  applyCSVTrack(files[Math.min(currentTrackIndex, files.length - 1)]);
  updateTrackUI();
  event.target.value = '';
}

function applyCSVTrack(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      parseCSV(e.target.result);
      const idx = Math.min(currentTrackIndex, csvQueue.length - 1);
      document.getElementById('csvFilename').textContent =
        csvQueue.length > 1 ? `${file.name} (${idx + 1}/${csvQueue.length})` : file.name;
      document.getElementById('csvDrop').classList.add('loaded');
      document.getElementById('patternPanel').style.display = 'block';
      drawPattern();
      showToast(`CSV: ${file.name} (${csvRows.length}行)`);
    } catch (err) {
      showToast(`CSV 解析失敗: ${err.message}`, true);
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (lines.length === 0) throw new Error('空のCSVです');

  const firstCols = lines[0].split(',').length;
  csvFormat = firstCols >= 5 ? 5 : 3;

  csvRows = lines.map(line => {
    const c = line.split(',').map(s => s.trim());
    const t = (parseFloat(c[0]) || 0) / 10; // 1/10秒 → 秒
    if (csvFormat === 5) {
      return {
        time: t,
        leftDir:   parseInt(c[1]) || 0,
        leftSpeed: clamp(parseInt(c[2]) || 0, 0, 100),
        rightDir:  parseInt(c[3]) || 0,
        rightSpeed: clamp(parseInt(c[4]) || 0, 0, 100),
      };
    } else {
      return {
        time:      t,
        direction: parseInt(c[1]) || 0,
        speed:     clamp(parseInt(c[2]) || 0, 0, 100),
      };
    }
  }).sort((a, b) => a.time - b.time);

  document.getElementById('rightCard').style.display = csvFormat === 5 ? '' : 'none';
  document.getElementById('rightDirCard').style.display = csvFormat === 5 ? '' : 'none';

  const maxT = csvRows[csvRows.length - 1]?.time || 0;
  document.getElementById('csvInfo').textContent =
    `フォーマット: ${csvFormat}列 | 行数: ${csvRows.length} | 最大時刻: ${maxT.toFixed(1)}秒`;
}

function getValuesAtTime(t) {
  if (csvRows.length === 0) return null;

  const interp = document.getElementById('interpMode').value;
  const afterEnd = document.getElementById('afterCsvEnd').value;

  if (t < csvRows[0].time) return makeZeroRow();

  if (t >= csvRows[csvRows.length - 1].time) {
    if (afterEnd === 'zero') return makeZeroRow();
    if (afterEnd === 'last') return csvRows[csvRows.length - 1];
    return null;
  }

  let lo = 0, hi = csvRows.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (csvRows[mid].time <= t) lo = mid; else hi = mid - 1;
  }
  const prev = csvRows[lo];
  const next = csvRows[lo + 1];

  if (interp === 'step') return prev;

  const ratio = (t - prev.time) / (next.time - prev.time);
  if (csvFormat === 5) {
    return {
      time: t,
      leftDir:    prev.leftDir,
      leftSpeed:  Math.round(lerp(prev.leftSpeed,  next.leftSpeed,  ratio)),
      rightDir:   prev.rightDir,
      rightSpeed: Math.round(lerp(prev.rightSpeed, next.rightSpeed, ratio)),
    };
  } else {
    return {
      time: t,
      direction: prev.direction,
      speed: Math.round(lerp(prev.speed, next.speed, ratio)),
    };
  }
}

function makeZeroRow() {
  if (csvFormat === 5) {
    return { time: 0, leftDir: 0, leftSpeed: 0, rightDir: 0, rightSpeed: 0 };
  }
  return { time: 0, direction: 0, speed: 0 };
}

// ===== Audio =====
function loadAudioFile(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  audioQueue = files;
  csvQueue   = [];
  pathTracks = null; // ドラッグ&ドロップモードに戻す
  currentTrackIndex = 0;
  applyAudioTrack(files[0]);
  updateTrackUI();
  event.target.value = '';
}

function applyAudioTrack(file) {
  const url = URL.createObjectURL(file);
  audioEl.src = url;
  audioEl.load();

  document.getElementById('audioFilename').textContent =
    audioQueue.length > 1 ? `${file.name} (${currentTrackIndex + 1}/${audioQueue.length})` : file.name;
  document.getElementById('audioDrop').classList.add('loaded');
  document.getElementById('playBtn').disabled = false;
  document.getElementById('stopBtn').disabled = false;

  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  drawWaveformEmpty();
  // 100MB 超のファイルは decodeAudioData 自体が長時間メインスレッドを占有するためスキップ
  const MAX_WAVEFORM_FILE = 100 * 1024 * 1024;
  if (file.size > MAX_WAVEFORM_FILE) {
    showToast(`音声: ${file.name}（波形表示スキップ: ${(file.size / 1024 / 1024).toFixed(0)}MB）`);
  } else {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await audioCtx.decodeAudioData(e.target.result.slice(0));
        drawWaveform(decoded);
      } catch (err) {
        drawWaveformEmpty();
        showToast(`波形生成失敗: ${err.message}`, true);
      }
    };
    reader.readAsArrayBuffer(file);
    showToast(`音声: ${file.name}`);
  }
}

function togglePlayback() {
  if (!audioEl.src) { showToast('音声ファイルを読み込んでください', true); return; }
  if (isPlaying) {
    audioEl.pause();
    stopCommandTimer();
    isPlaying = false;
    document.getElementById('playBtn').classList.remove('playing');
    document.getElementById('playBtn').textContent = '▶';
  } else {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    audioEl.play();
    startCommandTimer();
    isPlaying = true;
    document.getElementById('playBtn').classList.add('playing');
    document.getElementById('playBtn').textContent = '⏸';
  }
}

function stopPlayback() {
  audioEl.pause();
  audioEl.currentTime = 0;
  stopCommandTimer();
  isPlaying = false;
  document.getElementById('playBtn').classList.remove('playing');
  document.getElementById('playBtn').textContent = '▶';
  updatePlaybackUI(0);

  if (document.getElementById('sendZeroOnStop').value === '1' && isConnected) {
    sendRawCommand(0, 0, 0, 0).catch(() => {});
  }
  clearStatusDisplay();
}

async function onAudioEnded() {
  if (currentTrackIndex < getTrackCount() - 1) {
    stopCommandTimer();
    isPlaying = false;
    document.getElementById('playBtn').classList.remove('playing');
    document.getElementById('playBtn').textContent = '▶';
    await loadTrackAt(currentTrackIndex + 1);
    audioEl.addEventListener('canplay', function() {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      audioEl.play().then(() => {
        startCommandTimer();
        isPlaying = true;
        document.getElementById('playBtn').classList.add('playing');
        document.getElementById('playBtn').textContent = '⏸';
      }).catch(() => {});
    }, { once: true });
  } else {
    stopPlayback();
  }
}

async function loadTrackAt(index) {
  currentTrackIndex = index;

  if (pathTracks !== null) {
    const track = pathTracks[index];
    if (!track) return;
    await applyAudioFromPath(track.audioPath, track.audioName);
    if (track.csvPath) {
      await applyCSVFromPath(track.csvPath, track.csvName);
    } else {
      clearCSVState();
    }
  } else {
    applyAudioTrack(audioQueue[index]);
    if (csvQueue.length > 0) {
      applyCSVTrack(csvQueue[Math.min(index, csvQueue.length - 1)]);
    }
  }
  updateTrackUI();
}

function getTrackCount() {
  return pathTracks !== null ? pathTracks.length : audioQueue.length;
}

function updateTrackUI() {
  const total = getTrackCount();
  document.getElementById('trackCounter').textContent =
    total > 1 ? `トラック ${currentTrackIndex + 1} / ${total}` : '';
  document.getElementById('prevTrackBtn').disabled = currentTrackIndex <= 0;
  document.getElementById('nextTrackBtn').disabled = total === 0 || currentTrackIndex >= total - 1;
}

async function prevTrack() {
  if (currentTrackIndex <= 0) return;
  const wasPlaying = isPlaying;
  stopPlayback();
  await loadTrackAt(currentTrackIndex - 1);
  if (wasPlaying) {
    audioEl.addEventListener('canplay', function() {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      audioEl.play().then(() => {
        startCommandTimer();
        isPlaying = true;
        document.getElementById('playBtn').classList.add('playing');
        document.getElementById('playBtn').textContent = '⏸';
      }).catch(() => {});
    }, { once: true });
  }
}

async function nextTrack() {
  if (currentTrackIndex >= getTrackCount() - 1) return;
  const wasPlaying = isPlaying;
  stopPlayback();
  await loadTrackAt(currentTrackIndex + 1);
  if (wasPlaying) {
    audioEl.addEventListener('canplay', function() {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      audioEl.play().then(() => {
        startCommandTimer();
        isPlaying = true;
        document.getElementById('playBtn').classList.add('playing');
        document.getElementById('playBtn').textContent = '⏸';
      }).catch(() => {});
    }, { once: true });
  }
}

function onTimeUpdate() {
  if (!audioEl) return;
  updatePlaybackUI(audioEl.currentTime);
}

function updatePlaybackUI(t) {
  const total = audioEl.duration || 0;
  const audioPct = total > 0 ? (t / total) * 100 : 0;
  document.getElementById('playbackFill').style.width = `${audioPct}%`;
  document.getElementById('playbackTime').textContent = `${formatTime(t)} / ${formatTime(total)}`;

  document.getElementById('waveformPlayhead').style.left = `${audioPct}%`;

  if (csvRows.length > 0) {
    const maxT = csvRows[csvRows.length - 1].time;
    const csvPct = maxT > 0 ? Math.min((t / maxT) * 100, 100) : 0;
    document.getElementById('patternPlayhead').style.left = `${csvPct}%`;
  }
}

function seekAudio(e) {
  if (!audioEl.duration) return;
  const bar = document.getElementById('playbackBar');
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audioEl.currentTime = ratio * audioEl.duration;
}

function seekFromWaveform(e) {
  if (!audioEl.duration) return;
  const canvas = document.getElementById('waveformCanvas');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audioEl.currentTime = ratio * audioEl.duration;
}

function seekFromPattern(e) {
  if (!audioEl.duration || csvRows.length === 0) return;
  const canvas = document.getElementById('patternCanvas');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const maxT = csvRows[csvRows.length - 1].time;
  audioEl.currentTime = Math.min(ratio * maxT, audioEl.duration);
}

function setVolume(v) {
  audioEl.volume = v;
  document.getElementById('volumeLabel').textContent = `${Math.round(v * 100)}%`;
}

// ===== Command Timer =====
function startCommandTimer() {
  stopCommandTimer();
  const interval = parseInt(document.getElementById('sendInterval').value) || 100;
  commandTimer = setInterval(async () => {
    if (!isPlaying) return;
    const t = audioEl.currentTime;
    const vals = getValuesAtTime(t);
    if (vals === null) return;

    updateStatusDisplay(t, vals);

    if (!isConnected) return;
    try {
      if (csvFormat === 5) {
        await sendRawCommand(vals.leftDir, vals.leftSpeed, vals.rightDir, vals.rightSpeed);
      } else {
        await sendRawCommand(vals.direction, vals.speed);
      }
      sendCount++;
      document.getElementById('statCount').textContent = sendCount;
    } catch (err) {
      // Silent: device may have disconnected
    }
  }, interval);
}

function stopCommandTimer() {
  if (commandTimer) { clearInterval(commandTimer); commandTimer = null; }
}

// ===== Status Display =====
function updateStatusDisplay(t, vals) {
  document.getElementById('statTime').textContent = formatTime(t);
  if (csvFormat === 5) {
    document.getElementById('statSpeedL').textContent = vals.leftSpeed;
    document.getElementById('statDirL').textContent   = vals.leftDir ? '逆転' : '正転';
    document.getElementById('statSpeedR').textContent = vals.rightSpeed;
    document.getElementById('statDirR').textContent   = vals.rightDir ? '逆転' : '正転';
  } else {
    document.getElementById('statSpeedL').textContent = vals.speed;
    document.getElementById('statDirL').textContent   = vals.direction ? '逆転' : '正転';
  }
}

function clearStatusDisplay() {
  ['statTime','statSpeedL','statDirL','statSpeedR','statDirR'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '--';
  });
}

// ===== Waveform Drawing =====
function drawWaveformEmpty() {
  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 800;
  canvas.height = 80;
  ctx.fillStyle = '#0a0f1e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#0f3460';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
}

function drawWaveform(audioBuffer) {
  const canvas = document.getElementById('waveformCanvas');
  canvas.width = canvas.offsetWidth || 800;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#0a0f1e';
  ctx.fillRect(0, 0, W, H);

  const data = audioBuffer.getChannelData(0);
  const totalSamples = data.length;
  const step = Math.ceil(totalSamples / W);
  // 1ピクセルあたり最大256サンプルに間引き
  // （大容量ファイルで step が巨大になっても総ループ数を W×256 以内に抑える）
  const stride = Math.max(1, Math.floor(step / 256));
  const half = H / 2;

  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    const base = x * step;
    const end  = Math.min(base + step, totalSamples);
    for (let j = base; j < end; j += stride) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x, half + min * half);
    ctx.lineTo(x, half + max * half);
  }
  ctx.stroke();
}

// ===== Pattern Graph Drawing =====
function drawPattern() {
  if (csvRows.length === 0) return;
  const canvas = document.getElementById('patternCanvas');
  canvas.width = canvas.offsetWidth || 800;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const maxT = csvRows[csvRows.length - 1].time;

  ctx.fillStyle = '#0a0f1e';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#0f3460';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (H / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  function plotLine(getVal, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    csvRows.forEach((row, i) => {
      const x = maxT > 0 ? (row.time / maxT) * W : 0;
      const y = H - (getVal(row) / 100) * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (csvFormat === 5) {
    plotLine(r => r.leftSpeed,  '#e94560');
    plotLine(r => r.rightSpeed, '#3498db');
    ctx.fillStyle = '#e94560'; ctx.fillRect(W - 80, 4, 12, 4);
    ctx.fillStyle = '#aaa'; ctx.font = '11px sans-serif'; ctx.fillText('左', W - 64, 11);
    ctx.fillStyle = '#3498db'; ctx.fillRect(W - 80, 14, 12, 4);
    ctx.fillStyle = '#aaa'; ctx.fillText('右', W - 64, 21);
  } else {
    plotLine(r => r.speed, '#e94560');
  }
}

// ===== Utilities =====
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isError ? '#c0392b' : '#27ae60';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

window.addEventListener('resize', () => {
  drawWaveformEmpty();
  if (csvRows.length > 0) drawPattern();
});

// ===== Path-based Audio / CSV Loading =====
async function applyAudioFromPath(audioPath, audioName) {
  try {
    // file:// URL を直接使用して音声再生 — 巨大ファイルのバイナリIPC転送によるフリーズを回避
    const fileUrl = await window.electronAPI.toFileUrl(audioPath);
    if (audioEl.src && audioEl.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioEl.src);
    }
    audioEl.src = fileUrl;
    audioEl.load();

    const total = getTrackCount();
    document.getElementById('audioFilename').textContent =
      total > 1 ? `${audioName} (${currentTrackIndex + 1}/${total})` : audioName;
    document.getElementById('audioDrop').classList.add('loaded');
    document.getElementById('playBtn').disabled  = false;
    document.getElementById('stopBtn').disabled  = false;

    showToast(`音声: ${audioName}`);

    // 波形描画は別途非同期で実行（再生開始をブロックしない）
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    drawWaveformEmpty();
    (async () => {
      try {
        const uint8 = await window.electronAPI.readBinaryFile(audioPath);
        const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        drawWaveform(decoded);
      } catch (decErr) {
        drawWaveformEmpty();
        // 波形失敗は再生に影響しないため静かにトーストのみ
        showToast(`波形生成失敗: ${decErr.message}`, true);
      }
    })();
  } catch (err) {
    showToast(`音声読み込み失敗: ${err.message}`, true);
  }
}

async function applyCSVFromPath(csvPath, csvName) {
  try {
    const text = await window.electronAPI.readTextFile(csvPath);
    parseCSV(text);

    const total = getTrackCount();
    document.getElementById('csvFilename').textContent =
      total > 1 ? `${csvName} (${currentTrackIndex + 1}/${total})` : csvName;
    document.getElementById('csvDrop').classList.add('loaded');
    document.getElementById('patternPanel').style.display = 'block';
    drawPattern();
    showToast(`CSV: ${csvName} (${csvRows.length}行)`);
  } catch (err) {
    showToast(`CSV 読み込み失敗: ${err.message}`, true);
  }
}

function clearCSVState() {
  csvRows  = [];
  csvFormat = 3;
  document.getElementById('csvFilename').textContent = '';
  document.getElementById('csvDrop').classList.remove('loaded');
  document.getElementById('patternPanel').style.display = 'none';
}

// ===== Work / Folder Management =====
async function openWorkFolder() {
  if (!window.electronAPI) {
    showToast('この機能はデスクトップ版でのみ利用できます', true);
    return;
  }
  const work = await window.electronAPI.openFolder();
  if (!work) return;

  currentWork       = work;
  selectedWorkAudio = null;
  selectedWorkCsv   = null;

  document.getElementById('workFolderLabel').textContent = work.path;
  document.getElementById('workColumns').style.display   = '';
  document.getElementById('workLinkArea').style.display  = '';

  renderWorkAudioList();
  renderWorkCsvList();
  updateWorkLinkUI();
}

// ファイル名（拡張子なし）を返す
function stemName(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

// 音声ファイル名に一致するCSVを候補から探す
function findMatchingCsv(audioFile) {
  if (!currentWork) return null;
  const stem = stemName(audioFile.name).toLowerCase();
  return currentWork.csvFiles.find(c => stemName(c.name).toLowerCase() === stem) || null;
}

function renderWorkAudioList() {
  const list = document.getElementById('workAudioList');
  list.innerHTML = '';
  if (!currentWork) return;

  if (currentWork.audioFiles.length === 0) {
    list.innerHTML = '<div style="padding:10px;font-size:0.8rem;color:#555;">音声ファイルが見つかりません</div>';
    return;
  }

  currentWork.audioFiles.forEach(file => {
    const item = document.createElement('div');
    item.className = 'work-file-item';
    if (selectedWorkAudio?.path === file.path) item.classList.add('selected-audio');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = file.name;

    const matchedCsv = findMatchingCsv(file);
    if (matchedCsv) {
      const badge = document.createElement('span');
      badge.className   = 'csv-match-badge';
      badge.textContent = '📊';
      badge.title       = `対応CSV: ${matchedCsv.name}`;
      item.appendChild(nameSpan);
      item.appendChild(badge);
    } else {
      item.appendChild(nameSpan);
    }

    item.title = file.path;
    item.addEventListener('click', () => {
      selectedWorkAudio = file;
      // 同名CSVを自動選択
      const auto = findMatchingCsv(file);
      if (auto) selectedWorkCsv = auto;
      renderWorkAudioList();
      renderWorkCsvList();
      updateWorkLinkUI();
    });
    item.addEventListener('dblclick', () => {
      selectedWorkAudio = file;
      const auto = findMatchingCsv(file);
      if (auto) selectedWorkCsv = auto;
      previewLinkedTrack();
    });
    list.appendChild(item);
  });
}

function renderWorkCsvList() {
  const list = document.getElementById('workCsvList');
  list.innerHTML = '';
  if (!currentWork) return;

  // "CSVなし" 選択肢
  const noneItem = document.createElement('div');
  noneItem.className   = 'work-file-item';
  noneItem.textContent = '（CSVなし）';
  noneItem.style.color = '#555';
  noneItem.style.fontStyle = 'italic';
  if (selectedWorkCsv === null) noneItem.style.background = 'rgba(80,80,80,0.15)';
  noneItem.addEventListener('click', () => {
    selectedWorkCsv = null;
    renderWorkCsvList();
    updateWorkLinkUI();
  });
  list.appendChild(noneItem);

  if (currentWork.csvFiles.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:10px;font-size:0.8rem;color:#555;';
    empty.textContent   = 'CSVファイルが見つかりません';
    list.appendChild(empty);
    return;
  }

  currentWork.csvFiles.forEach(file => {
    const item = document.createElement('div');
    item.className = 'work-file-item';
    if (selectedWorkCsv?.path === file.path) item.classList.add('selected-csv');
    item.textContent = file.name;
    item.title       = file.path;
    item.addEventListener('click', () => {
      selectedWorkCsv = file;
      renderWorkCsvList();
      updateWorkLinkUI();
    });
    list.appendChild(item);
  });
}

function updateWorkLinkUI() {
  const audioLabel = document.getElementById('selectedAudioLabel');
  const csvLabel   = document.getElementById('selectedCsvLabel');
  const previewBtn = document.getElementById('previewLinkBtn');
  const addBtn     = document.getElementById('addToPlaylistBtn');

  audioLabel.textContent = selectedWorkAudio ? selectedWorkAudio.name : '未選択';
  csvLabel.textContent   = selectedWorkCsv   ? selectedWorkCsv.name   : '（なし）';

  const hasAudio = selectedWorkAudio !== null;
  previewBtn.disabled = !hasAudio;
  addBtn.disabled     = !hasAudio || !activePlaylistId;
}

async function previewLinkedTrack() {
  if (!selectedWorkAudio) return;

  pathTracks = [{
    audioPath: selectedWorkAudio.path,
    audioName: selectedWorkAudio.name,
    csvPath:   selectedWorkCsv?.path || null,
    csvName:   selectedWorkCsv?.name || null,
  }];
  currentTrackIndex = 0;

  if (isPlaying) stopPlayback();
  await loadTrackAt(0);
  updateTrackUI();
}

// ===== Playlist Management =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function createPlaylist() {
  const nameInput = document.getElementById('newPlaylistName');
  const name = nameInput.value.trim() || `プレイリスト${playlists.length + 1}`;

  const playlist = { id: generateId(), name, items: [] };
  playlists.push(playlist);
  activePlaylistId = playlist.id;
  nameInput.value  = '';

  renderPlaylistSelector();
  renderPlaylistItems();
  updateWorkLinkUI();
  showToast(`プレイリスト「${name}」を作成しました`);
}

function deleteActivePlaylist() {
  if (!activePlaylistId) return;
  const idx = playlists.findIndex(p => p.id === activePlaylistId);
  if (idx < 0) return;
  const name = playlists[idx].name;
  playlists.splice(idx, 1);
  activePlaylistId = playlists.length > 0 ? playlists[playlists.length - 1].id : null;

  renderPlaylistSelector();
  renderPlaylistItems();
  updateWorkLinkUI();
  showToast(`プレイリスト「${name}」を削除しました`);
}

function switchPlaylist(id) {
  activePlaylistId = id || null;
  document.getElementById('savePlaylistBtn').disabled   = !activePlaylistId;
  document.getElementById('deletePlaylistBtn').disabled = !activePlaylistId;
  renderPlaylistItems();
  updateWorkLinkUI();
}

function getActivePlaylist() {
  return playlists.find(p => p.id === activePlaylistId) || null;
}

function addLinkToPlaylist() {
  if (!selectedWorkAudio || !activePlaylistId) return;
  const playlist = getActivePlaylist();
  if (!playlist) return;

  playlist.items.push({
    id:        generateId(),
    audioName: selectedWorkAudio.name,
    audioPath: selectedWorkAudio.path,
    csvName:   selectedWorkCsv?.name || null,
    csvPath:   selectedWorkCsv?.path || null,
  });

  renderPlaylistSelector();
  renderPlaylistItems();
  showToast(`「${selectedWorkAudio.name}」をプレイリストに追加しました`);
}

function removeFromPlaylist(itemId) {
  const playlist = getActivePlaylist();
  if (!playlist) return;
  const idx = playlist.items.findIndex(i => i.id === itemId);
  if (idx >= 0) playlist.items.splice(idx, 1);
  renderPlaylistSelector();
  renderPlaylistItems();
}

function renderPlaylistSelector() {
  const sel = document.getElementById('playlistSelector');
  sel.innerHTML = '<option value="">-- プレイリストを選択 --</option>';
  playlists.forEach(p => {
    const opt = document.createElement('option');
    opt.value       = p.id;
    opt.textContent = `${p.name}（${p.items.length}曲）`;
    if (p.id === activePlaylistId) opt.selected = true;
    sel.appendChild(opt);
  });
  document.getElementById('savePlaylistBtn').disabled   = !activePlaylistId;
  document.getElementById('deletePlaylistBtn').disabled = !activePlaylistId;
}

function renderPlaylistItems() {
  const area      = document.getElementById('playlistItemsArea');
  const container = document.getElementById('playlistItems');
  const playlist  = getActivePlaylist();

  if (!playlist) {
    area.style.display = 'none';
    return;
  }

  area.style.display = '';
  container.innerHTML = '';

  if (playlist.items.length === 0) {
    container.innerHTML =
      '<div style="font-size:0.82rem;color:#555;padding:8px 0;">アイテムがありません。作品管理パネルから追加してください。</div>';
    return;
  }

  playlist.items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'playlist-item';

    const num   = document.createElement('span');
    num.className   = 'playlist-item-num';
    num.textContent = `${idx + 1}.`;

    const audio = document.createElement('span');
    audio.className   = 'playlist-item-audio';
    audio.textContent = item.audioName;
    audio.title       = item.audioPath;

    const arrow = document.createElement('span');
    arrow.className   = 'playlist-item-arrow';
    arrow.textContent = '→';

    const csv = document.createElement('span');
    csv.className   = 'playlist-item-csv' + (item.csvPath ? '' : ' no-csv');
    csv.textContent = item.csvName || 'CSVなし';
    if (item.csvPath) csv.title = item.csvPath;

    const del = document.createElement('button');
    del.className   = 'playlist-item-del';
    del.textContent = '✕';
    del.title       = '削除';
    del.addEventListener('click', () => removeFromPlaylist(item.id));

    row.append(num, audio, arrow, csv, del);
    container.appendChild(row);
  });
}

async function playPlaylist() {
  const playlist = getActivePlaylist();
  if (!playlist || playlist.items.length === 0) {
    showToast('プレイリストにアイテムがありません', true);
    return;
  }

  if (isPlaying) stopPlayback();

  pathTracks = playlist.items.map(item => ({
    audioPath: item.audioPath,
    audioName: item.audioName,
    csvPath:   item.csvPath,
    csvName:   item.csvName,
  }));
  currentTrackIndex = 0;

  await loadTrackAt(0);
  updateTrackUI();

  audioEl.addEventListener('canplay', function() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    audioEl.play().then(() => {
      startCommandTimer();
      isPlaying = true;
      document.getElementById('playBtn').classList.add('playing');
      document.getElementById('playBtn').textContent = '⏸';
    }).catch(() => {});
  }, { once: true });
}

async function savePlaylistToFile() {
  if (!window.electronAPI) {
    showToast('この機能はデスクトップ版でのみ利用できます', true);
    return;
  }
  const playlist = getActivePlaylist();
  if (!playlist) return;

  const filePath = await window.electronAPI.showSaveDialog(`${playlist.name}.json`);
  if (!filePath) return;

  await window.electronAPI.writeTextFile(filePath, JSON.stringify({ version: 1, playlist }, null, 2));
  showToast(`保存しました: ${filePath.split(/[\\/]/).pop()}`);
}

async function loadPlaylistFromFile() {
  if (!window.electronAPI) {
    showToast('この機能はデスクトップ版でのみ利用できます', true);
    return;
  }

  const filePath = await window.electronAPI.showOpenJsonDialog();
  if (!filePath) return;

  try {
    const text = await window.electronAPI.readTextFile(filePath);
    const data = JSON.parse(text);

    if (!data.playlist || !Array.isArray(data.playlist.items)) {
      throw new Error('プレイリスト形式が不正です');
    }

    const loaded = data.playlist;
    const existing = playlists.find(p => p.name === loaded.name);
    if (existing) {
      existing.items   = loaded.items;
      activePlaylistId = existing.id;
      showToast(`プレイリスト「${existing.name}」を更新しました`);
    } else {
      const newPl = { id: generateId(), name: loaded.name, items: loaded.items };
      playlists.push(newPl);
      activePlaylistId = newPl.id;
      showToast(`プレイリスト「${newPl.name}」を読み込みました`);
    }

    renderPlaylistSelector();
    renderPlaylistItems();
    updateWorkLinkUI();
  } catch (err) {
    showToast(`読み込み失敗: ${err.message}`, true);
  }
}
