const CW = 88, CH = 88, GAP = 16, TOP = 106;

const svgEl = document.getElementById('vine');
const zone = document.getElementById('zone');
const layer = document.getElementById('layer');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');
const hintEl = document.getElementById('hint');

let items = [];
let S = 1, startX = 0, pitch = 0;
const nodeMap = new Map();
let drag = null;
let ghostEl = null;
let toastTimer = null;
let firstState = true;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function vineY(x) {
  return 60 + Math.sin(x / 240) * 9 + Math.sin(x / 97) * 2.4;
}

/* ---------------- vine drawing ---------------- */

function drawVine() {
  const W = window.innerWidth, H = window.innerHeight;
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);
  svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  let d = '';
  for (let x = -24; x <= W + 24; x += 6) {
    d += (x === -24 ? 'M' : 'L') + x.toFixed(1) + ' ' + vineY(x).toFixed(1) + ' ';
  }

  let leaves = '';
  for (let x = 40; x < W - 24; x += 134) {
    const y = vineY(x);
    const flip = Math.sin(x / 134) > 0 ? 1 : -1;
    const a = flip > 0 ? -26 : 30;
    leaves += '<path d="M0 0 C 7 -9, 21 -12, 27 -4 C 21 4, 8 6, 0 0 Z" fill="url(#lg)" opacity=".92" transform="translate(' + x + ' ' + y.toFixed(1) + ') rotate(' + a + ') scale(' + (flip > 0 ? 1 : -1) + ' 1)"/>';
  }

  svgEl.innerHTML =
    '<defs>' +
      '<linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#2f6b47" stop-opacity=".28"/>' +
        '<stop offset=".12" stop-color="#3f8358"/>' +
        '<stop offset=".5" stop-color="#5ea87a"/>' +
        '<stop offset=".88" stop-color="#3f8358"/>' +
        '<stop offset="1" stop-color="#2f6b47" stop-opacity=".28"/>' +
      '</linearGradient>' +
      '<linearGradient id="lg" x1="0" y1="1" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#4d9c6e"/><stop offset="1" stop-color="#8ed4a8"/>' +
      '</linearGradient>' +
      '<filter id="soft" x="-10%" y="-300%" width="120%" height="700%">' +
        '<feGaussianBlur stdDeviation="3"/>' +
      '</filter>' +
    '</defs>' +
    '<g filter="url(#soft)" opacity=".5">' +
      '<path d="' + d + '" fill="none" stroke="#1b4b31" stroke-width="8" stroke-linecap="round"/>' +
    '</g>' +
    '<path d="' + d + '" fill="none" stroke="url(#g1)" stroke-width="4.2" stroke-linecap="round"/>' +
    '<path d="' + d + '" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.2" stroke-linecap="round" transform="translate(0,-1.7)"/>' +
    '<g>' + leaves + '</g>';
}

/* ---------------- node ---------------- */

function kindOf(it) { return it.type; }

function makeNode(it) {
  const el = document.createElement('div');
  el.className = 'node';
  el.dataset.id = it.id;

  const stem = document.createElement('div');
  stem.className = 'stem';

  const sway = document.createElement('div');
  sway.className = 'sway';
  sway.style.animationDuration = (6.4 + Math.random() * 3.4).toFixed(2) + 's';
  sway.style.animationDelay = (-Math.random() * 6).toFixed(2) + 's';

  const card = document.createElement('div');
  card.className = 'card';

  const kind = kindOf(it);
  if (kind === 'shot') {
    card.classList.add('shot');
    const img = document.createElement('img');
    img.src = it.thumb || it.src || '';
    img.draggable = false;
    card.appendChild(img);
  } else {
    card.classList.add('note');
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = it.text || '';
    card.appendChild(t);
  }

  sway.appendChild(card);
  el.appendChild(stem);
  el.appendChild(sway);

  const peek = document.createElement('div');
  peek.className = 'peek';
  if (kind === 'shot') {
    const im = document.createElement('img');
    im.src = it.src || it.thumb || '';
    peek.appendChild(im);
  } else {
    const t = document.createElement('div');
    t.className = 'peek-txt';
    t.textContent = it.text || '';
    peek.appendChild(t);
  }
  el.appendChild(peek);

  el.classList.add('fresh');
  setTimeout(() => el.classList.remove('fresh'), 640);

  return { el, stem, sway, card, kind };
}

/* ---------------- render ---------------- */

function render() {
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    let n = nodeMap.get(it.id);
    if (n && n.kind !== kindOf(it)) {
      n.el.remove();
      nodeMap.delete(it.id);
      n = null;
    }
    if (!n) {
      n = makeNode(it);
      nodeMap.set(it.id, n);
      layer.appendChild(n.el);
    }
  }
  for (const [id, n] of Array.from(nodeMap)) {
    if (!seen.has(id)) { n.el.remove(); nodeMap.delete(id); }
  }
  layout();
  updateCount();
}

function layout() {
  const n = items.length;
  const W = window.innerWidth;
  const avail = W - 240;
  const full = n * CW + Math.max(0, n - 1) * GAP;
  S = n ? Math.min(1, avail / Math.max(1, full)) : 1;
  S = clamp(S, 0.4, 1);
  pitch = (CW + GAP) * S;
  const total = n ? n * pitch - GAP * S : 0;
  startX = Math.round((W - total) / 2);

  items.forEach((it, i) => {
    const node = nodeMap.get(it.id);
    if (!node) return;
    const x = startX + i * pitch;
    const dragging = !!(drag && drag.id === it.id && drag.moved);
    if (!dragging) {
      node.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + TOP + 'px,0) scale(' + S + ')';
    }
    node.el.style.zIndex = dragging ? 60 : 1;

    const cx = x + (CW * S) / 2;
    const vy = vineY(cx);
    node.stem.style.height = Math.max(10, TOP - vy) + 'px';
    node.stem.style.top = (-(TOP - vy)).toFixed(1) + 'px';
    node.stem.style.bottom = 'auto';
  });

  if (n) {
    const zx = Math.max(0, startX - 46);
    zone.style.left = zx + 'px';
    zone.style.top = '0px';
    zone.style.width = Math.min(W - zx, total + 92) + 'px';
    zone.style.height = (TOP + CH * S + 150) + 'px';
  } else {
    zone.style.left = (W / 2 - 140) + 'px';
    zone.style.top = '0px';
    zone.style.width = '280px';
    zone.style.height = (TOP + CH + 150) + 'px';
  }

  const cntX = n ? Math.min(W - 118, startX + total + 26) : W / 2 + 150;
  countEl.style.left = Math.round(cntX) + 'px';
  countEl.style.top = Math.round(TOP + CH * S / 2 - 14) + 'px';

  sendRects();
}

function updateCount() {
  const pending = items.filter((i) => i.state === 'hang').length;
  countEl.firstElementChild.textContent = String(pending);
  countEl.classList.toggle('zero', pending === 0);
}

/* ---------------- interaction: hover / click-through ---------------- */

function hitTest(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  return !!(el.closest('.node') || el.closest('#count'));
}

let hoverId = null;
let rectTimer = null;

function sendRects() {
  if (rectTimer) return;
  rectTimer = setTimeout(() => {
    rectTimer = null;
    const rs = [];
    for (const [id, n] of nodeMap) {
      const r = n.el.getBoundingClientRect();
      if (r.width <= 0) continue;
      rs.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      if (id === hoverId) {
        const pk = n.el.querySelector('.peek');
        if (pk) {
          const pr = pk.getBoundingClientRect();
          if (pr.height > 0) rs.push({ x: pr.left, y: pr.top, w: pr.width, h: pr.height });
        }
      }
    }
    if (!countEl.classList.contains('zero')) {
      const br = countEl.getBoundingClientRect();
      rs.push({ x: br.left, y: br.top, w: br.width, h: br.height });
    }
    window.api.setRects(rs);
  }, 25);
}

function setHover(id) {
  if (id === hoverId) return;
  hoverId = id;
  for (const [nid, n] of nodeMap) n.el.classList.toggle('hov', nid === id);
  sendRects();
}

window.api.onCursor((p) => {
  if (drag) return;
  if (!p.inWin) { setHover(null); return; }
  const el = document.elementFromPoint(p.x, p.y);
  const node = el && el.closest ? el.closest('.node') : null;
  setHover(node && node.dataset.id ? node.dataset.id : null);
});

/* ---------------- drag ---------------- */

window.addEventListener('pointerdown', (e) => {
  const el = e.target.closest && e.target.closest('.node');
  if (!el || drag) return;
  const it = items.find((i) => i.id === el.dataset.id);
  if (!it || it.state !== 'hang') return;

  const m = /translate3d\(([-\d.]+)px/.exec(el.style.transform || '');
  const ox = m ? parseFloat(m[1]) : 0;

  drag = { id: it.id, el, sx: e.clientX, sy: e.clientY, ox, moved: false, mode: null };
  window.api.setLock(true);
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;

  if (!drag.moved && Math.hypot(dx, dy) > 7) {
    drag.moved = true;
    drag.el.classList.add('dragging');
  }
  if (!drag.moved) return;

  if (dy > 118) {
    drag.mode = 'detach';
    drag.el.classList.add('out');
    showGhost(e.clientX, e.clientY);
    return;
  }

  if (drag.mode === 'detach') {
    drag.mode = null;
    drag.el.classList.remove('out');
    hideGhost();
  }

  const x = drag.ox + dx;
  drag.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + (TOP + Math.min(dy * 0.18, 26)).toFixed(1) + 'px,0) scale(' + S + ')';

  const idxWant = clamp(Math.round((x - startX) / Math.max(1, pitch)), 0, items.length - 1);
  const idxNow = items.findIndex((i) => i.id === drag.id);
  if (idxWant !== idxNow) {
    const [it] = items.splice(idxNow, 1);
    items.splice(idxWant, 0, it);
    layout();
    drag.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + (TOP + Math.min(dy * 0.18, 26)).toFixed(1) + 'px,0) scale(' + S + ')';
  }
});

window.addEventListener('pointercancel', () => { if (drag) { drag.el.classList.remove('out', 'dragging'); if (ghostEl) hideGhost(); drag = null; window.api.setLock(false); layout(); } });

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  window.api.setLock(false);
  d.el.classList.remove('dragging');
  if (ghostEl) hideGhost();

  if (!d.moved) { layout(); return; }

  if (d.mode === 'detach') {
    d.el.classList.remove('out');
    toast('摘下来了');
    window.api.detach(d.id, e.clientX, e.clientY);
    return;
  }

  window.api.reorder(items.map((i) => i.id));
  layout();
});

function showGhost(x, y) {
  if (!ghostEl) {
    const src = drag.el.querySelector('.sway');
    ghostEl = document.createElement('div');
    ghostEl.className = 'ghost';
    ghostEl.innerHTML = src ? src.innerHTML : '';
    document.body.appendChild(ghostEl);
  }
  ghostEl.style.transform = 'translate3d(' + (x - 40) + 'px,' + (y - 40) + 'px,0)';
}
function hideGhost() {
  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
}

/* ---------------- toast ---------------- */

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1700);
}

/* ---------------- boot ---------------- */

function setState(s) {
  // 只展示还在藤上的（hang）；已完成的 done 和摘出去没挂回的 out 都不占位
  items = ((s && s.items) || []).filter((i) => i.state === 'hang');
  render();
  if (firstState) {
    firstState = false;
    hintEl.classList.add('on');
    setTimeout(() => hintEl.classList.remove('on'), 11000);
  }
}

window.api.onState(setState);
window.api.getState().then(setState);
window.addEventListener('resize', () => { drawVine(); layout(); });

drawVine();
