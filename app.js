'use strict';
const VERSION = '1.0.3'; // bump on every release (also bump CACHE in sw.js)
/* VaultNotes – markdown notes with [[wiki links]], backlinks, offline storage and OneDrive/Dropbox sync. */
const $ = s => document.querySelector(s);
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* ---------- storage (IndexedDB, mirrored in memory) ---------- */
let db;
const notes = new Map(); // path -> {path, content, mtime, rev, dirty, deleted}
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vaultnotes', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('notes', { keyPath: 'path' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (mode, fn) => new Promise((res, rej) => {
  const t = db.transaction('notes', mode); fn(t.objectStore('notes'));
  t.oncomplete = res; t.onerror = () => rej(t.error);
});
const dbPut = n => tx('readwrite', s => s.put(n));
const dbDel = p => tx('readwrite', s => s.delete(p));
async function loadAll() {
  db = await openDb();
  await new Promise(res => {
    const t = db.transaction('notes').objectStore('notes').getAll();
    t.onsuccess = () => { t.result.forEach(n => notes.set(n.path, n)); res(); };
  });
}

/* ---------- helpers ---------- */
const base = p => p.split('/').pop().replace(/\.md$/i, '');
const norm = p => p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
const withMd = p => /\.md$/i.test(p) ? p : p + '.md';
const live = () => [...notes.values()].filter(n => !n.deleted);
const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function resolve(name) {
  const n = name.trim().toLowerCase();
  return live().find(x => x.path.toLowerCase() === withMd(n) || base(x.path).toLowerCase() === n);
}

/* ---------- state ---------- */
let current = null, previewMode = false, saveTimer = null, syncTimer = null;
const openDirs = new Set(lsGet('openDirs', []));

function touch(n) { n.mtime = Date.now(); n.dirty = true; dbPut(n); scheduleSync(); }

async function createNote(path, content = '') {
  path = withMd(norm(path));
  if (!path || path === '.md') return;
  const ex = notes.get(path);
  if (ex && !ex.deleted) { openNote(path); return; }
  const n = { path, content, mtime: Date.now(), rev: ex ? ex.rev : null, dirty: true, deleted: false };
  notes.set(path, n); await dbPut(n); scheduleSync(); openNote(path); renderTree();
}

/* ---------- UI: tree & search ---------- */
function renderTree() {
  const q = $('#search').value.trim().toLowerCase();
  const root = $('#tree'); root.innerHTML = '';
  let list = live().sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  if (q) {
    list = list.filter(n => n.path.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    list.forEach(n => {
      const i = n.content.toLowerCase().indexOf(q);
      const el = item(n, i >= 0 ? n.content.slice(Math.max(0, i - 30), i + 70).replace(/\s+/g, ' ') : '');
      root.append(el);
    });
    if (!list.length) root.innerHTML = '<div class="item" style="color:var(--muted)">No matches</div>';
    return;
  }
  const tree = {};
  list.forEach(n => {
    const parts = n.path.split('/'); let t = tree;
    parts.slice(0, -1).forEach(d => t = (t[d + '/'] ??= {}));
    t[parts.at(-1)] = n;
  });
  (function draw(t, el, prefix) {
    Object.keys(t).sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b)).forEach(k => {
      if (k.endsWith('/')) {
        const d = document.createElement('details'), path = prefix + k;
        d.open = openDirs.has(path);
        d.innerHTML = `<summary>${esc(k.slice(0, -1))}</summary><div class="children"></div>`;
        d.addEventListener('toggle', () => { d.open ? openDirs.add(path) : openDirs.delete(path); lsSet('openDirs', [...openDirs]); });
        draw(t[k], d.querySelector('.children'), path); el.append(d);
      } else el.append(item(t[k]));
    });
  })(tree, root, '');
}
function item(n, snippet) {
  const el = document.createElement('div');
  el.className = 'item' + (current === n.path ? ' active' : '');
  el.innerHTML = `<span class="${n.dirty ? 'dirty' : ''}">${esc(base(n.path))}</span>` + (snippet ? `<small>${esc(snippet)}</small>` : '');
  el.title = n.path;
  el.onclick = () => { openNote(n.path); document.body.classList.remove('menu'); };
  return el;
}

/* ---------- UI: editor / preview / backlinks ---------- */
function openNote(path) {
  flushSave();
  const n = notes.get(path); if (!n || n.deleted) return;
  current = path;
  $('#title').textContent = n.path;
  const ed = $('#editor'); ed.disabled = false; ed.value = n.content;
  if (previewMode) renderPreview();
  renderBacklinks(); renderTree();
}
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; commitEditor(); }
}
function commitEditor() {
  const n = current && notes.get(current); if (!n) return;
  const v = $('#editor').value;
  if (v !== n.content) { n.content = v; touch(n); renderBacklinksSoon(); }
}
$('#editor').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; commitEditor(); renderTree(); }, 500);
});
function renderPreview() {
  const n = current && notes.get(current); if (!n) return;
  const md = n.content.replace(WIKI, (m, t, a) => `[${a || t}](#wiki:${encodeURIComponent(t.trim())})`);
  $('#preview').innerHTML = DOMPurify.sanitize(marked.parse(md, { breaks: true }));
}
$('#preview').addEventListener('click', e => {
  const a = e.target.closest('a'); if (!a) return;
  const h = a.getAttribute('href') || '';
  if (h.startsWith('#wiki:')) {
    e.preventDefault();
    const name = decodeURIComponent(h.slice(6)), t = resolve(name);
    if (t) openNote(t.path); else if (confirm(`Create note "${name}"?`)) createNote(name);
  } else if (/^https?:/.test(h)) { a.target = '_blank'; a.rel = 'noopener'; }
});
$('#btn-mode').onclick = () => {
  commitEditor(); flushSave();
  previewMode = !previewMode;
  $('#preview').classList.toggle('hidden', !previewMode);
  $('#editor').classList.toggle('hidden', previewMode);
  $('#btn-mode').textContent = previewMode ? 'Edit' : 'Preview';
  if (previewMode) renderPreview();
};
let blTimer;
const renderBacklinksSoon = () => { clearTimeout(blTimer); blTimer = setTimeout(renderBacklinks, 600); };
function renderBacklinks() {
  const box = $('#backlinks'); if (!current) { box.classList.add('hidden'); return; }
  const me = base(current).toLowerCase();
  const refs = live().filter(n => n.path !== current && [...n.content.matchAll(WIKI)].some(m => {
    const t = m[1].trim().toLowerCase(); return t === me || t === current.toLowerCase().replace(/\.md$/, '');
  }));
  box.classList.toggle('hidden', !refs.length);
  box.innerHTML = '<h4>Linked from</h4>';
  refs.forEach(n => { const a = document.createElement('a'); a.textContent = base(n.path); a.onclick = () => openNote(n.path); box.append(a); });
}
$('#search').addEventListener('input', renderTree);
$('#btn-new').onclick = () => {
  const dir = current && current.includes('/') ? current.replace(/[^/]*$/, '') : '';
  const p = prompt('New note name (use folder/name to place it in a folder):', dir); if (p) createNote(p);
  document.body.classList.remove('menu');
};
$('#btn-rename').onclick = async () => {
  const n = current && notes.get(current); if (!n) return;
  flushSave();
  const p = prompt('New name / path:', n.path.replace(/\.md$/, '')); if (!p) return;
  const np = withMd(norm(p)); if (np === n.path) return;
  if (live().some(x => x.path === np)) { alert('A note with that name already exists.'); return; }
  const old = n.path, content = n.content;
  if (n.rev) { n.deleted = true; n.dirty = true; await dbPut(n); } else { notes.delete(old); await dbDel(old); }
  const ex = notes.get(np);
  const nn = { path: np, content, mtime: Date.now(), rev: ex ? ex.rev : null, dirty: true, deleted: false };
  notes.set(np, nn); await dbPut(nn); scheduleSync(); openNote(np);
};
$('#btn-delete').onclick = async () => {
  const n = current && notes.get(current); if (!n || !confirm(`Delete "${n.path}"? This also deletes it from the cloud on next sync.`)) return;
  clearTimeout(saveTimer); saveTimer = null;
  if (n.rev) { n.deleted = true; n.dirty = true; await dbPut(n); } else { notes.delete(n.path); await dbDel(n.path); }
  current = null; $('#editor').value = ''; $('#editor').disabled = true; $('#title').textContent = 'No note open';
  $('#backlinks').classList.add('hidden'); renderTree(); scheduleSync();
};
$('#btn-menu').onclick = () => document.body.classList.add('menu');
$('#scrim').onclick = () => document.body.classList.remove('menu');
window.addEventListener('beforeunload', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); else scheduleSync(2000); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#btn-new').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#btn-mode').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
});

/* ---------- OAuth (PKCE) ---------- */
const PROVIDERS = {
  onedrive: {
    name: 'OneDrive',
    authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    scope: 'Files.ReadWrite offline_access',
    extra: {},
  },
  dropbox: {
    name: 'Dropbox',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scope: '',
    extra: { token_access_type: 'offline' },
  },
};
const redirectUri = () => location.origin + location.pathname;
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cfg = () => lsGet('syncCfg', { provider: 'none', clientId: '', root: '' });
const tok = () => lsGet('syncTok', null);

async function startAuth() {
  const c = cfg(), P = PROVIDERS[c.provider];
  if (!P || !c.clientId) { alert('Choose a provider and enter the client ID first.'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('oauth', JSON.stringify({ verifier, state }));
  const p = new URLSearchParams({
    client_id: c.clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge: challenge, code_challenge_method: 'S256', state, ...P.extra,
  });
  if (P.scope) p.set('scope', P.scope);
  location.href = P.authUrl + '?' + p;
}
async function tokenRequest(params) {
  const c = cfg(), P = PROVIDERS[c.provider];
  const r = await fetch(P.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'Token request failed');
  const old = tok() || {};
  lsSet('syncTok', { access: j.access_token, refresh: j.refresh_token || old.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 });
}
async function finishAuth() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  const saved = JSON.parse(sessionStorage.getItem('oauth') || 'null');
  history.replaceState(null, '', redirectUri());
  if (q.has('error')) { alert('Sign-in failed: ' + (q.get('error_description') || q.get('error'))); return; }
  if (!saved || saved.state !== q.get('state')) { alert('Sign-in state mismatch; please try again.'); return; }
  sessionStorage.removeItem('oauth');
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: saved.verifier });
    setStatus('Connected. Syncing…'); sync();
  } catch (e) { alert('Sign-in failed: ' + e.message); }
}
async function accessToken() {
  let t = tok(); if (!t) throw new Error('Not connected');
  if (t.exp - 60000 < Date.now()) {
    if (!t.refresh) throw new Error('Session expired – reconnect in Settings');
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
    t = tok();
  }
  return t.access;
}

/* ---------- providers ---------- */
const trim = s => (s || '').replace(/^\/+|\/+$/g, '');
const join = (...p) => p.filter(Boolean).join('/');
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const hidden = p => p.split('/').some(s => s.startsWith('.'));

const OneDrive = {
  async api(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + await accessToken(), ...(opt.headers || {}) } });
    if (!r.ok && r.status !== 404) throw new Error(`OneDrive ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return r;
  },
  full: p => join(trim(cfg().root), p),
  async list() {
    const root = trim(cfg().root), out = [], G = 'https://graph.microsoft.com/v1.0/me/drive/';
    const sel = '$top=200&$select=id,name,eTag,folder,file';
    const walk = async rel => {
      const p = join(root, rel);
      let url = G + (p ? `root:/${encPath(p)}:/children?` : 'root/children?') + sel;
      while (url) {
        const r = await this.api(url);
        if (r.status === 404) { if (!rel) return; throw new Error('Folder missing: ' + p); }
        const j = await r.json();
        for (const it of j.value) {
          if (it.name.startsWith('.')) continue;
          const rp = join(rel, it.name);
          if (it.folder) await walk(rp);
          else if (/\.md$/i.test(it.name)) {
            const id = it.id;
            out.push({ path: rp, rev: it.eTag, read: async () => {
              const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}/content`, { headers: { Authorization: 'Bearer ' + await accessToken() } });
              if (!r.ok) throw new Error('OneDrive download failed ' + r.status);
              return r.text();
            } });
          }
        }
        url = j['@odata.nextLink'];
      }
    };
    await walk('');
    return out;
  },
  async write(path, text) {
    const r = await this.api(`https://graph.microsoft.com/v1.0/me/drive/root:/${encPath(this.full(path))}:/content`, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: text,
    });
    if (r.status === 404) throw new Error('Upload failed (folder not found)');
    return (await r.json()).eTag;
  },
  async remove(path) { await this.api(`https://graph.microsoft.com/v1.0/me/drive/root:/${encPath(this.full(path))}`, { method: 'DELETE' }); },
};

const asciiJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
const Dropbox = {
  async rpc(endpoint, body) {
    const r = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); const e = new Error(`Dropbox ${r.status}: ${t.slice(0, 150)}`); e.notFound = /not_found/.test(t); throw e; }
    return r.json();
  },
  full: p => '/' + join(trim(cfg().root), p),
  async list() {
    const root = trim(cfg().root), out = [];
    let j;
    try { j = await this.rpc('files/list_folder', { path: root ? '/' + root : '', recursive: true, limit: 2000 }); }
    catch (e) { if (e.notFound) return []; throw e; }
    for (;;) {
      for (const it of j.entries) {
        if (it['.tag'] !== 'file' || !/\.md$/i.test(it.name)) continue;
        let rel = it.path_display;
        if (root) rel = rel.slice(('/' + root).length);
        rel = trim(rel); if (hidden(rel)) continue;
        out.push({ path: rel, rev: it.rev, read: () => this.read(it.id) });
      }
      if (!j.has_more) break;
      j = await this.rpc('files/list_folder/continue', { cursor: j.cursor });
    }
    return out;
  },
  async read(id) {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Dropbox-API-Arg': asciiJson({ path: id }) },
    });
    if (!r.ok) throw new Error('Dropbox download failed ' + r.status);
    return r.text();
  },
  async write(path, text) {
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiJson({ path: this.full(path), mode: 'overwrite', mute: true }) },
      body: text,
    });
    if (!r.ok) throw new Error('Dropbox upload failed ' + r.status + ' ' + (await r.text()).slice(0, 800));
    return (await r.json()).rev;
  },
  async remove(path) { try { await this.rpc('files/delete_v2', { path: this.full(path) }); } catch (e) { if (!e.notFound) throw e; } },
};
const provider = () => ({ onedrive: OneDrive, dropbox: Dropbox }[cfg().provider]);

/* ---------- sync ---------- */
let syncing = false, again = false;
let lastError = '';
function setStatus(s) { $('#status').textContent = s; }
$('#status').addEventListener('click', () => { if (lastError) prompt('Sync error details (copy this):', lastError); });
function scheduleSync(ms = 4000) {
  if (!provider() || !tok()) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms);
}
function conflictPath(p) {
  const d = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  let c = p.replace(/\.md$/i, '') + ` (conflict ${d}).md`, i = 2;
  while (notes.has(c)) c = p.replace(/\.md$/i, '') + ` (conflict ${d}-${i++}).md`;
  return c;
}
async function sync() {
  const P = provider(); if (!P || !tok()) return;
  if (syncing) { again = true; return; }
  syncing = true; setStatus('Syncing…');
  try {
    flushSave();
    const remote = await P.list();
    const rmap = new Map(remote.filter(r => !hidden(r.path)).map(r => [r.path, r]));
    for (const n of [...notes.values()]) {
      const r = rmap.get(n.path);
      if (n.deleted) {
        if (r) await P.remove(n.path);
        notes.delete(n.path); await dbDel(n.path); continue;
      }
      if (!r) {
        if (n.rev && !n.dirty) { notes.delete(n.path); await dbDel(n.path); if (current === n.path) closeCurrent(); continue; }
        const snap = n.content; n.rev = await P.write(n.path, snap);
        if (n.content === snap) n.dirty = false; await dbPut(n);
      } else if (r.rev !== n.rev) {
        if (n.dirty) {
          const cp = conflictPath(n.path);
          const cn = { path: cp, content: n.content, mtime: Date.now(), rev: null, dirty: true, deleted: false };
          notes.set(cp, cn); await dbPut(cn);
        }
        const text = await r.read();
        n.content = text; n.rev = r.rev; n.dirty = false; n.mtime = Date.now(); await dbPut(n);
        if (current === n.path && document.activeElement !== $('#editor')) { $('#editor').value = text; if (previewMode) renderPreview(); }
      } else if (n.dirty) {
        const snap = n.content; n.rev = await P.write(n.path, snap);
        if (n.content === snap) n.dirty = false; await dbPut(n);
      }
    }
    for (const r of rmap.values()) {
      if (notes.has(r.path)) continue;
      const n = { path: r.path, content: await r.read(), mtime: Date.now(), rev: r.rev, dirty: false, deleted: false };
      notes.set(n.path, n); await dbPut(n);
    }
    setStatus(`${PROVIDERS[cfg().provider].name}: synced ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    console.error(e); lastError = e.message; setStatus('Sync error (tap here for details)');
  } finally {
    syncing = false; renderTree(); renderBacklinks();
    if (again) { again = false; scheduleSync(1000); }
  }
}
function closeCurrent() {
  current = null; $('#editor').value = ''; $('#editor').disabled = true; $('#title').textContent = 'No note open';
}
setInterval(() => { if (!document.hidden) scheduleSync(0); }, 120000);

/* ---------- settings dialog ---------- */
const dlg = $('#settings');
function fillSettings() {
  const c = cfg();
  $('#s-provider').value = c.provider; $('#s-client').value = c.clientId; $('#s-root').value = c.root;
  $('#s-redirect').textContent = redirectUri();
  $('#s-conn').textContent = tok() ? `Connected to ${PROVIDERS[c.provider]?.name || ''}.` : 'Not connected.';
}
$('#btn-settings').onclick = () => { fillSettings(); dlg.showModal(); };
$('#s-connect').onclick = () => {
  lsSet('syncCfg', { provider: $('#s-provider').value, clientId: $('#s-client').value.trim(), root: $('#s-root').value.trim() });
  localStorage.removeItem('syncTok'); startAuth();
};
$('#s-sync').onclick = () => { lsSet('syncCfg', { provider: $('#s-provider').value, clientId: $('#s-client').value.trim(), root: $('#s-root').value.trim() }); dlg.close(); sync(); };
$('#s-disconnect').onclick = () => { localStorage.removeItem('syncTok'); setStatus('Local only'); fillSettings(); };
$('#s-export').onclick = () => {
  const blob = new Blob([JSON.stringify(live().map(({ path, content }) => ({ path, content })), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'vaultnotes-export.json'; a.click();
};

/* ---------- boot ---------- */
$('#ver').textContent = 'v' + VERSION;
$('#s-ver').textContent = 'Version ' + VERSION;
(async function boot() {
  await loadAll();
  if (!lsGet('fixV2', false)) {
    for (const n of notes.values()) if (n.rev && !n.dirty && /<title>Page not found/i.test(n.content)) { n.rev = null; await dbPut(n); }
    lsSet('fixV2', true);
  }
  if (!notes.size) {
    await createNote('Welcome', '# Welcome to VaultNotes\n\nMarkdown notes that work offline and sync with OneDrive or Dropbox.\n\n- Link notes with [[Double brackets]] — click them in **Preview**.\n- Use the search box (Ctrl+K) to find text in any note.\n- Open ⚙ to connect your cloud folder.\n');
  } else {
    const last = lsGet('last', null); openNote(notes.has(last) && !notes.get(last).deleted ? last : live()[0]?.path);
  }
  renderTree();
  await finishAuth();
  setStatus(tok() && provider() ? 'Connected' : 'Local only');
  scheduleSync(500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
window.addEventListener('pagehide', () => lsSet('last', current));
