// --- REGISTRASI SERVICE WORKER & INSTALL PROMPT (PWA) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

let deferredPrompt;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.add('hidden');
});

// --- KONFIGURASI STASIUN & SIMULASI ---
const canvas = document.getElementById('trackCanvas');
const ctx = canvas.getContext('2d');

const TRAIN_TEMPLATES = [
  { code: 'KA 1 Argo Bromo', type: 'express', action: 'pass', speed: 1.55, color: '#ef4444', dwell: 0 },
  { code: 'KA 142 Majapahit', type: 'passenger', action: 'stop', speed: 1.15, color: '#3b82f6', dwell: 7 },
  { code: 'KA 412 Commuter', type: 'passenger', action: 'stop', speed: 1.05, color: '#10b981', dwell: 6 },
  { code: 'KA 2514 Petikemas', type: 'freight', action: 'pass', speed: 0.85, color: '#f59e0b', dwell: 0 },
  { code: 'KA 75 Bima', type: 'express', action: 'stop', speed: 1.45, color: '#ec4899', dwell: 5 }
];

let state = {};

function initState() {
  const level = parseInt(document.getElementById('levelSelect').value, 10);
  state = {
    running: true,
    level,
    simSeconds: 6 * 3600,
    score: 100,
    completed: 0,
    weather: level === 2 ? 'Hujan Deras' : 'Cerah',
    spawnTimer: 2,
    nextTrainId: 1,
    // Wesel: false = Lurus (Sepur 2), true = Belok (Sepur 1 atau Sepur 3)
    switches: {
      W1: { name: 'Wesel Barat 1', state: false, jammed: 0, descLurus: 'Ke Sepur 2', descBelok: 'Ke Sepur 1' },
      W2: { name: 'Wesel Barat 2', state: false, jammed: 0, descLurus: 'Lurus Utama', descBelok: 'Ke Sepur 3' },
      W3: { name: 'Wesel Timur 1', state: false, jammed: 0, descLurus: 'Dari Sepur 2', descBelok: 'Dari Sepur 1' },
      W4: { name: 'Wesel Timur 2', state: false, jammed: 0, descLurus: 'Keluar Timur', descBelok: 'Dari Sepur 3' }
    },
    // Sinyal: 'red' | 'yellow' | 'green'
    signals: {
      S_IN_W: { name: 'Sinyal Masuk Barat', aspect: 'red', dir: 'E' },
      S_OUT_1: { name: 'Sinyal Keluar Sepur 1', aspect: 'red', dir: 'E' },
      S_OUT_2: { name: 'Sinyal Keluar Sepur 2', aspect: 'red', dir: 'E' },
      S_OUT_3: { name: 'Sinyal Keluar Sepur 3', aspect: 'red', dir: 'E' },
      S_IN_E: { name: 'Sinyal Masuk Timur', aspect: 'red', dir: 'W' }
    },
    trains: []
  };

  document.getElementById('weather').textContent = state.weather;
  document.getElementById('modalOverlay').classList.add('hidden');
  hideAlert();
  spawnTrain('E');
  renderControls();
}

// --- LOGIKA RUTE & INTERLOCKING ---
function getWestEntryTrack() {
  if (state.switches.W1.state) return 1; // Sepur 1 (Atas)
  if (state.switches.W2.state) return 3; // Sepur 3 (Bawah)
  return 2; // Sepur 2 (Tengah / Sepur Lurus)
}

function canExitEast(track) {
  if (track === 1) return state.switches.W3.state === true && state.switches.W4.state === false;
  if (track === 2) return state.switches.W3.state === false && state.switches.W4.state === false;
  if (track === 3) return state.switches.W4.state === true;
  return false;
}

function canEnterFromEast(track) {
  // Masuk dari Timur menuju Sepur 3 (jalur khusus arah Barat) atau Sepur 2
  if (track === 3) return state.switches.W4.state === true;
  if (track === 2) return state.switches.W4.state === false && state.switches.W3.state === false;
  return false;
}

function isTrackOccupied(track, excludeTrainId = null) {
  return state.trains.some(t => t.id !== excludeTrainId && t.track === track && t.x > 0.24 && t.x < 0.76);
}

function toggleSwitch(key) {
  const sw = state.switches[key];
  if (sw.jammed > 0) {
    showAlert(`${sw.name} sedang macet! Tunggu teknisi (${Math.ceil(sw.jammed)}d).`);
    return;
  }
  // Cegah ubah wesel jika ada kereta tepat di atas area wesel
  const nearWest = state.trains.some(t => t.x >= 0.18 && t.x <= 0.30);
  const nearEast = state.trains.some(t => t.x >= 0.70 && t.x <= 0.82);
  if ((key === 'W1' || key === 'W2') && nearWest) {
    showAlert('INTERLOCKING: Wesel Barat terkunci karena sedang dilalui rangkaian!');
    return;
  }
  if ((key === 'W3' || key === 'W4') && nearEast) {
    showAlert('INTERLOCKING: Wesel Timur terkunci karena sedang dilalui rangkaian!');
    return;
  }

  sw.state = !sw.state;
  // Reset sinyal terkait ke merah demi keselamatan interlocking
  state.signals.S_IN_W.aspect = 'red';
  state.signals.S_IN_E.aspect = 'red';
  state.signals.S_OUT_1.aspect = 'red';
  state.signals.S_OUT_2.aspect = 'red';
  state.signals.S_OUT_3.aspect = 'red';
  renderControls();
}

function cycleSignal(key) {
  const sig = state.signals[key];
  const order = ['red', 'yellow', 'green'];
  const next = order[(order.indexOf(sig.aspect) + 1) % order.length];

  // Validasi Interlocking sebelum mengizinkan sinyal Hijau/Kuning
  if (next !== 'red') {
    if (key === 'S_IN_W') {
      const targetTrack = getWestEntryTrack();
      if (isTrackOccupied(targetTrack)) {
        showAlert(`BLOK TERISI: Sepur ${targetTrack} masih diduduki kereta!`);
        return;
      }
    }
    if (key === 'S_OUT_1' && !canExitEast(1)) {
      showAlert('RUTE SALAH: Atur Wesel Timur 1 (Belok) & Timur 2 (Lurus) untuk keluar Sepur 1.');
      return;
    }
    if (key === 'S_OUT_2' && !canExitEast(2)) {
      showAlert('RUTE SALAH: Atur Wesel Timur 1 & 2 ke posisi Lurus untuk keluar Sepur 2.');
      return;
    }
    if (key === 'S_OUT_3' && !canExitEast(3)) {
      showAlert('RUTE SALAH: Atur Wesel Timur 2 ke posisi Belok untuk keluar Sepur 3.');
      return;
    }
    if (key === 'S_IN_E') {
      const targetE = state.switches.W4.state ? 3 : 2;
      if (!canEnterFromEast(targetE) || isTrackOccupied(targetE)) {
        showAlert(`RUTE TIMUR TIDAK AMAN: Periksa Wesel Timur atau Sepur ${targetE} terisi.`);
        return;
      }
    }
  }

  sig.aspect = next;
  renderControls();
}

// --- SPAWN & UPDATE KERETA ---
function spawnTrain(forcedDir = null) {
  const tpl = TRAIN_TEMPLATES[Math.floor(Math.random() * TRAIN_TEMPLATES.length)];
  const dir = forcedDir || (Math.random() < 0.72 ? 'E' : 'W'); // Mayoritas Barat -> Timur, sebagian Timur -> Barat
  const id = state.nextTrainId++;
  const weatherFactor = state.level === 2 ? 0.85 : 1.0;

  state.trains.push({
    id,
    code: `${tpl.code} #${id}`,
    type: tpl.type,
    action: tpl.action,
    dir,
    x: dir === 'E' ? 0.02 : 0.98,
    track: 2, // Default jalur utama sebelum masuk wesel
    baseSpeed: tpl.speed * 0.032 * weatherFactor,
    currentSpeed: 0,
    dwellRemaining: tpl.dwell,
    served: tpl.action === 'pass',
    statusText: tpl.action === 'stop' ? 'Wajib Berhenti Peron' : 'Langsung Melintas',
    delay: 0
  });
}

function update(dt) {
  if (!state.running) return;

  state.simSeconds += dt * 12; // 1 detik nyata = 12 detik simulasi
  state.spawnTimer -= dt;
  const spawnInterval = state.level === 2 ? 13 : 17;
  if (state.spawnTimer <= 0 && state.trains.length < 5) {
    spawnTrain();
    state.spawnTimer = spawnInterval;
  }

  // Gangguan acak wesel macet ringan pada Shift 2
  if (state.level === 2 && Math.random() < 0.0008) {
    const keys = Object.keys(state.switches);
    const pick = state.switches[keys[Math.floor(Math.random() * keys.length)]];
    if (pick.jammed <= 0) {
      pick.jammed = 8;
      showAlert(`GANGGUAN: ${pick.name} macet sementara! Perbaikan 8 detik.`);
    }
  }

  Object.values(state.switches).forEach(sw => {
    if (sw.jammed > 0) sw.jammed = Math.max(0, sw.jammed - dt);
  });

  // Update pergerakan setiap rangkaian kereta
  for (let i = state.trains.length - 1; i >= 0; i--) {
    const t = state.trains[i];
    let targetSpeed = t.baseSpeed;

    if (t.dir === 'E') {
      // Mendekati Sinyal Masuk Barat (x = 0.17)
      if (t.x < 0.17 && t.x > 0.12 && state.signals.S_IN_W.aspect === 'red') {
        targetSpeed = 0;
        t.statusText = 'Tertahan Sinyal Masuk Barat';
        t.delay += dt;
      } else if (t.x < 0.17 && state.signals.S_IN_W.aspect === 'yellow') {
        targetSpeed *= 0.6;
      }

      // Melewati Wesel Barat (x = 0.22)
      if (t.x >= 0.17 && t.x < 0.23) {
        if (state.signals.S_IN_W.aspect === 'red' && t.currentSpeed > 0.005) {
          triggerGameOver(`${t.code} menerobos Sinyal Masuk Barat yang beraspek MERAH!`);
          return;
        }
        t.track = getWestEntryTrack();
        // Otomatis kembalikan sinyal masuk ke merah setelah kereta lewat (blok otomatis)
        if (t.x > 0.21) state.signals.S_IN_W.aspect = 'red';
      }

      // Berhenti di Peron Stasiun (x = 0.50)
      if (t.action === 'stop' && !t.served && Math.abs(t.x - 0.50) < 0.015) {
        targetSpeed = 0;
        t.dwellRemaining -= dt;
        t.statusText = `Naik/Turun Penumpang (${Math.ceil(t.dwellRemaining)}d)`;
        if (t.dwellRemaining <= 0) {
          t.served = true;
          t.statusText = 'Siap Berangkat (Tunggu Sinyal Keluar)';
        }
      }

      // Mendekati Sinyal Keluar Timur (x = 0.66)
      const outSig = state.signals[`S_OUT_${t.track}`];
      if (t.x >= 0.58 && t.x < 0.67 && outSig && outSig.aspect === 'red') {
        targetSpeed = 0;
        t.statusText = `Menunggu Sinyal Keluar Sepur ${t.track}`;
        t.delay += dt;
      }

      // Cek rute wesel timur saat keluar (x = 0.74)
      if (t.x >= 0.72 && t.x <= 0.76) {
        if (!canExitEast(t.track)) {
          triggerGameOver(`${t.code} anjlok/salah rute karena Wesel Timur belum mengarah ke Sepur ${t.track}!`);
          return;
        }
        if (outSig) outSig.aspect = 'red';
      }

      t.currentSpeed += (targetSpeed - t.currentSpeed) * 0.15;
      t.x += t.currentSpeed * dt;

      if (t.x > 1.03) {
        finishTrain(i, t);
      }
    } else {
      // Arah Timur ke Barat (W)
      if (t.x > 0.83 && t.x < 0.88 && state.signals.S_IN_E.aspect === 'red') {
        targetSpeed = 0;
        t.statusText = 'Tertahan Sinyal Masuk Timur';
        t.delay += dt;
      }
      if (t.x <= 0.83 && t.x > 0.77) {
        t.track = state.switches.W4.state ? 3 : 2;
        if (t.x < 0.79) state.signals.S_IN_E.aspect = 'red';
      }
      if (t.action === 'stop' && !t.served && Math.abs(t.x - 0.50) < 0.015) {
        targetSpeed = 0;
        t.dwellRemaining -= dt;
        t.statusText = `Naik/Turun Penumpang (${Math.ceil(t.dwellRemaining)}d)`;
        if (t.dwellRemaining <= 0) {
          t.served = true;
          t.statusText = 'Melanjutkan ke Barat';
        }
      }
      // Pastikan wesel barat mengarah ke jalur kereta saat keluar ke barat (x = 0.24)
      if (t.x <= 0.26 && t.x >= 0.22) {
        const validWestExit = (t.track === 1 && state.switches.W1.state) ||
                              (t.track === 2 && !state.switches.W1.state && !state.switches.W2.state) ||
                              (t.track === 3 && !state.switches.W1.state && state.switches.W2.state);
        if (!validWestExit) {
          triggerGameOver(`${t.code} salah wesel saat keluar ke petak Barat dari Sepur ${t.track}!`);
          return;
        }
      }

      t.currentSpeed += (targetSpeed - t.currentSpeed) * 0.15;
      t.x -= t.currentSpeed * dt;

      if (t.x < -0.03) {
        finishTrain(i, t);
      }
    }
  }

  // Deteksi Tabrakan Antar Kereta di jalur yang sama
  for (let i = 0; i < state.trains.length; i++) {
    for (let j = i + 1; j < state.trains.length; j++) {
      const a = state.trains[i];
      const b = state.trains[j];
      const sameZone = (a.x < 0.20 && b.x < 0.20) || (a.x > 0.80 && b.x > 0.80) || (a.track === b.track);
      if (sameZone && Math.abs(a.x - b.x) < 0.065) {
        triggerGameOver(`TABRAKAN antara ${a.code} dan ${b.code} di Sepur ${a.track}!`);
        return;
      }
    }
  }
}

function finishTrain(index, train) {
  state.trains.splice(index, 1);
  state.completed += 1;
  const penalty = Math.floor(train.delay / 5);
  state.score = Math.max(0, state.score + 15 - penalty);
  renderControls();
}

function triggerGameOver(reason) {
  state.running = false;
  document.getElementById('modalTitle').textContent = 'Insiden Keselamatan KA!';
  document.getElementById('modalDesc').textContent = reason;
  document.getElementById('finalScore').textContent = state.score;
  document.getElementById('finalTrains').textContent = state.completed;
  document.getElementById('modalOverlay').classList.remove('hidden');
}

// --- RENDERING CANVAS DIAGRAM STASIUN ---
function draw() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const yTracks = {
    1: h * 0.28, // Sepur 1 (Atas)
    2: h * 0.50, // Sepur 2 (Utama Tengah)
    3: h * 0.72  // Sepur 3 (Bawah)
  };

  // Gambar Peron Stasiun
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(w * 0.34, yTracks[1] - 28, w * 0.32, 16);
  ctx.fillRect(w * 0.34, yTracks[2] + 14, w * 0.32, 22);
  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.fillText('PERON 1 (SEPUR 1)', w * 0.44, yTracks[1] - 16);
  ctx.fillText('PERON UTAMA (SEPUR 2 & 3)', w * 0.42, yTracks[2] + 29);

  // Gambar Rel Dasar
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#334155';

  // Petak Barat & Timur Utama
  drawLine(0, yTracks[2], w * 0.22, yTracks[2]);
  drawLine(w * 0.78, yTracks[2], w, yTracks[2]);

  // Sepur 1, 2, 3 di dalam emplasemen stasiun
  drawLine(w * 0.28, yTracks[1], w * 0.72, yTracks[1]);
  drawLine(w * 0.22, yTracks[2], w * 0.78, yTracks[2]);
  drawLine(w * 0.28, yTracks[3], w * 0.72, yTracks[3]);

  // Percabangan Wesel Barat & Timur
  drawLine(w * 0.21, yTracks[2], w * 0.28, yTracks[1]); // W1
  drawLine(w * 0.24, yTracks[2], w * 0.28, yTracks[3]); // W2
  drawLine(w * 0.72, yTracks[1], w * 0.79, yTracks[2]); // W3
  drawLine(w * 0.72, yTracks[3], w * 0.76, yTracks[2]); // W4

  // Sorot Rute Aktif sesuai posisi Wesel
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3;
  if (state.switches.W1.state) {
    drawLine(w * 0.21, yTracks[2], w * 0.28, yTracks[1]);
  } else if (state.switches.W2.state) {
    drawLine(w * 0.24, yTracks[2], w * 0.28, yTracks[3]);
  } else {
    drawLine(w * 0.20, yTracks[2], w * 0.29, yTracks[2]);
  }

  if (state.switches.W4.state) {
    drawLine(w * 0.72, yTracks[3], w * 0.76, yTracks[2]);
  } else if (state.switches.W3.state) {
    drawLine(w * 0.72, yTracks[1], w * 0.79, yTracks[2]);
  } else {
    drawLine(w * 0.71, yTracks[2], w * 0.80, yTracks[2]);
  }

  // Label Sepur
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('SEPUR 1', w * 0.30, yTracks[1] - 8);
  ctx.fillText('SEPUR 2 (UTAMA)', w * 0.30, yTracks[2] - 8);
  ctx.fillText('SEPUR 3', w * 0.30, yTracks[3] - 8);

  // Gambar Lampu Sinyal
  drawSignal(w * 0.17, yTracks[2] - 18, state.signals.S_IN_W.aspect, 'IN-B');
  drawSignal(w * 0.67, yTracks[1] - 18, state.signals.S_OUT_1.aspect, 'OUT-1');
  drawSignal(w * 0.67, yTracks[2] - 18, state.signals.S_OUT_2.aspect, 'OUT-2');
  drawSignal(w * 0.67, yTracks[3] - 18, state.signals.S_OUT_3.aspect, 'OUT-3');
  drawSignal(w * 0.83, yTracks[2] + 22, state.signals.S_IN_E.aspect, 'IN-T');

  // Gambar Rangkaian Kereta Api
  state.trains.forEach(t => {
    let ty = yTracks[2];
    if (t.x >= 0.24 && t.x <= 0.76) {
      ty = yTracks[t.track];
    }
    const tx = t.x * w;
    const len = t.type === 'freight' ? 68 : 52;

    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.roundRect(tx - len / 2, ty - 9, len, 18, 4);
    ctx.fill();

    // Arah panah kepala kereta
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(t.dir === 'E' ? '▶' : '◀', tx - 4, ty + 3);

    // Label Nomor KA di atas rangkaian
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(t.code.split(' ')[0] + ' ' + t.code.split(' ')[1], tx - 22, ty - 14);
  });

  // Efek Hujan jika Shift 2
  if (state.level === 2) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 45; i++) {
      const rx = (Math.random() * w);
      const ry = (Math.random() * h);
      drawLine(rx, ry, rx - 6, ry + 14);
    }
  }
}

function drawLine(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawSignal(x, y, aspect, label) {
  const colors = { red: '#ef4444', yellow: '#f59e0b', green: '#10b981' };
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = colors[aspect];
  ctx.beginPath();
  ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '9px sans-serif';
  ctx.fillText(label, x - 12, y - 11);
}

// --- RENDER PANEL UI & JADWAL ---
function renderControls() {
  const swContainer = document.getElementById('switchControls');
  swContainer.innerHTML = '';
  Object.entries(state.switches).forEach(([key, sw]) => {
    const btn = document.createElement('button');
    btn.className = `ctrl-btn ${sw.state ? 'active-branch' : ''}`;
    btn.innerHTML = `<strong>${sw.name}</strong>
      <span class="ctrl-sub">${sw.state ? 'BELOK: ' + sw.descBelok : 'LURUS: ' + sw.descLurus}</span>`;
    btn.onclick = () => toggleSwitch(key);
    swContainer.appendChild(btn);
  });

  const sigContainer = document.getElementById('signalControls');
  sigContainer.innerHTML = '';
  const aspectLabel = { red: 'MERAH (Berhenti)', yellow: 'KUNING (Hati-hati)', green: 'HIJAU (Aman)' };
  Object.entries(state.signals).forEach(([key, sig]) => {
    const btn = document.createElement('button');
    btn.className = `ctrl-btn sig-${sig.aspect}`;
    btn.innerHTML = `<strong>${sig.name}</strong>
      <span class="ctrl-sub">${aspectLabel[sig.aspect]}</span>`;
    btn.onclick = () => cycleSignal(key);
    sigContainer.appendChild(btn);
  });
}

function updateHUD() {
  const hrs = String(Math.floor(state.simSeconds / 3600) % 24).padStart(2, '0');
  const mins = String(Math.floor((state.simSeconds % 3600) / 60)).padStart(2, '0');
  const secs = String(Math.floor(state.simSeconds % 60)).padStart(2, '0');
  document.getElementById('clock').textContent = `${hrs}:${mins}:${secs}`;
  document.getElementById('score').textContent = state.score;
  document.getElementById('completed').textContent = state.completed;

  const list = document.getElementById('scheduleList');
  list.innerHTML = state.trains.map(t => `
    <div class="train-card ${t.type}">
      <div class="train-card-top">
        <span>${t.code} (${t.dir === 'E' ? 'Ke Timur' : 'Ke Barat'})</span>
        <span>Sepur ${t.track}</span>
      </div>
      <div class="train-card-meta">${t.statusText}</div>
    </div>
  `).join('') || '<div class="train-card-meta">Menunggu jadwal KA berikutnya...</div>';
}

let alertTimeout;
function showAlert(msg) {
  const banner = document.getElementById('alertBanner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  clearTimeout(alertTimeout);
  alertTimeout = setTimeout(hideAlert, 4000);
}

function hideAlert() {
  document.getElementById('alertBanner').classList.add('hidden');
}

// --- LOOP UTAMA ---
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  updateHUD();
  requestAnimationFrame(loop);
}

document.getElementById('resetBtn').onclick = initState;
document.getElementById('modalRestartBtn').onclick = initState;
document.getElementById('levelSelect').onchange = initState;

initState();
requestAnimationFrame(loop);
    
