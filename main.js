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
let composerWin = null;
let tray = null;
let hidden = false;
let captureWasHidden = false;
let peekTimer = null;
const cards = new Map();
const cardSaveTimers = new Map();

let state = { date: '', items: [] };

/* interactive-region tracking (transparent overlay click-through) */
let interactRects = [];
let interactLock = false;
let lastIgnore = null;
let lastForward = null;
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

function buildSeedItems() {
  const now = Date.now();
  const notes = [
    '周一 10:00 产品评审\n- 藤蔓默认收起\n- 快捷键必须能改',
    '给老张回邮件\n接口文档周三前给出去',
    '下午 4 点和设计过一遍\n葫芦的 hover 态',
    '本周只做两件事\n藤条 + 摘取，不做归档',
  ];
  const items = [];
  notes.forEach((text, i) => {
    items.push({
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
    items.push({
      id, type: 'shot', src: 'vine://shot/' + id + '.png',
      thumb: 'data:image/jpeg;base64,' + img.resize({ width: 220 }).toJPEG(74).toString('base64'),
      w: sz.width, h: sz.height, t: now - (3 - i) * 3600000, state: 'hang',
    });
  });
  items.sort((a, b) => b.t - a.t);
  return items;
}

function seedIfEmpty() {
  if (state.items.length) return;
  state.items = buildSeedItems();
  save();
}

/* 恢复示例：清空当前藤条，重新放回 4 张便签 + 3 张截图 */
function reseed() {
  state.items = buildSeedItems();
  state.date = dayKey();
  save(); push();
  if (vineWin && !vineWin.isDestroyed()) flashVine();
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
  lastForward = null;
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

function composerActive() {
  // 最小化（hide）时不算激活，藤条的 hover / 拖拽要能照常工作
  return !!(composerWin && !composerWin.isDestroyed() && composerWin.isVisible());
}

// 便签窗口打开时，藤条窗口保持"完全穿透、不转发鼠标消息"：
// 两个置顶窗口在屏幕上叠着，转发鼠标消息会让 Windows 在两边反复设置光标，
// 表现为文本域里光标在箭头和 I 形之间闪烁。
function applyIgnore(over) {
  const comp = composerActive();
  const want = comp ? true : !(over || interactLock);
  const fwd = !comp;
  if (want === lastIgnore && fwd === lastForward) return;
  lastIgnore = want;
  lastForward = fwd;
  if (vineWin && !vineWin.isDestroyed()) vineWin.setIgnoreMouseEvents(want, { forward: fwd });
}

function startPointerPoll() {
  if (pollTimer) clearInterval(pollTimer);
  lastIgnore = null;
  lastForward = null;
  lastCursor = { x: -1, y: -1 };
  pollTimer = setInterval(() => {
    if (!vineWin || vineWin.isDestroyed() || hidden || composerActive()) return;
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
  let winW = bodyW + pad * 2;
  let winH = bodyH + head + pad * 2;
  if (item.type === 'note' && Number(item.cardW) >= 220 && Number(item.cardH) >= 150) {
    winW = Math.round(Number(item.cardW));
    winH = Math.round(Number(item.cardH));
  }
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
  const cb = composerWin && !composerWin.isDestroyed() ? composerWin.getBounds() : null;
  state.items.unshift({
    id: uid(), type: 'note', text: t, t: Date.now(), state: 'hang',
    cardW: cb ? cb.width : undefined,
    cardH: cb ? cb.height : undefined,
  });
  save(); push();
  showVine();
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
  const width = Math.max(240, Math.round(w));
  const height = Math.max(160, Math.round(h));
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width, height });

  // 每个便签记住自己最后一次拖出的长宽比和尺寸
  const it = state.items.find((i) => i.id === id);
  if (it && it.type === 'note') {
    it.cardW = width;
    it.cardH = height;
    clearTimeout(cardSaveTimers.get(id));
    cardSaveTimers.set(id, setTimeout(() => {
      cardSaveTimers.delete(id);
      save();
    }, 250));
  }
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

ipcMain.on('debug:open-composer', () => openComposerWindow());

ipcMain.handle('composer:draft:get', () => {
  if (!composerDraftLoaded) loadDraft();
  return composerDraft;
});
ipcMain.on('composer:draft:set', (e, text) => {
  composerDraft = String(text == null ? '' : text);
  writeDraftSoon();
});
ipcMain.on('composer:minimize', () => {
  if (!composerWin || composerWin.isDestroyed()) return;
  rememberComposerBounds();
  composerWin.hide();
  lastIgnore = null;
  lastForward = null;
  applyIgnore(false);
});
ipcMain.on('composer:close', () => {
  clearDraft();
  closeComposerWindow();
});
ipcMain.on('composer:resize', (e, b) => {
  if (!composerWin || composerWin.isDestroyed()) return;
  const x = Math.round(Number((b && b.x) || 0));
  const y = Math.round(Number((b && b.y) || 0));
  const w = Math.max(260, Math.round(Number((b && b.w) || 0)));
  const h = Math.max(200, Math.round(Number((b && b.h) || 0)));
  composerWin.setBounds({ x, y, width: w, height: h });
  composerBounds = { x, y, width: w, height: h };
  writeComposerViewSoon();
});

/* ---------- composer window ---------- */

const COMPOSER_W = 344;
const COMPOSER_H = 352;
let composerBounds = null;      // 上次的窗口位置/大小，重新打开时沿用
let composerViewLoaded = false;
let composerViewWriteTimer = null;
let composerDraft = '';         // 未挂到藤上的草稿（最小化后保留）
let composerDraftLoaded = false;
let draftWriteTimer = null;

const draftPath = () => path.join(dataDir(), 'composer-draft.json');
const composerViewPath = () => path.join(dataDir(), 'composer-view.json');

function loadComposerView() {
  if (composerViewLoaded) return;
  composerViewLoaded = true;
  try {
    const d = JSON.parse(fs.readFileSync(composerViewPath(), 'utf8'));
    const b = d && d.bounds;
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 260 && b.height >= 200) {
      composerBounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    }
  } catch (e) { /* 第一次打开还没有记录 */ }
}

function writeComposerViewSoon() {
  clearTimeout(composerViewWriteTimer);
  composerViewWriteTimer = setTimeout(() => {
    composerViewWriteTimer = null;
    if (!composerBounds) return;
    try { fs.writeFileSync(composerViewPath(), JSON.stringify({ bounds: composerBounds })); } catch (e) {}
  }, 250);
}

function rememberComposerBounds() {
  if (!composerWin || composerWin.isDestroyed()) return;
  composerBounds = composerWin.getBounds();
  writeComposerViewSoon();
}

function loadDraft() {
  composerDraftLoaded = true;
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(), 'utf8'));
    if (d && typeof d.text === 'string') composerDraft = d.text;
  } catch (e) { /* 还没有草稿 */ }
}

function writeDraftSoon() {
  clearTimeout(draftWriteTimer);
  draftWriteTimer = setTimeout(() => {
    draftWriteTimer = null;
    try { fs.writeFileSync(draftPath(), JSON.stringify({ text: composerDraft })); } catch (e) {}
  }, 300);
}

function clearDraft() {
  composerDraft = '';
  composerDraftLoaded = true;
  clearTimeout(draftWriteTimer);
  draftWriteTimer = null;
  try { fs.rmSync(draftPath(), { force: true }); } catch (e) {}
}

function centerComposerBounds() {
  const a = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(a.x + (a.width - COMPOSER_W) / 2),
    y: Math.round(a.y + (a.height - COMPOSER_H) / 2),
    width: COMPOSER_W,
    height: COMPOSER_H,
  };
}

function openComposerWindow() {
  if (composerWin && !composerWin.isDestroyed()) {
    composerWin.show();
    composerWin.focus();
    applyIgnore(false);
    return;
  }
  loadComposerView();
  let b = composerBounds || centerComposerBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + 80 > w.x && b.y + 40 > w.y && b.x < w.x + w.width - 80 && b.y < w.y + w.height - 40;
  });
  if (!visible) b = centerComposerBounds();

  composerWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 260, minHeight: 200,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: true, minimizable: false, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // 压在所有窗口最前面（含置顶窗口），拖动/缩放交给渲染层自己做，窗口本身保持不可 resize
  composerWin.setAlwaysOnTop(true, 'screen-saver');
  applyIgnore(false); // 打开便签时立刻让藤条窗口停止转发鼠标，避免光标闪烁
  composerWin.loadFile(path.join(__dirname, 'renderer', 'composer.html'));
  composerWin.once('ready-to-show', () => {
    if (!composerWin || composerWin.isDestroyed()) return;
    composerWin.show();
    composerWin.focus();
  });
  composerWin.on('moved', rememberComposerBounds);
  composerWin.on('close', () => {
    if (!composerWin || composerWin.isDestroyed()) return;
    composerBounds = composerWin.getBounds();
    clearTimeout(composerViewWriteTimer);
    composerViewWriteTimer = null;
    try { fs.writeFileSync(composerViewPath(), JSON.stringify({ bounds: composerBounds })); } catch (e) {}
  });
  composerWin.on('closed', () => {
    composerWin = null;
    lastIgnore = null;
    lastForward = null;
    applyIgnore(false);
  });
}

function closeComposerWindow() {
  const w = composerWin;
  if (!w || w.isDestroyed()) return;
  setTimeout(() => { if (w && !w.isDestroyed()) w.close(); }, 40);
}

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
      openComposerWindow();
    } },
    { type: 'separator' },
    { label: '全部完成（收藤）', click: () => {
      state.items.forEach((i) => { if (i.state === 'hang') i.state = 'done'; });
      save(); push();
    } },
    { label: '恢复示例节点（重置藤条）', click: () => reseed() },
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
    openComposerWindow();
  });
  globalShortcut.register('Control+Shift+Q', () => toggleVine());
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());



