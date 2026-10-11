(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const loginPanel = $('#loginPanel');
  const appPanel = $('#appPanel');
  const loginForm = $('#loginForm');
  const loginMsg = $('#loginMsg');
  const logoutBtn = $('#logout');
  const fileInput = $('#fileInput');
  const drop = $('#drop');
  const queueEl = $('#queue');
  const actions = $('#queueActions');
  const uploadBtn = $('#uploadBtn');
  const manageEl = $('#manage');
  const manageEmpty = $('#manageEmpty');
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime'];

  let password = '';
  try { password = sessionStorage.getItem('admin-pw') || ''; } catch { /* storage blocked */ }

  let queue = []; // { file, row, titleInput, captionInput, status, bar, removeBtn, state }
  let uploading = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const mb = (bytes) =>
    bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1) + ' MB';

  /* ---------- login ---------- */
  function showApp(on) {
    loginPanel.hidden = on;
    appPanel.hidden = !on;
    logoutBtn.hidden = !on;
  }

  function logout(message) {
    password = '';
    try { sessionStorage.removeItem('admin-pw'); } catch { /* ignore */ }
    showApp(false);
    loginMsg.className = 'msg';
    loginMsg.textContent = message || '';
  }

  async function checkPassword(candidate) {
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'x-admin-password': candidate } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not log in.');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const candidate = $('#password').value;
    loginMsg.className = 'msg';
    loginMsg.textContent = '';
    try {
      await checkPassword(candidate);
      password = candidate;
      try { sessionStorage.setItem('admin-pw', password); } catch { /* ignore */ }
      $('#password').value = '';
      showApp(true);
      refreshManage();
    } catch (err) {
      loginMsg.textContent = err.message === 'Failed to fetch' ? "Can't reach the server. Is it running?" : err.message;
    }
  });

  logoutBtn.addEventListener('click', () => logout('You are logged out.'));

  /* ---------- picking files ---------- */
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', (e) => addFiles(Array.from(e.dataTransfer.files)));

  function addFiles(files) {
    files.forEach((file) => {
      const entry = buildRow(file);
      queue.push(entry);
      queueEl.appendChild(entry.row);
      if (!ALLOWED.includes(file.type)) {
        setFail(entry, "This file type isn't supported. Use JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV.");
      }
    });
    syncActions();
  }

  function buildRow(file) {
    const row = el('li', 'q');
    const isImage = file.type.startsWith('image/');
    let thumb;
    if (isImage) {
      thumb = new Image();
      thumb.className = 'thumb';
      thumb.alt = '';
      thumb.src = URL.createObjectURL(file);
      thumb.addEventListener('load', () => URL.revokeObjectURL(thumb.src), { once: true });
    } else {
      thumb = el('div', 'thumb', 'Video');
    }

    const fields = el('div', 'fields');
    fields.appendChild(el('div', 'fname', file.name + ' (' + mb(file.size) + ')'));
    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.maxLength = 120;
    titleInput.placeholder = 'Title (optional)';
    titleInput.setAttribute('aria-label', 'Title for ' + file.name);
    const captionInput = el('input');
    captionInput.type = 'text';
    captionInput.maxLength = 500;
    captionInput.placeholder = 'Caption (optional)';
    captionInput.setAttribute('aria-label', 'Caption for ' + file.name);
    fields.append(titleInput, captionInput);

    const removeBtn = el('button', 'remove');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', 'Remove ' + file.name + ' from the list');
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';

    const status = el('div', 'status');
    const bar = el('div', 'bar');
    const barFill = el('i');
    bar.appendChild(barFill);
    bar.hidden = true;
    status.appendChild(bar);
    const statusText = el('span');
    status.appendChild(statusText);

    row.append(thumb, fields, removeBtn, status);

    const entry = { file, row, titleInput, captionInput, removeBtn, bar, barFill, statusText, state: 'ready' };
    removeBtn.addEventListener('click', () => {
      queue = queue.filter((q) => q !== entry);
      row.remove();
      syncActions();
    });
    return entry;
  }

  function setFail(entry, message) {
    entry.state = 'fail';
    entry.row.classList.remove('done');
    entry.row.classList.add('fail');
    entry.statusText.textContent = message;
    entry.bar.hidden = true;
  }

  function syncActions() {
    const waiting = queue.filter((q) => q.state === 'ready').length;
    actions.hidden = queue.length === 0;
    uploadBtn.disabled = uploading || waiting === 0;
    uploadBtn.textContent = waiting > 1 ? 'Upload ' + waiting + ' files' : 'Upload';
  }

  $('#clearBtn').addEventListener('click', () => {
    if (uploading) return;
    queue = [];
    queueEl.textContent = '';
    syncActions();
  });

  /* ---------- measure size so the gallery can reserve space ---------- */
  function measure(file) {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const done = (w, h) => { URL.revokeObjectURL(objectUrl); resolve({ w, h }); };
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => done(img.naturalWidth, img.naturalHeight);
        img.onerror = () => done(0, 0);
        img.src = objectUrl;
      } else {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => done(video.videoWidth, video.videoHeight);
        video.onerror = () => done(0, 0);
        video.src = objectUrl;
      }
    });
  }

  /* ---------- upload (one file at a time, with progress) ---------- */
  function send(entry, size) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('title', entry.titleInput.value);
      form.append('caption', entry.captionInput.value);
      if (size.w && size.h) { form.append('w', size.w); form.append('h', size.h); }
      form.append('file', entry.file); // file last

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      xhr.setRequestHeader('x-admin-password', password);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const ratio = e.loaded / e.total;
        entry.barFill.style.transform = 'scaleX(' + ratio + ')';
        entry.statusText.textContent = 'Uploading ' + Math.round(ratio * 100) + '%';
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error(data.error || 'Upload failed.');
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => reject(new Error("Couldn't reach the server. Check your connection and try again."));
      xhr.send(form);
    });
  }

  uploadBtn.addEventListener('click', async () => {
    if (uploading) return;
    uploading = true;
    syncActions();

    for (const entry of queue.filter((q) => q.state === 'ready')) {
      entry.row.classList.remove('fail');
      entry.removeBtn.hidden = true;
      entry.titleInput.disabled = true;
      entry.captionInput.disabled = true;
      entry.bar.hidden = false;
      entry.barFill.style.transform = 'scaleX(0)';
      entry.statusText.textContent = 'Starting...';
      try {
        const size = await measure(entry.file);
        await send(entry, size);
        entry.state = 'done';
        entry.row.classList.add('done');
        entry.barFill.style.transform = 'scaleX(1)';
        entry.statusText.textContent = 'Posted.';
      } catch (err) {
        entry.removeBtn.hidden = false;
        entry.titleInput.disabled = false;
        entry.captionInput.disabled = false;
        if (err.status === 401 || err.status === 429) {
          setFail(entry, err.message);
          uploading = false;
          syncActions();
          return logout(err.message);
        }
        setFail(entry, err.message);
      }
    }

    uploading = false;
    syncActions();
    refreshManage();
  });

  /* ---------- manage existing posts ---------- */
  async function refreshManage() {
    let items = [];
    try {
      const res = await fetch('/api/media', { cache: 'no-cache' });
      items = await res.json();
    } catch {
      manageEmpty.textContent = "Couldn't load your posts. Reload the page.";
      manageEmpty.hidden = false;
      return;
    }
    manageEl.textContent = '';
    manageEmpty.textContent = 'Nothing posted yet.';
    manageEmpty.hidden = items.length > 0;

    items.forEach((it) => {
      const row = el('li', 'm');
      let thumb;
      if (it.type === 'image') {
        thumb = new Image();
        thumb.className = 'thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.src = '/uploads/' + encodeURIComponent(it.file);
      } else {
        thumb = el('div', 'thumb', 'Video');
      }
      const meta = el('div', 'meta');
      meta.appendChild(el('div', 'name', it.title || (it.type === 'video' ? 'Untitled video' : 'Untitled photo')));
      meta.appendChild(el('div', 'when', dateFmt.format(new Date(it.createdAt)) + ', ' + mb(it.size)));
      const del = el('button', 'del', 'Delete');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete ' + (it.title || 'this ' + (it.type === 'video' ? 'video' : 'photo')));
      del.addEventListener('click', async () => {
        if (!window.confirm('Delete this ' + (it.type === 'video' ? 'video' : 'photo') + '? This cannot be undone.')) return;
        del.disabled = true;
        try {
          const res = await fetch('/api/media/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { 'x-admin-password': password } });
          const data = await res.json().catch(() => ({}));
          if (res.status === 401 || res.status === 429) return logout(data.error);
          if (!res.ok) throw new Error(data.error || 'Could not delete.');
          refreshManage();
        } catch (err) {
          del.disabled = false;
          window.alert(err.message);
        }
      });
      row.append(thumb, meta, del);
      manageEl.appendChild(row);
    });
  }

  /* ---------- start ---------- */
  (async () => {
    if (password) {
      try {
        await checkPassword(password);
        showApp(true);
        refreshManage();
        return;
      } catch { logout(''); }
    }
    showApp(false);
  })();
})();
