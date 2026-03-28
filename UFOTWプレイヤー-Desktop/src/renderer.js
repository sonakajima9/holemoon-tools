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

let audioEl = null;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let waveformRAF = null;

let csvRows = []; // [{time(sec), direction, speed}] or [{time, leftDir, leftSpeed, rightDir, rightSpeed}]
let csvFormat = 3;

let commandTimer = null;
let sendCount = 0;
let isPlaying = false;

let audioQueue = [];
let csvQueue = [];
let currentTrackIndex = 0;

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

async function scanBtServices() {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth API 非対応の環境です', true);
    return;
  }
  const scanBtn = document.getElementById('btScanServicesBtn');
  scanBtn.disabled = true;
  showToast('デバイスを検索中...');
  try {
    const inputServiceUUID = document.getElementById('btServiceUUID').value.trim();
    const KNOWN_SERVICE_UUIDS = [
      '0000fff0-0000-1000-8000-00805f9b34fb',
      '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
      '49535343-fe7d-4ae5-8fa9-9fafd205e455',
      '0000ffe0-0000-1000-8000-00805f9b34fb',
      '0000ff00-0000-1000-8000-00805f9b34fb',
      '0000ab00-0000-1000-8000-00805f9b34fb',
    ];
    const optionalServices = inputServiceUUID
      ? [inputServiceUUID, ...KNOWN_SERVICE_UUIDS.filter(u => u !== inputServiceUUID)]
      : KNOWN_SERVICE_UUIDS;

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices
    });
    showToast('GATT 接続中...');
    const server = await connectGattWithTimeout(device.gatt);

    isUserDisconnected = false;
    reconnectAttempts = 0;

    // サービス・キャラクタリスティックの取得を試みる
    const candidates = [];

    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (_) {
      for (const uuid of optionalServices) {
        try {
          const svc = await server.getPrimaryService(uuid);
          services.push(svc);
        } catch (_) {}
      }
    }

    for (const service of services) {
      let chars;
      try {
        chars = await service.getCharacteristics();
      } catch (_) {
        continue;
      }
      for (const char of chars) {
        const props = char.properties;
        if (props.write || props.writeWithoutResponse) {
          const propLabels = [];
          if (props.write)                propLabels.push('write');
          if (props.writeWithoutResponse) propLabels.push('writeWithoutResponse');
          if (props.notify)               propLabels.push('notify');
          if (props.read)                 propLabels.push('read');
          candidates.push({
            serviceUUID: service.uuid,
            charUUID: char.uuid,
            propLabels,
            characteristic: char
          });
        }
      }
    }

    if (candidates.length === 0) {
      server.disconnect();
      showToast('書き込み可能なキャラクタリスティックが見つかりませんでした。サービスUUIDが既知の場合は入力欄に入力してから再度お試しください。', true);
    } else {
      bluetoothDevice = device;
      bluetoothDevice.removeEventListener('gattserverdisconnected', onBtDisconnected);
      bluetoothDevice.addEventListener('gattserverdisconnected', onBtDisconnected);

      if (candidates.length === 1) {
        finishScanConnect(candidates[0]);
      } else {
        openUuidModal(candidates);
      }
    }
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      showToast(`スキャン失敗: ${err.name}: ${err.message}`, true);
    }
  } finally {
    scanBtn.disabled = false;
  }
}

function finishScanConnect(candidate) {
  document.getElementById('btServiceUUID').value = candidate.serviceUUID;
  document.getElementById('btCharUUID').value    = candidate.charUUID;
  gattCharacteristic = candidate.characteristic;
  isConnected = true;
  setBtStatus('connected', `接続済み: ${bluetoothDevice.name || '(名前なし)'}`);
  document.getElementById('btConnectBtn').disabled = true;
  document.getElementById('btDisconnectBtn').disabled = false;
  showToast('UUID を自動入力して接続しました');
}

function openUuidModal(candidates) {
  const list = document.getElementById('uuidCandidateList');
  list.innerHTML = '';
  candidates.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'uuid-candidate';
    div.innerHTML = `
      <div class="cand-title">候補 ${i + 1}</div>
      <div class="cand-uuid">サービス: ${c.serviceUUID}</div>
      <div class="cand-uuid">キャラクタリスティック: ${c.charUUID}</div>
      <div class="cand-props">プロパティ: ${c.propLabels.join(', ')}</div>`;
    div.addEventListener('click', () => {
      closeUuidModal();
      finishScanConnect(c);
    });
    list.appendChild(div);
  });
  document.getElementById('uuidModal').classList.add('show');
}

function closeUuidModal() {
  document.getElementById('uuidModal').classList.remove('show');
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth API 非対応の環境です', true);
    return;
  }
  const nameFilter = document.getElementById('btNameFilter').value.trim();
  const serviceUUID = document.getElementById('btServiceUUID').value.trim();
  const charUUID    = document.getElementById('btCharUUID').value.trim();

  setBtStatus('connecting', '接続中...');
  document.getElementById('btConnectBtn').disabled = true;
  try {
    const filters = nameFilter
      ? [{ namePrefix: nameFilter }]
      : [{ services: [serviceUUID] }];

    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [serviceUUID]
    });

    bluetoothDevice.removeEventListener('gattserverdisconnected', onBtDisconnected);
    bluetoothDevice.addEventListener('gattserverdisconnected', onBtDisconnected);

    const server  = await connectGattWithTimeout(bluetoothDevice.gatt);
    const service = await server.getPrimaryService(serviceUUID);
    gattCharacteristic = await service.getCharacteristic(charUUID);

    isConnected = true;
    isUserDisconnected = false;
    reconnectAttempts = 0;
    setBtStatus('connected', `接続済み: ${bluetoothDevice.name || '(名前なし)'}`);
    document.getElementById('btConnectBtn').disabled = true;
    document.getElementById('btDisconnectBtn').disabled = false;
    showToast('Bluetooth 接続しました');
  } catch (err) {
    document.getElementById('btConnectBtn').disabled = false;
    bluetoothDevice = null;
    let detail = '';
    if (err.name === 'NotFoundError') {
      detail = 'サービスUUIDまたはキャラクタリスティックUUIDがデバイスと一致していません';
    } else if (err.name === 'NetworkError') {
      detail = 'デバイスとの通信に失敗しました。デバイスが近くにあるか確認してください';
    } else {
      detail = `${err.name}: ${err.message}`;
    }
    setBtStatus('error', `接続失敗: ${detail}`);
    showToast(`接続失敗: ${detail}`, true);
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
  const serviceUUID = document.getElementById('btServiceUUID').value.trim();
  const charUUID    = document.getElementById('btCharUUID').value.trim();
  try {
    const server  = await connectGattWithTimeout(bluetoothDevice.gatt);
    const service = await server.getPrimaryService(serviceUUID);
    gattCharacteristic = await service.getCharacteristic(charUUID);
    isConnected = true;
    reconnectAttempts = 0;
    setBtStatus('connected', `接続済み: ${bluetoothDevice.name || '(名前なし)'}`);
    document.getElementById('btConnectBtn').disabled = true;
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
  try {
    if (csvFormat === 5) {
      await sendRawCommand(0, 50, 0, 50);
    } else {
      await sendRawCommand(0, 50);
    }
    showToast('テスト送信しました（速度50）');
    setTimeout(() => {
      if (csvFormat === 5) sendRawCommand(0, 0, 0, 0);
      else sendRawCommand(0, 0);
    }, 1000);
  } catch (err) {
    showToast(`送信失敗: ${err.message}`, true);
  }
}

// ===== Command Building =====
function buildCommandBytes(dir, speed, rightDir, rightSpeed) {
  const fmt = document.getElementById('cmdFormat').value;
  speed = Math.round(Math.min(100, Math.max(0, speed)));
  const speedByte = Math.round(speed * 2.55); // 0-100 → 0-255

  switch (fmt) {
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

  let lo = 0;
  for (let i = 0; i < csvRows.length - 1; i++) {
    if (csvRows[i].time <= t && csvRows[i + 1].time > t) { lo = i; break; }
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
  const reader = new FileReader();
  reader.onload = async e => {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(e.target.result.slice(0));
    drawWaveform(decoded);
  };
  reader.readAsArrayBuffer(file);

  showToast(`音声: ${file.name}`);
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

function onAudioEnded() {
  if (currentTrackIndex < audioQueue.length - 1) {
    stopCommandTimer();
    isPlaying = false;
    document.getElementById('playBtn').classList.remove('playing');
    document.getElementById('playBtn').textContent = '▶';
    loadTrackAt(currentTrackIndex + 1);
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

function loadTrackAt(index) {
  currentTrackIndex = index;
  applyAudioTrack(audioQueue[index]);
  if (csvQueue.length > 0) {
    applyCSVTrack(csvQueue[Math.min(index, csvQueue.length - 1)]);
  }
  updateTrackUI();
}

function updateTrackUI() {
  const total = audioQueue.length;
  document.getElementById('trackCounter').textContent =
    total > 1 ? `トラック ${currentTrackIndex + 1} / ${total}` : '';
  document.getElementById('prevTrackBtn').disabled = currentTrackIndex <= 0;
  document.getElementById('nextTrackBtn').disabled = total === 0 || currentTrackIndex >= total - 1;
}

function prevTrack() {
  if (currentTrackIndex <= 0) return;
  const wasPlaying = isPlaying;
  stopPlayback();
  loadTrackAt(currentTrackIndex - 1);
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

function nextTrack() {
  if (currentTrackIndex >= audioQueue.length - 1) return;
  const wasPlaying = isPlaying;
  stopPlayback();
  loadTrackAt(currentTrackIndex + 1);
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
  const step = Math.ceil(data.length / W);
  const half = H / 2;

  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
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
