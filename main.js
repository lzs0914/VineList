const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen,
  desktopCapturer, nativeImage, clipboard, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

const VINE_H = 520;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomBytes(6).toString('hex');
let vineWin = null;
let captureWin = null;
let tray = null;
let hidden = false;
let captureWasHidden = false;
let peekTimer = null;
const cards = new Map();

let state = { date: '', items: [] };

/* interactive-region tracking (transparent overlay click-through) */
let interactRects = [];
let interactLock = false;
let lastIgnore = null;
let lastCursor = { x: -1, y: -1 };
let pollTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 从桌面快捷方式重复启动时，直接把藤条显示出来
  app.on('second-instance', () => {
    hidden = false;
    if (!vineWin || vineWin.isDestroyed()) createVineWindow();
    showVine();
  });
}

/* ---------- storage ---------- */

const dataDir = () => app.getPath('userData');
const shotsDir = () => path.join(dataDir(), 'shots');
const storePath = () => path.join(dataDir(), 'vine-state.json');

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (s && Array.isArray(s.items)) state = s;
  } catch (e) { /* first run */ }
  const bad = (state.items || []).some((i) => i.type === 'shot' && typeof i.thumb !== 'string');
  if (bad) state = { date: dayKey(), items: [] };
  if (!state.date) state.date = dayKey();
}

function save() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(state));
  } catch (e) { console.error('save failed', e); }
}

function publicState() {
  return {
    items: state.items.map((i) => ({
      id: i.id, type: i.type, state: i.state,
      thumb: i.thumb || null, src: i.src || null,
      text: i.text || '', w: i.w || 0, h: i.h || 0, t: i.t || 0,
    })),
  };
}

function push() {
  if (vineWin && !vineWin.isDestroyed()) vineWin.webContents.send('state:changed', publicState());
}

/* ---------- demo seed ---------- */

function seedIfEmpty() {
  if (state.items.length) return;
  const now = Date.now();
  const notes = [
    '周一 10:00 产品评审\n- 藤蔓默认收起\n- 快捷键必须能改',
    '给老张回邮件\n接口文档周三前给出去',
    '下午 4 点和设计过一遍\n葫芦的 hover 态',
    '本周只做两件事\n藤条 + 摘取，不做归档',
  ];
  notes.forEach((text, i) => {
    state.items.push({
      id: uid(), type: 'note', text, t: now - (notes.length - i) * 600000, state: 'hang',
    });
  });
  const demo = path.join(__dirname, 'assets', 'demo');
  ['shot-1.png', 'shot-2.png', 'shot-3.png'].forEach((f, i) => {
    const p = path.join(demo, f);
    if (!fs.existsSync(p)) return;
    const id = uid();
    fs.mkdirSync(shotsDir(), { recursive: true });
    fs.copyFileSync(p, path.join(shotsDir(), id + '.png'));
    const img = nativeImage.createFromPath(p);
    const sz = img.getSize();
    state.items.push({
      id, type: 'shot', src: 'vine://shot/' + id + '.png',
      thumb: 'data:image/jpeg;base64,' + img.resize({ width: 220 }).toJPEG(74).toString('base64'),
      w: sz.width, h: sz.height, t: now - (3 - i) * 3600000, state: 'hang',
    });
  });
  state.items.sort((a, b) => b.t - a.t);
  save();
}

/* ---------- vine window ---------- */

function createVineWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  vineWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: VINE_H,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true,
    fullscreenable: false, acceptFirstMouse: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  vineWin.setAlwaysOnTop(true, 'floating');
  vineWin.setIgnoreMouseEvents(true, { forward: true });
  vineWin.loadFile(path.join(__dirname, 'renderer', 'vine.html'));
  vineWin.once('ready-to-show', () => {
    vineWin.showInactive();
    startPointerPoll();
    setTimeout(() => vineWin.webContents.send('state:changed', publicState()), 60);
  });
  vineWin.on('closed', () => { vineWin = null; });
}

function showVine() {
  hidden = false;
  if (!vineWin) return;
  lastIgnore = null;
  vineWin.showInactive();
  vineWin.setAlwaysOnTop(true, 'floating');
}

function hideVine() {
  hidden = true;
  if (vineWin) vineWin.hide();
}

function toggleVine() {
  if (hidden) showVine(); else hideVine();
}

function pointInRects(lx, ly) {
  for (const r of interactRects) {
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) return true;
  }
  return false;
}

function applyIgnore(over) {
  const want = !(over || interactLock);
  if (want === lastIgnore) return;
  lastIgnore = want;
  if (vineWin && !vineWin.isDestroyed()) vineWin.setIgnoreMouseEvents(want, { forward: true });
}

function startPointerPoll() {
  if (pollTimer) clearInterval(pollTimer);
  lastIgnore = null;
  lastCursor = { x: -1, y: -1 };
  pollTimer = setInterval(() => {
    if (!vineWin || vineWin.isDestroyed() || hidden) return;
    const p = screen.getCursorScreenPoint();
    const b = vineWin.getBounds();
    const lx = p.x - b.x;
    const ly = p.y - b.y;
    if (lx === lastCursor.x && ly === lastCursor.y) return;
    lastCursor = { x: lx, y: ly };
    const inWin = lx >= 0 && ly >= 0 && lx < b.width && ly < b.height;
    const over = inWin && pointInRects(lx, ly);
    applyIgnore(over);
    vineWin.webContents.send('ui:cursor', { x: lx, y: ly, inWin, over });
  }, 20);
}

function flashVine() {
  if (!hidden) return;
  showVine();
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { if (hidden === false) hideVine(); }, 3000);
}

/* ---------- capture ---------- */

function isBlankImage(img) {
  try {
    const { width: w, height: h } = img.getSize();
    if (!w || !h) return true;
    const bmp = img.toBitmap();
    const sx = Math.max(1, Math.floor(w / 40));
    const sy = Math.max(1, Math.floor(h / 26));
    const seen = new Set();
    for (let y = 0; y < h; y += sy) {
      for (let x = 0; x < w; x += sx) {
        const i = (y * w + x) * 4;
        seen.add(((bmp[i] >> 4) << 10) | ((bmp[i + 1] >> 4) << 5) | (bmp[i + 2] >> 4));
        if (seen.size > 6) return false;
      }
    }
    return seen.size <= 6;
  } catch (e) { return false; }
}

function captureScreenGDI() {
  return new Promise((resolve) => {
    const out = path.join(app.getPath('temp'), 'vine-cap-' + Date.now() + '.png');
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)',
      '$bmp.Save("' + out.replace(/\\/g, '\\\\') + '",[System.Drawing.Imaging.ImageFormat]::Png)',
      '$g.Dispose();$bmp.Dispose()'
    ].join(';');
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const bin = fs.existsSync(psExe) ? psExe : 'powershell';
    execFile(bin, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true, timeout: 8000 }, (err) => {
        if (err || !fs.existsSync(out)) return resolve(null);
        setTimeout(() => {
          try {
            const img = nativeImage.createFromPath(out);
            try { fs.unlinkSync(out); } catch (e) {}
            resolve(img.isEmpty() ? null : img);
          } catch (e) { resolve(null); }
        }, 60);
      });
  });
}

async function startCapture() {
  if (captureWin) return;
  const d = screen.getPrimaryDisplay();
  captureWasHidden = hidden;
  const wasHidden = captureWasHidden;
  if (vineWin) vineWin.hide();
  await sleep(170);

  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor },
      fetchWindowIcons: false,
    });
  } catch (e) { console.error(e); }

  if (!sources.length) { if (!wasHidden) showVine(); return; }
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
  let img = src.thumbnail;
  if (isBlankImage(img)) {
    // Windows occasionally returns an empty frame on the first grab; retry once.
    await sleep(220);
    try {
      const again = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor },
        fetchWindowIcons: false,
      });
      const s2 = again.find((x) => String(x.display_id) === String(d.id)) || again[0];
      if (s2 && !isBlankImage(s2.thumbnail)) img = s2.thumbnail;
    } catch (e) {}
    if (isBlankImage(img)) {
      const fallback = await captureScreenGDI();
      if (fallback && !isBlankImage(fallback)) img = fallback;
    }
  }
  const dataUrl = img.toDataURL();

  captureWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: false, backgroundColor: '#000000',
    resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, fullscreenable: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  captureWin.setAlwaysOnTop(true, 'floating');
  captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
  captureWin.webContents.once('did-finish-load', () => {
    captureWin.webContents.send('capture:image', dataUrl);
    captureWin.focus();
  });
  captureWin.on('closed', () => {
    captureWin = null;
  });
}

function closeCapture() {
  if (captureWin && !captureWin.isDestroyed()) captureWin.close();
}

/* ---------- cards ---------- */

function openCard(item, sx, sy) {
  if (cards.has(item.id)) { const w = cards.get(item.id); if (w && !w.isDestroyed()) { w.show(); w.focus(); return; } }
  const pad = 36, head = 30;
  let bodyW, bodyH;
  if (item.type === 'shot') {
    const iw = item.w || 800, ih = item.h || 600;
    bodyW = 520; bodyH = Math.round(bodyW * ih / iw);
    if (bodyH > 420) { bodyH = 420; bodyW = Math.round(bodyH * iw / ih); }
    bodyW = Math.max(200, bodyW); bodyH = Math.max(120, bodyH);
  } else {
    bodyW = 330;
    const txt = String(item.text || '');
    const lines = txt.split('\n').reduce((a, ln) => a + Math.max(1, Math.ceil(ln.length / 19)), 0);
    bodyH = Math.max(150, Math.min(320, 74 + lines * 22));
  }
  const winW = bodyW + pad * 2;
  const winH = bodyH + head + pad * 2;
  const d = screen.getPrimaryDisplay().bounds;
  let x = Math.round((sx == null ? d.x + d.width / 2 : sx) - winW / 2);
  let y = Math.round((sy == null ? d.y + 260 : sy) - 46);
  x = Math.max(d.x + 8, Math.min(x, d.x + d.width - winW - 8));
  y = Math.max(d.y + 8, Math.min(y, d.y + d.height - winH - 8));

  const win = new BrowserWindow({
    x, y, width: winW, height: winH, minWidth: 220, minHeight: 150,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'card.html'), { query: { id: item.id } });
  cards.set(item.id, win);
  win.on('closed', () => {
    cards.delete(item.id);
    const it = state.items.find((i) => i.id === item.id);
    if (it && it.state === 'out') { it.state = 'done'; save(); push(); }
  });
}

function closeCard(id) {
  const w = cards.get(id);
  if (w && !w.isDestroyed()) w.close();
}

/* ---------- protocol ---------- */

protocol.registerSchemesAsPrivileged([
  { scheme: 'vine', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

/* ---------- ipc ---------- */

ipcMain.handle('state:get', () => publicState());

ipcMain.on('ui:interactive', () => { /* superseded by ui:lock + polling */ });

ipcMain.on('ui:rects', (e, rs) => {
  if (Array.isArray(rs)) interactRects = rs;
});

ipcMain.on('ui:lock', (e, v) => {
  interactLock = !!v;
  if (interactLock) applyIgnore(true);
  else {
    lastIgnore = null;
    const p = screen.getCursorScreenPoint();
    const b = vineWin && !vineWin.isDestroyed() ? vineWin.getBounds() : { x: 0, y: 0 };
    applyIgnore(pointInRects(p.x - b.x, p.y - b.y));
  }
});

ipcMain.on('ui:focus', () => {
  if (vineWin && !vineWin.isDestroyed()) { vineWin.show(); vineWin.focus(); }
});

ipcMain.handle('note:add', (e, text) => {
  const t = String(text || '').trim();
  if (!t) return false;
  state.items.unshift({ id: uid(), type: 'note', text: t, t: Date.now(), state: 'hang' });
  save(); push();
  return true;
});

ipcMain.on('items:reorder', (e, ids) => {
  const map = new Map(state.items.map((i) => [i.id, i]));
  const next = ids.map((id) => map.get(id)).filter(Boolean);
  for (const i of state.items) if (!ids.includes(i.id)) next.push(i);
  state.items = next;
  save();
});

ipcMain.handle('item:detach', (e, id, x, y) => {
  const it = state.items.find((i) => i.id === id);
  if (!it) return false;
  it.state = 'out';
  save(); push();
  openCard(it, x, y);
  return true;
});


ipcMain.handle('capture:done', async (e, payload) => {
  const { dataUrl, w, h } = payload || {};
  if (!dataUrl) return false;
  try {
    const buf = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    const id = uid();
    fs.mkdirSync(shotsDir(), { recursive: true });
    fs.writeFileSync(path.join(shotsDir(), id + '.png'), buf);
    const img = nativeImage.createFromBuffer(buf);
    const size = img.getSize();
    state.items.unshift({
      id, type: 'shot', src: 'vine://shot/' + id + '.png',
      thumb: 'data:image/jpeg;base64,' + img.resize({ width: 220 }).toJPEG(76).toString('base64'),
      w: size.width, h: size.height, t: Date.now(), state: 'hang',
    });
    save(); push();
  } catch (err) { console.error(err); }
  closeCapture();
  if (captureWasHidden) { hidden = true; } else { showVine(); }
  return true;
});

ipcMain.on('capture:cancel', () => {
  closeCapture();
  if (captureWasHidden) { hidden = true; } else { showVine(); }
});

ipcMain.handle('card:get', (e, id) => {
  const it = state.items.find((i) => i.id === id);
  if (!it) return null;
  return { id: it.id, type: it.type, text: it.text || '', src: it.src || null, w: it.w, h: it.h, t: it.t };
});

ipcMain.on('card:return', (e, id) => {
  const it = state.items.find((i) => i.id === id);
  if (it) { it.state = 'hang'; save(); push(); }
  const w = cards.get(id);
  if (w && !w.isDestroyed()) { cards.delete(id); w.destroy(); }
  showVine();
});

ipcMain.on('card:done', (e, id) => {
  const it = state.items.find((i) => i.id === id);
  if (it) { it.state = 'done'; save(); push(); }
  const w = cards.get(id);
  if (w && !w.isDestroyed()) { cards.delete(id); w.destroy(); }
});

ipcMain.on('card:size', (e, id, w, h) => {
  const win = cards.get(id);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: Math.max(240, Math.round(w)), height: Math.max(160, Math.round(h)) });
});

ipcMain.handle('card:copy', (e, id) => {
  const it = state.items.find((i) => i.id === id);
  if (!it) return false;
  if (it.type === 'shot' && it.src) {
    const p = path.join(shotsDir(), it.id + '.png');
    if (fs.existsSync(p)) clipboard.writeImage(nativeImage.createFromPath(p));
  } else {
    clipboard.writeText(it.text || '');
  }
  return true;
});

ipcMain.on('debug:open-composer', () => {
  if (vineWin && !vineWin.isDestroyed()) {
    vineWin.show(); vineWin.focus();
    vineWin.webContents.send('ui:composer');
  }
});

/* ---------- tray ---------- */

function buildTray() {
  let icon;
  try { icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')); } catch (e) {}
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('藤蔓 · 今天的工作范围');
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏藤条', accelerator: 'Ctrl+Shift+Q', click: toggleVine },
    { type: 'separator' },
    { label: '截一张图', accelerator: 'Ctrl+Shift+A', click: () => startCapture() },
    { label: '写个便签', accelerator: 'Ctrl+Shift+N', click: () => {
      if (vineWin) { vineWin.show(); vineWin.focus(); vineWin.webContents.send('ui:composer'); }
    } },
    { type: 'separator' },
    { label: '全部完成（收藤）', click: () => {
      state.items.forEach((i) => { if (i.state === 'hang') i.state = 'done'; });
      save(); push();
    } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleVine);
}

/* ---------- boot ---------- */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('vine', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    return net.fetch(pathToFileURL(path.join(shotsDir(), rel)).toString());
  });

  load();
  seedIfEmpty();
  createVineWindow();
  buildTray();

  globalShortcut.register('Control+Shift+A', () => startCapture());
  globalShortcut.register('Control+Shift+N', () => {
    if (vineWin) { vineWin.show(); vineWin.focus(); vineWin.webContents.send('ui:composer'); }
  });
  globalShortcut.register('Control+Shift+Q', () => toggleVine());
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());



