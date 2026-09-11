/* Meme Extract — interface */
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
};

// ------------------------------------------------------------------ utils
function fmtTime(sec, decimals = 1) {
  if (sec == null || isNaN(sec)) return '';
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = decimals ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + ss;
}
function parseTime(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(',', '.');
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) { const n = parseFloat(p); if (isNaN(n)) return NaN; total = total * 60 + n; }
  return total;
}
function normTag(t) { return t.trim().toLowerCase().replace(/\s+/g, ' '); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// ------------------------------------------------------------------ onglets
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'library') loadLibrary();
  location.hash = name;
}

// ------------------------------------------------------------------ tags connus
let knownTags = [];
// selection : Map ordonnée id -> clip (l'ordre d'insertion = ordre de lecture), persistée dans localStorage
const selection = new Map();
try { (JSON.parse(localStorage.getItem('selection') || '[]')).forEach((c) => selection.set(c.id, c)); } catch (_) { /* ignore */ }
async function refreshTags() {
  knownTags = await api('/api/tags');
  $('#tag-suggestions').replaceChildren(...knownTags.map((t) => el('option', { value: t.name })));
  renderQuickTags();
  renderTagFilter();
  renderTagManager();
  const done = await api('/api/clips?status=done');
  $('#lib-count').textContent = done.length || '';
  // Retire de la sélection les clips supprimés entre-temps
  const alive = new Set(done.map((c) => c.id));
  let changed = false;
  for (const id of [...selection.keys()]) if (!alive.has(id)) { selection.delete(id); changed = true; }
  if (changed) { saveSelection(); renderCompileBar(); }
}

// ------------------------------------------------------------------ éditeur de tags (réutilisable)
function makeTagEditor(chipsEl, inputEl) {
  let tags = [];
  const render = () => {
    chipsEl.replaceChildren(...tags.map((t, i) => el('span', { class: 'chip' + (i === 0 ? ' primary-tag' : ''), title: i === 0 ? 'Tag principal → dossier' : '' },
      t, el('span', { class: 'x', onclick: () => { tags.splice(i, 1); render(); } }, '✕'))));
  };
  const add = (raw) => {
    raw.split(',').map(normTag).filter(Boolean).forEach((t) => { if (!tags.includes(t)) tags.push(t); });
    inputEl.value = '';
    render();
  };
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(inputEl.value); }
    else if (e.key === 'Backspace' && !inputEl.value && tags.length) { tags.pop(); render(); }
  });
  inputEl.addEventListener('change', () => { if (inputEl.value.trim()) add(inputEl.value); });
  inputEl.addEventListener('blur', () => { if (inputEl.value.trim()) add(inputEl.value); });
  return { get: () => tags.slice(), set: (t) => { tags = t.slice(); render(); }, add };
}
const addTags = makeTagEditor($('#tag-chips'), $('#tag-input'));
const editTags = makeTagEditor($('#edit-chips'), $('#edit-tag-input'));
$('#tag-add').addEventListener('click', () => { addTags.add($('#tag-input').value); $('#tag-input').focus(); });
$('#edit-tag-add').addEventListener('click', () => { editTags.add($('#edit-tag-input').value); $('#edit-tag-input').focus(); });

// Gestion des tags (bibliothèque)
$('#new-tag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-tag').value.trim();
  if (!name) return;
  try {
    await api('/api/tags', { method: 'POST', body: JSON.stringify({ names: name }) });
    $('#new-tag').value = '';
    await refreshTags();
  } catch (err) { alert(err.message); }
});
function renderTagManager() {
  $('#tag-manage-list').replaceChildren(...knownTags.map((t) => el('span', { class: 'chip' },
    `${t.name} (${t.count})`,
    t.count === 0 ? el('span', { class: 'x', title: 'Supprimer ce tag', onclick: async () => {
      await api(`/api/tags/${encodeURIComponent(t.name)}`, { method: 'DELETE' }); refreshTags();
    } }, '✕') : null)));
}

function renderQuickTags() {
  $('#quick-tags').replaceChildren(...knownTags.map((t) =>
    el('span', { class: 'chip', onclick: () => addTags.add(t.name) }, `+ ${t.name}`)));
}

// ------------------------------------------------------------------ lecteur YouTube
let player = null, playerReady = false, sourceInfo = null, previewTimer = null;
window.onYouTubeIframeAPIReady = () => {};
function loadYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.append(s);
  });
}
async function mountPlayer(videoId) {
  await loadYouTubeApi();
  playerReady = false;
  if (player) { player.destroy(); player = null; $('#player-wrap').append(el('div', { id: 'player' })); }
  $('#player-wrap').hidden = false;
  player = new YT.Player('player', {
    videoId, playerVars: { rel: 0, modestbranding: 1, controls: 1 },
    events: { onReady: () => { playerReady = true; } },
  });
}
function playerTime() { return playerReady && player ? player.getCurrentTime() : null; }

// ------------------------------------------------------------------ étape 1 : URL
$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url').value.trim();
  $('#url-error').hidden = true;
  $('#btn-load').disabled = true; $('#btn-load').textContent = 'Chargement…';
  try {
    sourceInfo = await api('/api/info', { method: 'POST', body: JSON.stringify({ url }) });
    $('#source-thumb').src = sourceInfo.thumbnail || '';
    $('#source-title').textContent = sourceInfo.title || '(sans titre)';
    $('#source-duration').textContent = sourceInfo.duration ? `Durée ${fmtTime(sourceInfo.duration, 0)}` : 'Durée inconnue';
    $('#source-extractor').textContent = sourceInfo.extractor || '';
    $('#source').hidden = false;
    $('#section-cut').hidden = false;
    $('#section-tags').hidden = false;
    if (!$('#title').value) $('#title').value = sourceInfo.title || '';
    if (sourceInfo.is_youtube && sourceInfo.id) await mountPlayer(sourceInfo.id);
    else { $('#player-wrap').hidden = true; if (player) { player.destroy(); player = null; $('#player-wrap').append(el('div', { id: 'player' })); } }
  } catch (err) {
    $('#url-error').textContent = err.message; $('#url-error').hidden = false;
  } finally {
    $('#btn-load').disabled = false; $('#btn-load').textContent = 'Charger';
  }
});

// ------------------------------------------------------------------ étape 2 : bornes
function updateCutInfo() {
  const a = parseTime($('#start').value), b = parseTime($('#end').value);
  $('#cut-duration').textContent = (!isNaN(a) && !isNaN(b) && b > a) ? `Durée du clip : ${(b - a).toFixed(1)} s` : '';
}
['#start', '#end'].forEach((s) => $(s).addEventListener('input', updateCutInfo));
document.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => mark(b.dataset.mark)));
function mark(which) {
  const t = playerTime();
  if (t == null) return;
  $(`#${which}`).value = fmtTime(t);
  updateCutInfo();
}
$('#btn-preview').addEventListener('click', previewCut);
function previewCut() {
  const a = parseTime($('#start').value), b = parseTime($('#end').value);
  if (!playerReady || isNaN(a) || isNaN(b) || b <= a) return;
  clearInterval(previewTimer);
  player.seekTo(a, true); player.playVideo();
  previewTimer = setInterval(() => {
    if (player.getCurrentTime() >= b) { player.pauseVideo(); clearInterval(previewTimer); }
  }, 50);
}
document.addEventListener('keydown', (e) => {
  if (!playerReady || !$('#tab-add').classList.contains('active')) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const step = e.shiftKey ? 0.1 : 1;
  if (e.key === 'i' || e.key === 'I') mark('start');
  else if (e.key === 'o' || e.key === 'O') mark('end');
  else if (e.key === ' ') { e.preventDefault(); player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); player.seekTo(Math.max(0, player.getCurrentTime() - step), true); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); player.seekTo(player.getCurrentTime() + step, true); }
  else if (e.key === 'p' || e.key === 'P') previewCut();
});

// ------------------------------------------------------------------ étape 3 : envoi
$('#btn-submit').addEventListener('click', async () => {
  $('#submit-error').hidden = true;
  if ($('#tag-input').value.trim()) addTags.add($('#tag-input').value);
  const payload = {
    url: $('#url').value.trim(), start: $('#start').value, end: $('#end').value,
    title: $('#title').value.trim(), tags: addTags.get(), info: sourceInfo,
  };
  const a = parseTime(payload.start), b = parseTime(payload.end);
  if (isNaN(a) || isNaN(b) || b <= a) return showSubmitError('Indique un début et une fin valides (ex : 1:23).');
  if (!payload.tags.length) return showSubmitError('Ajoute au moins un tag.');
  $('#btn-submit').disabled = true;
  try {
    const clip = await api('/api/clips', { method: 'POST', body: JSON.stringify(payload) });
    queue.set(clip.id, clip);
    renderQueue();
    $('#section-queue').hidden = false;
    // Prêt pour un autre passage de la même vidéo : on vide seulement les bornes
    $('#start').value = ''; $('#end').value = ''; updateCutInfo();
    refreshTags();
    startPolling();
  } catch (err) { showSubmitError(err.message); }
  finally { $('#btn-submit').disabled = false; }
});
function showSubmitError(msg) { $('#submit-error').textContent = msg; $('#submit-error').hidden = false; }

// ------------------------------------------------------------------ file d'attente
const queue = new Map();
let pollTimer = null;
const STATUS_LABEL = { pending: 'En attente', downloading: 'Téléchargement', done: 'Prêt ✓', error: 'Erreur' };
function renderQueue() {
  const items = [...queue.values()].sort((a, b) => b.id - a.id);
  $('#queue').replaceChildren(...items.map((c) => el('li', {},
    el('div', { class: 'info' },
      el('div', { class: 't' }, c.title),
      el('div', { class: 'muted small' }, `${fmtTime(c.start)} → ${fmtTime(c.end)} · ${c.tags.join(', ')}`,
        c.status === 'error' ? el('span', { class: 'error' }, ` — ${c.error}`) : null,
        c.status === 'done' && c.path ? ` — ${c.path}` : null)),
    el('span', { class: `status ${c.status}` }, c.progress || STATUS_LABEL[c.status] || c.status),
    c.status === 'error' ? el('button', { class: 'icon', onclick: () => retry(c.id) }, '↻ Réessayer') : null,
    c.status === 'done' ? el('button', { class: 'icon', onclick: () => { switchTab('library'); } }, 'Voir') : null,
  )));
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const active = [...queue.values()].filter((c) => c.status === 'pending' || c.status === 'downloading');
    if (!active.length) { clearInterval(pollTimer); pollTimer = null; refreshTags(); return; }
    for (const c of active) {
      try { const fresh = await api(`/api/clips/${c.id}`); queue.set(c.id, fresh); } catch (_) { /* ignore */ }
    }
    renderQueue();
  }, 1500);
}
async function retry(id) {
  await api(`/api/clips/${id}/retry`, { method: 'POST' });
  const fresh = await api(`/api/clips/${id}`); queue.set(id, fresh); renderQueue(); startPolling();
}

// ------------------------------------------------------------------ bibliothèque
// Filtre tri-état par tag : inclus (tous requis) / exclu / neutre
const includeTags = new Set(), excludeTags = new Set();
let projects = [];

function renderTagFilter() {
  const none = !includeTags.size && !excludeTags.size;
  const chips = [el('span', { class: 'chip' + (none ? ' active' : ''), onclick: () => { includeTags.clear(); excludeTags.clear(); renderTagFilter(); loadLibrary(); } }, 'Tous')];
  for (const t of knownTags) {
    const cls = includeTags.has(t.name) ? ' active' : excludeTags.has(t.name) ? ' excluded' : '';
    chips.push(el('span', { class: 'chip' + cls, onclick: () => cycleTag(t.name) },
      t.name, ' ', el('span', { class: 'count' }, `(${t.done})`)));
  }
  $('#tag-filter').replaceChildren(...chips);
}
function cycleTag(name) {
  if (includeTags.has(name)) { includeTags.delete(name); excludeTags.add(name); }
  else if (excludeTags.has(name)) { excludeTags.delete(name); }
  else { includeTags.add(name); }
  renderTagFilter(); loadLibrary();
}
function setTag(t) { includeTags.clear(); excludeTags.clear(); includeTags.add(t); renderTagFilter(); loadLibrary(); }

let searchTimer = null;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadLibrary, 250); });
$('#only-done').addEventListener('change', loadLibrary);
$('#sort').addEventListener('change', loadLibrary);
$('#btn-refresh').addEventListener('click', () => { refreshTags(); loadLibrary(); });

async function refreshProjects() {
  projects = await api('/api/projects');
  $('#project-suggestions').replaceChildren(...projects.map((p) => el('option', { value: p.project })));
}

async function loadLibrary() {
  const params = new URLSearchParams();
  if (includeTags.size) params.set('tags', [...includeTags].join(','));
  if (excludeTags.size) params.set('exclude', [...excludeTags].join(','));
  const q = $('#search').value.trim(); if (q) params.set('q', q);
  if ($('#only-done').checked) params.set('status', 'done');
  const [sort, order] = $('#sort').value.split(':');
  params.set('sort', sort); params.set('order', order);
  const [clips] = await Promise.all([api(`/api/clips?${params}`), refreshProjects(), loadCompilations()]);
  lastClips = clips;
  $('#lib-empty').hidden = clips.length > 0;
  $('#clips').replaceChildren(...clips.map(renderClip));
}
let lastClips = [];

function replaceCard(c) {
  const old = document.querySelector(`.clip[data-id="${c.id}"]`);
  if (old) old.replaceWith(renderClip(c));
}

function renderClip(c) {
  const media = c.status === 'done' && c.media_url
    ? el('video', { controls: true, preload: 'metadata', src: c.media_url, poster: c.thumbnail || null })
    : el('div', { class: 'placeholder' }, c.status === 'error' ? `Erreur : ${c.error}` : (c.progress || STATUS_LABEL[c.status]));
  return el('div', { class: 'clip' + (selection.has(c.id) ? ' selected' : ''), 'data-id': c.id },
    media,
    el('div', { class: 'body' },
      el('div', { class: 'title' }, c.title),
      el('div', { class: 'chips' }, ...c.tags.map((t, i) => el('span', { class: 'chip' + (i === 0 ? ' primary-tag' : ''), onclick: () => setTag(t), style: 'cursor:pointer' }, t))),
      el('div', { class: 'meta' },
        el('span', {}, `${c.duration} s`),
        el('span', {}, `${fmtTime(c.start)} → ${fmtTime(c.end)}`),
        el('a', { href: c.source_url, target: '_blank', rel: 'noopener', title: c.source_title || '' }, 'source ↗')),
      renderUsages(c),
      c.status === 'done' ? renderExports(c) : null,
      el('div', { class: 'actions' },
        c.status === 'done' ? el('button', { class: 'icon sel' + (selection.has(c.id) ? ' on' : ''), title: 'Ajouter / retirer de la sélection', onclick: () => toggleSelect(c) }, selection.has(c.id) ? '✓ Compil' : '＋ Compil') : null,
        c.path ? el('button', { class: 'icon', title: c.path, onclick: () => api(`/api/clips/${c.id}/reveal`, { method: 'POST' }) }, '📁 Finder') : null,
        c.media_url ? el('a', { class: 'icon', href: c.media_url, download: '', title: 'Télécharger' }, el('button', { class: 'icon' }, '⬇')) : null,
        el('button', { class: 'icon', onclick: () => openEdit(c) }, '✎'),
        c.status === 'error' ? el('button', { class: 'icon', onclick: async () => { await retry(c.id); loadLibrary(); } }, '↻') : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'icon danger', title: 'Supprimer le clip et son fichier', onclick: (e) => removeClip(c, e.currentTarget) }, '🗑'))));
}

// « Déjà utilisé dans… » : compteur + liste des projets + ajout inline
function renderUsages(c) {
  const n = c.use_count || 0;
  const input = el('input', { placeholder: 'Utilisé dans quelle vidéo ?', list: 'project-suggestions', autocomplete: 'off' });
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const project = input.value.trim(); if (!project) return;
    try { replaceCard(await api(`/api/clips/${c.id}/usages`, { method: 'POST', body: JSON.stringify({ project }) })); refreshProjects(); }
    catch (err) { alert(err.message); }
  } }, input, el('button', { type: 'submit', class: 'icon' }, '✔ Utilisé'));
  const details = el('details', { class: 'uses' },
    el('summary', { class: n ? 'has' : '' }, n ? `✔ Utilisé ${n} fois` : 'Jamais utilisé'),
    n ? el('ul', {}, ...c.usages.map((u) => el('li', {},
      el('span', {}, `${u.project} · ${u.used_at.slice(0, 10)}`),
      el('span', { class: 'x', title: 'Retirer', onclick: async () => replaceCard(await api(`/api/usages/${u.id}`, { method: 'DELETE' })) }, '✕')))) : null,
    form);
  return details;
}

// Exports dérivés : MP3 / WAV / GIF (générés à la demande, puis lien direct)
function renderExports(c) {
  const wrap = el('div', { class: 'exports' });
  for (const [fmt, label] of [['mp3', '🎵 MP3'], ['wav', '🎵 WAV'], ['gif', '🖼 GIF']]) {
    if (c.exports && c.exports[fmt]) {
      wrap.append(el('a', { class: 'btn ready', href: c.exports[fmt], download: '', title: `Télécharger le ${fmt.toUpperCase()}` }, label + ' ✓'));
    } else {
      const btn = el('button', { class: 'icon', title: `Générer le ${fmt.toUpperCase()}`, onclick: async () => {
        btn.disabled = true; btn.textContent = `${label}…`;
        try { replaceCard(await api(`/api/clips/${c.id}/export`, { method: 'POST', body: JSON.stringify({ format: fmt }) })); }
        catch (err) { btn.disabled = false; btn.textContent = label; alert(err.message); }
      } }, label);
      wrap.append(btn);
    }
  }
  return wrap;
}

// Confirmation en deux clics (les dialogues natifs confirm() sont bloqués dans certains navigateurs)
async function removeClip(c, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1'; btn.textContent = 'Supprimer ?'; btn.classList.add('armed');
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = '🗑'; btn.classList.remove('armed'); }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/clips/${c.id}`, { method: 'DELETE' });
    queue.delete(c.id); renderQueue();
    await refreshTags(); loadLibrary();
  } catch (err) { btn.disabled = false; btn.textContent = `Erreur : ${err.message}`; }
}

// Import d'un export (JSON ou ZIP)
$('#import-file').addEventListener('change', async () => {
  const file = $('#import-file').files[0]; if (!file) return;
  const out = $('#import-result');
  out.hidden = false; out.className = 'small'; out.textContent = `Import de ${file.name}…`;
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await fetch('/api/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    out.className = 'small import-ok';
    out.textContent = `${data.imported} clip(s) importé(s), ${data.skipped} doublon(s) ignoré(s), ${data.downloading} en téléchargement.`
      + (data.errors.length ? ` Erreurs : ${data.errors.join(' ; ')}` : '');
    const recent = await api('/api/clips');
    recent.filter((c) => c.status === 'pending' || c.status === 'downloading').forEach((c) => queue.set(c.id, c));
    if (queue.size) { $('#section-queue').hidden = false; renderQueue(); startPolling(); }
    await refreshTags(); loadLibrary();
  } catch (err) { out.className = 'small import-err'; out.textContent = err.message; }
  finally { $('#import-file').value = ''; }
});

// ------------------------------------------------------------------ sélection / compilation

function saveSelection() {
  try { localStorage.setItem('selection', JSON.stringify([...selection.values()].map((c) => ({ id: c.id, title: c.title, media_url: c.media_url, duration: c.duration })))); } catch (_) { /* ignore */ }
}
function toggleSelect(c) {
  if (selection.has(c.id)) selection.delete(c.id); else selection.set(c.id, c);
  saveSelection(); renderCompileBar();
  if (!selection.has(c.id) && selection.size === 0) setCompileCollapsed(false);
  const card = document.querySelector(`.clip[data-id="${c.id}"]`);
  if (card) {
    card.classList.toggle('selected', selection.has(c.id));
    const b = card.querySelector('.actions .sel');
    if (b) { b.classList.toggle('on', selection.has(c.id)); b.textContent = selection.has(c.id) ? '✓ Compil' : '＋ Compil'; }
  }
}
$('#btn-select-all').addEventListener('click', () => {
  lastClips.filter((c) => c.status === 'done').forEach((c) => selection.set(c.id, c));
  saveSelection(); renderCompileBar(); loadLibrary();
});
$('#compile-clear').addEventListener('click', () => { selection.clear(); saveSelection(); renderCompileBar(); loadLibrary(); });
$('#compile-toggle-list').addEventListener('click', () => { const l = $('#compile-list'); l.hidden = !l.hidden; $('#compile-toggle-list').textContent = l.hidden ? 'Ordonner ▾' : 'Ordonner ▴'; });

function moveInSelection(id, delta) {
  const ids = [...selection.keys()], i = ids.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const items = ids.map((k) => [k, selection.get(k)]);
  selection.clear(); items.forEach(([k, v]) => selection.set(k, v));
  saveSelection(); renderCompileBar();
}
// Volet replié → petite pastille en bas à droite (état mémorisé)
let compileCollapsed = false;
try { compileCollapsed = localStorage.getItem('compileCollapsed') === '1'; } catch (_) { /* ignore */ }
function setCompileCollapsed(v) {
  compileCollapsed = v;
  try { localStorage.setItem('compileCollapsed', v ? '1' : '0'); } catch (_) { /* ignore */ }
  renderCompileBar();
}
$('#compile-collapse').addEventListener('click', () => setCompileCollapsed(true));
$('#compile-pill').addEventListener('click', () => setCompileCollapsed(false));

function renderCompileBar() {
  const items = [...selection.values()];
  const bar = $('#compile-bar'), pill = $('#compile-pill');
  bar.hidden = items.length === 0 || compileCollapsed;
  pill.hidden = items.length === 0 || !compileCollapsed;
  document.body.classList.toggle('has-compile-bar', !bar.hidden);
  if (!items.length) return;
  const total = items.reduce((a, c) => a + (c.duration || 0), 0);
  const summary = `${items.length} clip${items.length > 1 ? 's' : ''} · ${total.toFixed(1)} s`;
  $('#compile-summary').textContent = summary;
  pill.textContent = `🎬 ${summary} ▴`;
  $('#compile-list').replaceChildren(...items.map((c, i) => el('li', {},
    el('span', { class: 'n' }, `${i + 1}.`),
    el('span', { class: 't' }, c.title),
    el('span', { class: 'muted' }, `${c.duration} s`),
    el('button', { class: 'ghost', title: 'Monter', disabled: i === 0, onclick: () => moveInSelection(c.id, -1) }, '↑'),
    el('button', { class: 'ghost', title: 'Descendre', disabled: i === items.length - 1, onclick: () => moveInSelection(c.id, 1) }, '↓'),
    el('button', { class: 'ghost', title: 'Retirer', onclick: () => toggleSelect(c) }, '✕'))));
}

// Lecture enchaînée dans la page
const pl = { items: [], i: 0 };
const plVideo = $('#playlist-video');
function playlistOpen(items, start = 0) {
  if (!items.length) return;
  pl.items = items; pl.i = start;
  $('#playlist-overlay').hidden = false;
  playlistLoad();
}
function playlistLoad() {
  const c = pl.items[pl.i];
  $('#playlist-pos').textContent = `${pl.i + 1} / ${pl.items.length}`;
  $('#playlist-title').textContent = c.title;
  plVideo.src = c.media_url;
  plVideo.play().catch(() => { /* autoplay bloqué : l'utilisateur clique play */ });
}
function playlistStep(delta) {
  let n = pl.i + delta;
  if (n >= pl.items.length) { if (!$('#playlist-loop').checked) { plVideo.pause(); return; } n = 0; }
  if (n < 0) n = pl.items.length - 1;
  pl.i = n; playlistLoad();
}
function playlistClose() { plVideo.pause(); plVideo.removeAttribute('src'); plVideo.load(); $('#playlist-overlay').hidden = true; }
plVideo.addEventListener('ended', () => playlistStep(1));
$('#playlist-next').addEventListener('click', () => playlistStep(1));
$('#playlist-prev').addEventListener('click', () => playlistStep(-1));
$('#playlist-close').addEventListener('click', playlistClose);
$('#playlist-overlay').addEventListener('click', (e) => { if (e.target === $('#playlist-overlay')) playlistClose(); });
$('#compile-play').addEventListener('click', () => playlistOpen([...selection.values()]));
document.addEventListener('keydown', (e) => {
  if ($('#playlist-overlay').hidden) return;
  if (e.key === 'Escape') playlistClose();
  else if (e.key === 'ArrowRight') { e.preventDefault(); playlistStep(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); playlistStep(-1); }
});

// Compilation en une seule vidéo (ffmpeg côté serveur)
$('#compile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('/api/compilations', { method: 'POST', body: JSON.stringify({ clip_ids: [...selection.keys()], title: $('#compile-title').value }) });
    $('#compile-title').value = '';
    $('#compil-details').open = true;
    await loadCompilations();
    startCompilPolling();
    $('#compil-section').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; }
});
let compilPoll = null;
function startCompilPolling() {
  if (compilPoll) return;
  compilPoll = setInterval(async () => {
    const list = await loadCompilations();
    if (!list.some((c) => c.status === 'pending' || c.status === 'building')) { clearInterval(compilPoll); compilPoll = null; }
  }, 2000);
}
const COMPIL_LABEL = { pending: 'En attente…', building: 'Assemblage…', done: 'Prête', error: 'Erreur' };
async function loadCompilations() {
  const list = await api('/api/compilations');
  $('#compil-count').textContent = list.length || '';
  $('#compilations').replaceChildren(...list.map((k) => el('div', { class: 'compil' },
    k.status === 'done' ? el('video', { controls: true, preload: 'metadata', src: k.media_url })
      : el('div', { class: 'placeholder' }, k.status === 'error' ? `Erreur : ${k.error}` : (k.progress || COMPIL_LABEL[k.status])),
    el('div', { class: 'body' },
      el('div', { class: 'title' }, k.title),
      el('div', { class: 'clips-in' }, `${k.clips.length} clips` + (k.duration ? ` · ${k.duration} s` : '') + ' — ' + k.clips.map((c) => c.title).join(' → ')),
      el('div', { class: 'actions' },
        k.status === 'done' ? el('button', { class: 'icon', onclick: () => playlistOpen(k.clips.map((c) => selection.get(c.id) || lastClips.find((x) => x.id === c.id)).filter(Boolean)) }, '▶ Clips à la suite') : null,
        k.path ? el('button', { class: 'icon', onclick: () => api(`/api/compilations/${k.id}/reveal`, { method: 'POST' }) }, '📁 Finder') : null,
        k.media_url ? el('a', { href: k.media_url, download: '' }, el('button', { class: 'icon' }, '⬇')) : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'icon danger', onclick: async (e) => {
          const b = e.currentTarget;
          if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Supprimer ?'; b.classList.add('armed'); setTimeout(() => { delete b.dataset.armed; b.textContent = '🗑'; b.classList.remove('armed'); }, 4000); return; }
          await api(`/api/compilations/${k.id}`, { method: 'DELETE' }); loadCompilations();
        } }, '🗑'))))));
  if (list.some((c) => c.status === 'pending' || c.status === 'building')) startCompilPolling();
  return list;
}
renderCompileBar();

// ------------------------------------------------------------------ édition
let editing = null;
function openEdit(c) {
  editing = c;
  $('#edit-title').value = c.title;
  editTags.set(c.tags);
  $('#edit-dialog').showModal();
}
$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#edit-tag-input').value.trim()) editTags.add($('#edit-tag-input').value);
  try {
    await api(`/api/clips/${editing.id}`, { method: 'PUT', body: JSON.stringify({ title: $('#edit-title').value, tags: editTags.get() }) });
    $('#edit-dialog').close();
    await refreshTags(); loadLibrary();
  } catch (err) { alert(err.message); }
});

// ------------------------------------------------------------------ démarrage
(async () => {
  await refreshTags();
  // Reprend les clips en cours / récents dans la file
  const recent = await api('/api/clips');
  recent.slice(0, 8).forEach((c) => queue.set(c.id, c));
  if (queue.size) { $('#section-queue').hidden = false; renderQueue(); startPolling(); }
  if (location.hash === '#library') switchTab('library');
})();
