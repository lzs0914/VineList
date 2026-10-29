const ta = document.getElementById('note');
const saveBtn = document.getElementById('save');
let saving = false;

async function save() {
  if (saving) return;
  saving = true;
  const v = ta.value.trim();
  if (v) await window.api.addNote(v);
  window.api.composerClose();
}

ta.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); save(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
});
saveBtn.addEventListener('mousedown', (e) => { e.preventDefault(); save(); });
window.addEventListener('blur', () => { if (!saving) save(); });
window.addEventListener('focus', () => { ta.focus(); });
setTimeout(() => ta.focus(), 60);