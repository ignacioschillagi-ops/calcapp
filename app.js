/* =========================================================
   Calcapp — calcá imágenes con la cámara del celular
   by @YoSoyJoe · https://yosoyjoe.vercel.app
   ========================================================= */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------- Preferencias (localStorage, tolerante a fallos) ---------- */
  const prefs = {
    get(k, d) {
      try { const v = localStorage.getItem('calcapp:' + k); return v === null ? d : JSON.parse(v); }
      catch { return d; }
    },
    set(k, v) { try { localStorage.setItem('calcapp:' + k, JSON.stringify(v)); } catch { /* sin storage */ } },
  };

  /* ---------- IndexedDB para guardar la última imagen ---------- */
  const idb = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('calcapp', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this._db = r.result; res(r.result); };
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) {
      try {
        const db = await this.open();
        return await new Promise((res, rej) => {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
      } catch { return undefined; }
    },
    async set(k, v) {
      try {
        const db = await this.open();
        await new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } catch { /* sin storage */ }
    },
  };

  /* ---------- Estado ---------- */
  const S = {
    src: null,          // canvas con la imagen original (reducida)
    sketch: null,       // canvas con el boceto (cache)
    sketchKey: '',
    mode: prefs.get('mode', 'photo'),          // 'photo' | 'sketch'
    opacity: prefs.get('opacity', 50),
    flip: prefs.get('flip', false),
    grid: prefs.get('grid', false),
    allowRotate: prefs.get('allowRotate', true),
    paper: prefs.get('paper', false),
    strength: prefs.get('strength', 45),
    detail: prefs.get('detail', 50),
    color: prefs.get('color', '#111111'),
    t: prefs.get('t', { x: 0, y: 0, s: 1, r: 0 }),
    locked: false,
    stream: null, track: null, torch: false,
    facing: 'environment',
    wakeLock: null,
    cameFromHome: false,
    camToken: 0,
  };

  /* ---------- Elementos ---------- */
  const el = {
    splash: $('#splash'), home: $('#home'), trace: $('#trace'),
    file: $('#file'), video: $('#cam'), paper: $('#paper'), stage: $('#stage'),
    overlay: $('#overlay'), grid: $('#grid'),
    camError: $('#cam-error'), camErrorMsg: $('#cam-error-msg'),
    opacity: $('#opacity'), opacityVal: $('#opacity-val'),
    toast: $('#toast'), busy: $('#busy'), sheet: $('#sheet'), unlock: $('#unlock'),
    torch: $('#btn-torch'), continueCard: $('#continue'), thumb: $('#thumb'), modalRoot: $('#modal-root'),
    themeMeta: document.querySelector('meta[name="theme-color"]'),
  };
  const octx = el.overlay.getContext('2d');

  /* =========================================================
     Splash
     ========================================================= */
  const splashStart = performance.now();
  function hideSplash() {
    const wait = Math.max(0, 1300 - (performance.now() - splashStart));
    setTimeout(() => {
      el.splash.classList.add('hide');
      setTimeout(() => el.splash.remove(), 600);
    }, wait);
  }

  /* =========================================================
     Toast
     ========================================================= */
  let toastTimer = 0;
  function toast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  /* =========================================================
     Carga de imágenes
     ========================================================= */
  const MAX_SIDE = 2048;

  function blobToImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen')); };
      img.src = url;
    });
  }

  function imageToCanvas(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('Imagen vacía');
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // Pedimos al navegador que no borre lo guardado (sobre todo en iPhone)
  let persistAsked = false;
  function askPersistentStorage() {
    if (persistAsked) return;
    persistAsked = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* noop */ }
  }

  function saveCurrentImage(type) {
    return new Promise((res) => {
      if (!S.src) return res();
      S.src.toBlob(async (b) => {
        if (b) { await idb.set('last', b); askPersistentStorage(); }
        res();
      }, type, 0.9);
    });
  }

  async function setImageFromBlob(blob, { save = true, keepTransform = false } = {}) {
    const img = await blobToImage(blob);
    S.src = imageToCanvas(img);
    S.sketch = null; S.sketchKey = '';
    if (!keepTransform) { S.t = { x: 0, y: 0, s: 1, r: 0 }; prefs.set('t', S.t); }
    if (save) {
      const keepsAlpha = /png|gif|webp|svg/i.test(blob.type || '');
      await saveCurrentImage(keepsAlpha ? 'image/png' : 'image/jpeg');
    }
    updateContinueCard();
  }

  /* Miniatura del dibujo guardado en Inicio */
  function updateContinueCard() {
    el.continueCard.hidden = !S.src;
    if (!S.src) return;
    drawThumb(el.thumb, S.src);
  }
  function drawThumb(canvas, src) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const k = Math.min(W / src.width, H / src.height) * 0.92;
    const w = src.width * k, h = src.height * k;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }

  function openPicker() {
    el.file.value = '';
    el.file.click();
  }

  /* ---------- Nuevo dibujo (pregunta si ya hay uno en curso) ---------- */
  function confirmReplace({ title, text, yes, onYes }) {
    if (!S.src) { onYes(); return; }
    const m = openModal(`
      <canvas class="confirm-thumb" width="192" height="192"></canvas>
      <h3>${title}</h3>
      <p>${text}</p>
      <div class="actions">
        <button class="btn btn-primary" data-act="yes">${yes}</button>
        <button class="btn btn-ghost" data-act="no">No, seguir calcando</button>
      </div>`, { center: true });
    drawThumb(m.root.querySelector('.confirm-thumb'), S.src);
    m.root.querySelector('[data-act="yes"]').addEventListener('click', () => { m.close(); onYes(); });
    m.root.querySelector('[data-act="no"]').addEventListener('click', m.close);
  }

  function newDrawing() {
    confirmReplace({
      title: '¿Empezamos un dibujo nuevo?',
      text: 'La imagen que estás calcando se va a borrar cuando elijas la nueva. Si cancelás, queda como está.',
      yes: 'Sí, nuevo dibujo',
      onYes: openPicker, // se llama dentro del toque, así el navegador deja abrir la galería
    });
  }

  el.file.addEventListener('change', async () => {
    const f = el.file.files && el.file.files[0];
    if (!f) return;
    try {
      await setImageFromBlob(f);
      if (route() === 'trace') { await refreshOverlay(); toast('¡Listo! Nuevo dibujo cargado'); }
      else goTrace();
    } catch (e) {
      alertModal('No pudimos abrir esa imagen', 'Probá con otra foto (JPG o PNG).');
    }
  });

  /* Dibujo de ejemplo (línea simple de un mate, libre de derechos) */
  const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 400 500">
  <rect width="400" height="500" fill="#fff"/>
  <g fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M262 40 L214 222"/>
    <path d="M255 30 l18 7 l-7 16 l-18 -7 z"/>
    <path d="M124 214 q18 -30 44 -14 q14 -24 40 -8 q22 -22 46 -2 q24 -16 40 16"/>
    <ellipse cx="200" cy="224" rx="96" ry="22"/>
    <path d="M104 224 v24 q96 34 192 0 v-24"/>
    <path d="M112 254 C 56 322, 70 432, 200 446 C 330 432, 344 322, 288 254"/>
    <path d="M150 440 q50 18 100 0 l8 22 q-58 22 -116 0 z"/>
    <path d="M128 318 q72 30 144 0" stroke-dasharray="1 14"/>
    <path d="M118 362 q82 34 164 0"/>
    <path d="M132 400 q68 26 136 0" stroke-dasharray="1 14"/>
  </g>
</svg>`;

  async function loadSample() {
    try {
      const blob = new Blob([SAMPLE_SVG], { type: 'image/svg+xml' });
      await setImageFromBlob(blob);
      goTrace();
    } catch { toast('No se pudo cargar el ejemplo'); }
  }
  function askSample() {
    confirmReplace({
      title: '¿Probamos con el ejemplo?',
      text: 'La imagen que estás calcando se va a reemplazar por el dibujo de ejemplo.',
      yes: 'Sí, usar el ejemplo',
      onYes: loadSample,
    });
  }

  /* =========================================================
     Boceto (efecto lápiz: dodge entre gris y gris invertido desenfocado)
     ========================================================= */
  function blur1D(src, dst, w, h, r, horizontal) {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
    const inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride] = sum * inv;
        const outI = Math.max(0, i - r), inI = Math.min(len - 1, i + r + 1);
        sum += src[base + inI * stride] - src[base + outI * stride];
      }
    }
  }
  function gaussianish(data, w, h, r) {
    const tmp = new Float32Array(data.length);
    for (let p = 0; p < 3; p++) { blur1D(data, tmp, w, h, r, true); blur1D(tmp, data, w, h, r, false); }
    return data;
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function makeSketch(src, strength, detail, color) {
    const SK_MAX = 1600;
    const k = Math.min(1, SK_MAX / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data, n = w * h;

    const gray = new Float32Array(n), inv = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const g = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      gray[i] = g; inv[i] = 255 - g;
    }
    // detalle alto → radio chico → líneas finas; detalle bajo → trazos gruesos
    const scale = Math.max(w, h) / 1200;
    const radius = Math.max(1, Math.round(scale * (1.5 + (100 - detail) / 100 * 9)));
    const bl = gaussianish(inv, w, h, radius);

    const gain = 1 + (strength / 100) * 9;
    const [cr, cg, cb] = hexToRgb(color);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const den = 255 - bl[i];
      const v = den <= 0.5 ? 255 : Math.min(255, (gray[i] * 255) / den);
      let a = (255 - v - 2) * gain;
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      d[j] = cr; d[j + 1] = cg; d[j + 2] = cb; d[j + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function nextFrame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

  async function ensureSketch() {
    const key = [S.strength, S.detail, S.color].join('|');
    if (S.sketch && S.sketchKey === key) return;
    el.busy.hidden = false;
    await nextFrame();
    try { S.sketch = makeSketch(S.src, S.strength, S.detail, S.color); S.sketchKey = key; }
    finally { el.busy.hidden = true; }
  }

  /* =========================================================
     Overlay: dibujo + transformaciones
     ========================================================= */
  function layoutOverlay() {
    if (!S.src) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const fit = Math.min((vw * 0.86) / S.src.width, (vh * 0.62) / S.src.height);
    el.overlay.style.width = Math.round(S.src.width * fit) + 'px';
    el.overlay.style.height = Math.round(S.src.height * fit) + 'px';
    applyTransform();
  }

  function applyTransform() {
    const { x, y, s, r } = S.t;
    el.overlay.style.transform =
      `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${r}rad) scale(${S.flip ? -s : s}, ${s})`;
    el.overlay.style.opacity = String(S.opacity / 100);
  }

  async function refreshOverlay() {
    if (!S.src) return;
    if (S.mode === 'sketch') await ensureSketch();
    const src = S.mode === 'sketch' ? S.sketch : S.src;
    if (el.overlay.width !== src.width || el.overlay.height !== src.height) {
      el.overlay.width = src.width; el.overlay.height = src.height;
    }
    octx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    octx.drawImage(src, 0, 0);
    layoutOverlay();
  }

  /* ---------- Gestos: 1 dedo mueve, 2 dedos escalan y rotan ---------- */
  const pts = new Map();
  let g = null;

  function startGesture() {
    const p = Array.from(pts.values());
    const t0 = { ...S.t };
    if (p.length === 1) {
      g = { n: 1, p0: { ...p[0] }, t0 };
    } else if (p.length >= 2) {
      const [a, b] = p;
      g = {
        n: 2, t0,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        a0: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
  }

  function moveGesture() {
    if (!g) return;
    const p = Array.from(pts.values());
    if (g.n === 1 && p.length === 1) {
      S.t.x = g.t0.x + (p[0].x - g.p0.x);
      S.t.y = g.t0.y + (p[0].y - g.p0.y);
    } else if (g.n === 2 && p.length >= 2) {
      const [a, b] = p;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const s = Math.min(20, Math.max(0.05, g.t0.s * (d / g.d0)));
      const kk = s / g.t0.s;
      let r = g.t0.r;
      if (S.allowRotate) {
        r = g.t0.r + (ang - g.a0);
        const q = Math.PI / 2, near = Math.round(r / q) * q;
        if (Math.abs(r - near) < 0.05) r = near; // imán a 0°, 90°, 180°…
      }
      const dr = r - g.t0.r;
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      // el punto bajo los dedos queda bajo los dedos
      const vx = cx + g.t0.x - g.mid0.x, vy = cy + g.t0.y - g.mid0.y;
      const cos = Math.cos(dr), sin = Math.sin(dr);
      const nx = mid.x + kk * (vx * cos - vy * sin);
      const ny = mid.y + kk * (vx * sin + vy * cos);
      S.t = { x: nx - cx, y: ny - cy, s, r };
    }
    applyTransform();
  }

  el.stage.addEventListener('pointerdown', (e) => {
    if (S.locked) { wakeUnlockPill(); return; }
    if (!S.src) return;
    try { el.stage.setPointerCapture(e.pointerId); } catch { /* noop */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moveGesture();
  });
  const endPointer = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size) startGesture();
    else { g = null; prefs.set('t', S.t); }
  };
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);

  // Rueda del mouse (para probar en compu): zoom; con Shift rota
  el.stage.addEventListener('wheel', (e) => {
    if (S.locked || !S.src) return;
    e.preventDefault();
    if (e.shiftKey && S.allowRotate) S.t.r += e.deltaY * 0.002;
    else S.t.s = Math.min(20, Math.max(0.05, S.t.s * Math.exp(-e.deltaY * 0.0015)));
    applyTransform(); prefs.set('t', S.t);
  }, { passive: false });

  // Por las dudas (navegadores viejos): que la pantalla Calcar nunca quede desplazada
  [el.trace, el.stage].forEach((n) => n.addEventListener('scroll', () => {
    if (n.scrollTop || n.scrollLeft) { n.scrollTop = 0; n.scrollLeft = 0; }
  }));

  // Evitar zoom / rebote del navegador mientras calcamos
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  el.trace.addEventListener('touchmove', (e) => { if (!e.target.closest('.sheet-card')) e.preventDefault(); }, { passive: false });

  /* =========================================================
     Cámara
     ========================================================= */
  function stopCamera() {
    S.camToken++;
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null; S.track = null; S.torch = false;
    el.video.srcObject = null;
    el.torch.hidden = true;
    updateTorchBtn();
  }

  function showCamError(msg) {
    el.camErrorMsg.textContent = msg;
    el.camError.hidden = false;
  }

  async function startCamera() {
    stopCamera();
    el.camError.hidden = true;
    applyPaper();
    if (S.paper) return;

    if (!window.isSecureContext) {
      showCamError('La cámara solo funciona en una conexión segura (https). Abrí la app desde su dirección https.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamError('Este navegador no permite usar la cámara. Probá con Safari (iPhone) o Chrome (Android).');
      return;
    }
    const token = ++S.camToken;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: S.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (token !== S.camToken || route() !== 'trace' || S.paper) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      S.stream = stream;
      S.track = stream.getVideoTracks()[0];
      el.video.srcObject = stream;
      el.video.classList.toggle('mirror', S.facing === 'user');
      try { await el.video.play(); } catch { /* iOS a veces necesita un toque; autoplay+muted suele bastar */ }
      S.track.addEventListener('ended', () => {
        if (route() === 'trace' && !document.hidden && !S.paper) startCamera();
      });
      setupTorch();
      setTimeout(setupTorch, 800); // algunos Android reportan la linterna recién cuando arranca el video
      checkCameras();
    } catch (err) {
      if (token !== S.camToken) return;
      const name = err && err.name;
      let msg = 'Revisá que le hayas dado permiso al navegador para usar la cámara.';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        msg = 'No diste permiso para usar la cámara. Activalo desde el ícono de la barra de direcciones (o en Ajustes del navegador) y tocá Reintentar.';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        msg = 'No encontramos ninguna cámara en este dispositivo.';
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        msg = 'La cámara está ocupada por otra app. Cerrala y tocá Reintentar.';
      }
      showCamError(msg);
    }
  }

  function setupTorch() {
    if (!S.track) return;
    let caps = {};
    try { caps = (S.track.getCapabilities && S.track.getCapabilities()) || {}; } catch { /* noop */ }
    el.torch.hidden = !caps.torch;
    updateTorchBtn();
  }
  function updateTorchBtn() {
    el.torch.classList.toggle('on', !!S.torch);
    el.torch.setAttribute('aria-pressed', String(!!S.torch));
  }
  async function toggleTorch() {
    if (!S.track) return;
    try {
      await S.track.applyConstraints({ advanced: [{ torch: !S.torch }] });
      S.torch = !S.torch;
    } catch { toast('No se pudo prender la linterna'); }
    updateTorchBtn();
  }

  async function checkCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      $('#opt-switch').hidden = devs.filter((d) => d.kind === 'videoinput').length < 2;
    } catch { /* noop */ }
  }

  function applyPaper() {
    el.paper.hidden = !S.paper;
    el.video.hidden = S.paper;
    setPressed('#opt-paper', S.paper);
  }

  /* ---------- Pantalla siempre encendida ---------- */
  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !S.wakeLock) {
        S.wakeLock = await navigator.wakeLock.request('screen');
        S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
      }
    } catch { /* no soportado o sin permiso */ }
  }
  function releaseWake() {
    try { if (S.wakeLock) S.wakeLock.release(); } catch { /* noop */ }
    S.wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (route() !== 'trace') return;
    if (document.hidden) {
      stopCamera();
    } else {
      requestWake();
      startCamera();
    }
  });

  /* =========================================================
     Bloqueo
     ========================================================= */
  let dimTimer = 0, holdTimer = 0;
  function wakeUnlockPill() {
    el.unlock.classList.remove('dim');
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => el.unlock.classList.add('dim'), 2500);
  }
  function lock() {
    S.locked = true;
    pts.clear(); g = null;
    closeSheet();
    document.body.classList.add('locked');
    el.unlock.hidden = false;
    wakeUnlockPill();
    toast('Imagen bloqueada. ¡A dibujar!');
  }
  let swallowClicksUntil = 0;
  // el dedo que desbloquea no tiene que "tocar" el botón que queda debajo al soltarlo
  document.addEventListener('click', (e) => {
    if (performance.now() < swallowClicksUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // mientras el dedo sigue apoyado bloqueamos clicks; al soltarlo, damos 400 ms más
  const releaseSwallow = () => {
    const now = performance.now();
    if (swallowClicksUntil > now + 400) swallowClicksUntil = now + 400;
  };
  document.addEventListener('pointerup', releaseSwallow, true);
  document.addEventListener('pointercancel', releaseSwallow, true);

  function unlock(byFinger = false) {
    if (S.locked && byFinger) swallowClicksUntil = performance.now() + 10000;
    S.locked = false;
    document.body.classList.remove('locked');
    el.unlock.hidden = true;
    el.unlock.classList.remove('holding');
  }
  el.unlock.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wakeUnlockPill();
    el.unlock.classList.add('holding');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { unlock(true); toast('Desbloqueada'); }, 700);
  });
  const cancelHold = () => { clearTimeout(holdTimer); el.unlock.classList.remove('holding'); };
  el.unlock.addEventListener('pointerup', cancelHold);
  el.unlock.addEventListener('pointercancel', cancelHold);
  el.unlock.addEventListener('pointerleave', cancelHold);
  el.unlock.addEventListener('contextmenu', (e) => e.preventDefault());

  /* =========================================================
     Controles de la pantalla Calcar
     ========================================================= */
  function setPressed(sel, on) {
    const b = typeof sel === 'string' ? $(sel) : sel;
    if (b) b.setAttribute('aria-pressed', String(!!on));
  }
  function paintRange(input) {
    const min = +input.min || 0, max = +input.max || 100;
    input.style.setProperty('--p', ((input.value - min) / (max - min)) * 100 + '%');
  }

  function syncControls() {
    el.opacity.value = S.opacity;
    el.opacityVal.textContent = S.opacity + '%';
    paintRange(el.opacity);
    setPressed('#tool-sketch', S.mode === 'sketch');
    setPressed('#opt-flip', S.flip);
    setPressed('#opt-grid', S.grid);
    setPressed('#opt-rotate', S.allowRotate);
    setPressed('#opt-paper', S.paper);
    el.grid.hidden = !S.grid;
    const st = $('#sketch-strength'), dt = $('#sketch-detail');
    st.value = S.strength; dt.value = S.detail; paintRange(st); paintRange(dt);
    $$('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color === S.color)));
  }

  el.opacity.addEventListener('input', () => {
    S.opacity = +el.opacity.value;
    el.opacityVal.textContent = S.opacity + '%';
    paintRange(el.opacity);
    applyTransform();
    prefs.set('opacity', S.opacity);
  });

  $('#tool-new').addEventListener('click', newDrawing);
  $('#tool-sketch').addEventListener('click', async () => {
    S.mode = S.mode === 'sketch' ? 'photo' : 'sketch';
    prefs.set('mode', S.mode);
    syncControls();
    await refreshOverlay();
    if (S.mode === 'sketch') toast('Modo boceto: ajustá la línea en «Ajustes»');
  });
  $('#tool-more').addEventListener('click', openSheet);
  $('#tool-lock').addEventListener('click', lock);
  el.torch.addEventListener('click', toggleTorch);
  $('#btn-back').addEventListener('click', goHome);

  $('#btn-cam-retry').addEventListener('click', startCamera);
  $('#btn-cam-paper').addEventListener('click', () => { S.paper = true; prefs.set('paper', true); syncControls(); startCamera(); paperTip(); });

  function paperTip() {
    toast('Sin cámara: subí el brillo, apoyá una hoja finita sobre la pantalla y calcá', 4500);
  }

  /* ---------- Hoja de ajustes ---------- */
  function openSheet() { el.sheet.hidden = false; }
  function closeSheet() { el.sheet.hidden = true; }
  $('#sheet-close').addEventListener('click', closeSheet);
  el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });

  $('#opt-flip').addEventListener('click', () => { S.flip = !S.flip; prefs.set('flip', S.flip); syncControls(); applyTransform(); });
  $('#opt-grid').addEventListener('click', () => { S.grid = !S.grid; prefs.set('grid', S.grid); syncControls(); });
  $('#opt-center').addEventListener('click', () => {
    S.t = { x: 0, y: 0, s: 1, r: 0 }; prefs.set('t', S.t); applyTransform(); toast('Imagen centrada');
  });
  $('#opt-rotate').addEventListener('click', () => {
    S.allowRotate = !S.allowRotate; prefs.set('allowRotate', S.allowRotate); syncControls();
    toast(S.allowRotate ? 'Rotación con dos dedos activada' : 'Rotación desactivada');
  });
  $('#opt-paper').addEventListener('click', () => {
    S.paper = !S.paper; prefs.set('paper', S.paper); syncControls(); startCamera();
    if (S.paper) paperTip();
  });
  $('#opt-switch').addEventListener('click', () => {
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  let sketchDebounce = 0;
  function sketchParamsChanged() {
    S.sketch = null; S.sketchKey = '';
    clearTimeout(sketchDebounce);
    if (S.mode !== 'sketch') return;
    sketchDebounce = setTimeout(refreshOverlay, 180);
  }
  $('#sketch-strength').addEventListener('input', (e) => { S.strength = +e.target.value; paintRange(e.target); prefs.set('strength', S.strength); sketchParamsChanged(); });
  $('#sketch-detail').addEventListener('input', (e) => { S.detail = +e.target.value; paintRange(e.target); prefs.set('detail', S.detail); sketchParamsChanged(); });
  $$('.swatch').forEach((sw) => sw.addEventListener('click', () => {
    S.color = sw.dataset.color; prefs.set('color', S.color); syncControls();
    if (S.mode !== 'sketch') { S.mode = 'sketch'; prefs.set('mode', 'sketch'); syncControls(); }
    sketchParamsChanged();
  }));

  /* =========================================================
     Modales (instalar / ayuda)
     ========================================================= */
  /* ---------- Botón Instalar: solo en la web ---------- */
  let deferredInstall = null;
  const root = document.documentElement;
  function isStandalone() {
    return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches)
      || navigator.standalone === true;
  }
  function markInstalled(on) {
    prefs.set('installed', !!on);
    root.classList.toggle('is-installed', !!on);
  }
  if (isStandalone()) { root.classList.add('is-app'); markInstalled(true); }
  // Chrome solo ofrece instalar si NO está instalada → si aparece, mostramos el botón
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; markInstalled(false); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; markInstalled(true); });
  // Android/Chrome: detectar si la app ya está instalada aunque se abra desde el navegador
  if (!isStandalone() && navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then((apps) => { if (apps && apps.length) markInstalled(true); }).catch(() => {});
  }

  function openModal(html, { center = false } = {}) {
    el.modalRoot.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true">
        <div class="modal${center ? ' center' : ''}">
          <button class="round-btn close" aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          ${html}
        </div>
      </div>`;
    const bd = el.modalRoot.querySelector('.modal-backdrop');
    const close = () => { el.modalRoot.innerHTML = ''; };
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.querySelector('.close').addEventListener('click', close);
    return { root: bd, close };
  }

  function alertModal(title, text) {
    openModal(`<h3>${title}</h3><p>${text}</p>`);
  }

  function openInstallModal() {
    const m = openModal(`
      <img class="modal-icon" src="/icons/icon.svg" alt="">
      <h3>Instalala en tu celular</h3>
      <p>La podés dejar como un ícono más en tu teléfono, sin abrir el navegador cada vez, y se abre en pantalla completa:</p>
      <p><strong>iPhone (Safari):</strong> tocá el botón de ⬆️ <strong>Compartir</strong> (abajo o arriba, según el modelo) y elegí <strong>"Agregar a pantalla de inicio"</strong>.</p>
      <p><strong>Android (Chrome):</strong> tocá los tres puntitos ⋮ de arriba a la derecha y elegí <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong>.</p>
      ${deferredInstall ? '<button class="btn btn-primary" id="do-install">Instalar ahora</button>' : ''}
    `);
    const b = m.root.querySelector('#do-install');
    if (b) b.addEventListener('click', async () => {
      try { deferredInstall.prompt(); await deferredInstall.userChoice; } catch { /* noop */ }
      deferredInstall = null; m.close();
    });
  }

  function openHelpModal() {
    openModal(`
      <img class="modal-icon" src="/icons/icon.svg" alt="">
      <h3>¿Cómo se usa?</h3>
      <ul>
        <li><strong>Apoyá el celular</strong> sobre un vaso, una pila de libros o un trípode, a 20–30 cm del papel.</li>
        <li><strong>Un dedo</strong> mueve la imagen; <strong>dos dedos</strong> la agrandan, achican y giran.</li>
        <li><strong>Opacidad:</strong> bajala hasta ver bien el papel y la punta del lápiz.</li>
        <li><strong>Boceto:</strong> convierte la foto en líneas. En «Ajustes» cambiás intensidad, detalle y color.</li>
        <li><strong>Bloquear:</strong> esconde los controles y congela la imagen. Para desbloquear, mantené apretado el candado.</li>
        <li><strong>Tu dibujo queda guardado:</strong> si cerrás la app, al volver a abrirla seguís donde estabas.</li>
      </ul>
      <h3>Si algo no anda</h3>
      <ul>
        <li><strong>No se ve la cámara:</strong> revisá el permiso de cámara del navegador y tocá «Reintentar».</li>
        <li><strong>La imagen se corre del papel:</strong> el celular se movió. Apoyalo firme y no toques la mesa.</li>
        <li><strong>No aparece la linterna:</strong> en iPhone el navegador no la permite; usá una lámpara de costado.</li>
        <li><strong>Sin cámara:</strong> en «Ajustes» activá «Sin cámara», subí el brillo y calcá apoyando una hoja finita sobre la pantalla.</li>
      </ul>
    `);
  }

  /* =========================================================
     Navegación
     ========================================================= */
  function route() { return location.hash.startsWith('#/calcar') ? 'trace' : 'home'; }

  function goTrace() {
    if (route() === 'trace') { onRoute(); return; }
    S.cameFromHome = true;
    location.hash = '#/calcar';
  }
  function goHome() {
    if (S.cameFromHome) { S.cameFromHome = false; history.back(); }
    else location.replace('#/');
  }

  function showHome() {
    prefs.set('lastRoute', 'home');
    stopCamera(); releaseWake(); unlock(); closeSheet();
    updateContinueCard();
    el.trace.hidden = true; el.home.hidden = false;
    document.body.classList.remove('tracing');
    el.themeMeta.setAttribute('content', '#F2FBF8');
  }

  async function showTrace() {
    prefs.set('lastRoute', 'trace');
    el.home.hidden = true; el.trace.hidden = false;
    document.body.classList.add('tracing');
    el.themeMeta.setAttribute('content', '#000000');
    syncControls();
    await refreshOverlay();
    startCamera();
    requestWake();
    if (!prefs.get('hinted', false)) {
      setTimeout(() => toast('Arrastrá para mover · pellizcá para agrandar · girá con dos dedos', 4200), 600);
      prefs.set('hinted', true);
    }
  }

  function onRoute() {
    if (route() === 'trace') {
      if (!S.src) { location.replace('#/'); return; }
      showTrace();
    } else {
      showHome();
    }
  }
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('resize', () => { if (route() === 'trace') layoutOverlay(); });

  /* ---------- Botones de Inicio ---------- */
  $('#btn-new').addEventListener('click', newDrawing);
  $('#btn-sample').addEventListener('click', askSample);
  $('#btn-resume').addEventListener('click', () => { if (S.src) goTrace(); else openPicker(); });
  $('#btn-install').addEventListener('click', openInstallModal);
  $('#btn-help-top').addEventListener('click', openHelpModal);
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.nav;
    if (k === 'home') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (k === 'new') newDrawing();
    else if (k === 'trace') { if (S.src) goTrace(); else openPicker(); }
  }));

  /* =========================================================
     Inicio de la app
     ========================================================= */
  async function init() {
    try {
      const last = await idb.get('last');
      if (last instanceof Blob) await setImageFromBlob(last, { save: false, keepTransform: true });
    } catch { /* sin imagen previa */ }
    // Si cerraste la app mientras calcabas, volvés directo a tu dibujo
    if (S.src && route() === 'home' && prefs.get('lastRoute', 'home') === 'trace') {
      history.replaceState(null, '', '#/');
      S.cameFromHome = true;
      history.pushState(null, '', '#/calcar');
    }
    onRoute();
    hideSplash();
  }
  init();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
