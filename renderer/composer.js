const ta = document.getElementById('note');
const saveBtn = document.getElementById('save');
const minBtn = document.getElementById('min');
const closeBtn = document.getElementById('close');

let saving = false;
let draftTimer = null;

/* ---------------- 草稿：最小化保留，关闭清空 ---------------- */

function pushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  window.api.draftSet(ta.value);
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = null; window.api.draftSet(ta.value); }, 250);
}

async function boot() {
  try {
    const d = await window.api.draftGet();
    if (typeof d === 'string' && d) {
      ta.value = d;
      ta.setSelectionRange(d.length, d.length);
    }
  } catch (e) { /* 首次打开没有草稿 */ }
  ta.focus();
  ta.scrollTop = ta.scrollHeight;
}

/* ---------------- 动作 ---------------- */

async function save() {
  if (saving) return;
  saving = true;
  const v = ta.value.trim();
  if (v) {
    try {
      await window.api.addNote(v);
    } catch (e) {
      saving = false;
      return;
    }
  }
  window.api.composerClose();
}

function minimize() {
  pushDraft();
  window.api.composerMinimize();
}

/* ---------------- 事件 ---------------- */

ta.addEventListener('input', scheduleDraft);
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); minimize(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
});
saveBtn.addEventListener('click', () => save());
minBtn.addEventListener('click', () => minimize());
closeBtn.addEventListener('click', () => window.api.composerClose());
window.addEventListener('focus', () => ta.focus());
window.addEventListener('beforeunload', () => { if (!saving) clearTimeout(draftTimer); });

/* ---------------- 拖边改变大小 ---------------- */

const MIN_W = 260;
const MIN_H = 200;
let rz = null;

for (const h of document.querySelectorAll('.rz')) {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    rz = {
      dir: h.dataset.dir,
      sx: e.screenX,
      sy: e.screenY,
      x: window.screenX,
      y: window.screenY,
      w: window.outerWidth,
      h: window.outerHeight,
    };
    try { h.setPointerCapture(e.pointerId); } catch (err) {}
  });
}

window.addEventListener('pointermove', (e) => {
  if (!rz) return;
  const dx = e.screenX - rz.sx;
  const dy = e.screenY - rz.sy;
  let x = rz.x, y = rz.y, w = rz.w, h = rz.h;

  if (rz.dir.includes('e')) w = rz.w + dx;
  if (rz.dir.includes('s')) h = rz.h + dy;
  if (rz.dir.includes('w')) { w = rz.w - dx; x = rz.x + dx; }
  if (rz.dir.includes('n')) { h = rz.h - dy; y = rz.y + dy; }

  if (w < MIN_W) { if (rz.dir.includes('w')) x = rz.x + rz.w - MIN_W; w = MIN_W; }
  if (h < MIN_H) { if (rz.dir.includes('n')) y = rz.y + rz.h - MIN_H; h = MIN_H; }

  window.api.composerResize({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
});

window.addEventListener('pointerup', () => { rz = null; });
window.addEventListener('pointercancel', () => { rz = null; });

boot();
