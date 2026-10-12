(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const grid = $('#grid');
  const stateEl = $('#state');
  const tallyEl = $('#tally');
  const hero = $('#top');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canHover = matchMedia('(hover: hover)').matches;
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  let items = [];
  let visible = [];
  let filter = 'all';

  const url = (it) => it.url || (String(it.file || '').startsWith('http') ? it.file : '/uploads/' + encodeURIComponent(it.file));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  /* ---------- load ---------- */
  async function load() {
    try {
      const res = await fetch('/api/media', { cache: 'no-cache' });
      if (!res.ok) throw new Error('bad status');
      if (!res.ok) throw new Error('bad status');
      items = await res.json();
      if (!Array.isArray(items)) throw new Error('invalid gallery response');
    } catch {
      stateEl.textContent = "Couldn't load the gallery. Check your connection and reload the page.";
      return;
    }
    renderTally();
    renderGrid();
  }

  function renderTally() {
    const photos = items.filter((i) => i.type === 'image').length;
    const videos = items.length - photos;
    const parts = [];
    if (photos) parts.push(photos + (photos === 1 ? ' photo' : ' photos'));
    if (videos) parts.push(videos + (videos === 1 ? ' video' : ' videos'));
    tallyEl.textContent = parts.join(' and ');
  }

  /* ---------- hero film strips ---------- */
  function renderReel(pool) {
    const photos = pool || [];
    ['track1', 'track2'].forEach((id, row) => {
      const track = document.getElementById(id);
      track.textContent = '';
      const count = 8;
      for (let n = 0; n < count; n++) {
        const frame = el('div', 'f');
        if (photos.length) {
          const img = new Image();
          img.src = url(photos[(n + row * 3) % photos.length]);
          img.alt = '';
          img.decoding = 'async';
          img.loading = n < 4 ? 'eager' : 'lazy';
          frame.appendChild(img);
        } else {
          frame.appendChild(el('div', 'ph'));
        }
        track.appendChild(frame);
      }
      // duplicate so the loop (translate -50%) is seamless
      Array.from(track.children).forEach((child) => track.appendChild(child.cloneNode(true)));
    });
  }

  /* ---------- grid ---------- */
  function renderGrid() {
    visible = items.filter((i) => filter === 'all' || i.type === filter);
    grid.textContent = '';
    stateEl.textContent = '';

    if (!items.length) {
      stateEl.textContent = 'Nothing posted yet. Check back soon.';
      return;
    }
    if (!visible.length) {
      stateEl.textContent = filter === 'image' ? 'No photos yet.' : 'No videos yet.';
      return;
    }

    const frag = document.createDocumentFragment();
    visible.forEach((it, idx) => frag.appendChild(buildTile(it, idx)));
    grid.appendChild(frag);
  }

  function buildTile(it, idx) {
    const fig = el('figure', 'item');
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.id = it.id;
    tile.setAttribute('aria-label', 'Open ' + (it.title || (it.type === 'video' ? 'video' : 'photo')));
    tile.style.aspectRatio = it.w && it.h ? it.w + ' / ' + it.h : '4 / 3';

    let media;
    const markLoaded = () => tile.classList.add('loaded');

    if (it.type === 'image') {
      media = new Image();
      media.alt = it.title || '';
      media.decoding = 'async';
      media.loading = idx < 6 ? 'eager' : 'lazy';
      media.addEventListener('load', markLoaded);
      media.src = url(it);
      if (media.complete && media.naturalWidth) markLoaded();
    } else {
      media = document.createElement('video');
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.setAttribute('aria-hidden', 'true');
      media.addEventListener('loadeddata', markLoaded);
      media.src = url(it) + '#t=0.1';
      if (canHover) {
        tile.addEventListener('pointerenter', () => media.play().catch(() => {}));
        tile.addEventListener('pointerleave', () => media.pause());
      }
      const badge = el('span', 'badge');
      badge.innerHTML = PLAY_ICON + '<span>Video</span>';
      tile.appendChild(media);
      tile.appendChild(badge);
    }
    if (it.type === 'image') tile.appendChild(media);

    if (it.title) tile.appendChild(el('span', 'cap', it.title));

    tile.addEventListener('click', () => openViewer(idx, tile));
    fig.appendChild(tile);
    return fig;
  }

  /* filters */
  document.querySelectorAll('.filters button').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      document.querySelectorAll('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderGrid();
    });
  });

  /* pause the hero strips when they are off screen */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => hero.classList.toggle('off', !entry.isIntersecting)).observe(hero);
  }

  /* ---------- viewer ---------- */
  const lb = $('#lb');
  const lbBg = $('#lbBg');
  const lbTop = $('#lbTop');
  const lbStage = $('#lbStage');
  const lbCap = $('#lbCap');
  const lbPrev = $('#lbPrev');
  const lbNext = $('#lbNext');
  const lbClose = $('#lbClose');
  const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

  let current = -1;
  let mediaEl = null;
  let mediaW = 1600;
  let mediaH = 900;
  let opener = null;
  let busy = false;

  function tileFor(index) {
    const it = visible[index];
    return it ? grid.querySelector('[data-id="' + CSS.escape(it.id) + '"]') : null;
  }

  function fit() {
    if (!mediaEl) return;
    const box = lbStage.getBoundingClientRect();
    const scale = Math.min((box.width - 24) / mediaW, (box.height - 8) / mediaH);
    mediaEl.style.width = Math.floor(mediaW * scale) + 'px';
    mediaEl.style.height = Math.floor(mediaH * scale) + 'px';
  }

  function stopMedia(node) {
    if (node && node.tagName === 'VIDEO') {
      node.pause();
      node.removeAttribute('src');
      node.load();
    }
  }

  async function mount(index, direction, origin) {
    const it = visible[index];
    if (!it) return;
    current = index;

    let node;
    if (it.type === 'image') {
      node = new Image();
      node.alt = it.title || '';
      node.decoding = 'async';
      node.src = url(it);
    } else {
      node = document.createElement('video');
      node.controls = true;
      node.playsInline = true;
      node.autoplay = true;
      node.src = url(it);
    }
    node.className = 'lb-media';

    mediaW = it.w || 0;
    mediaH = it.h || 0;
    if (!(mediaW && mediaH)) {
      if (it.type === 'image') {
        try { await node.decode(); } catch { /* use fallback size */ }
        mediaW = node.naturalWidth || 1600;
        mediaH = node.naturalHeight || 900;
      } else {
        mediaW = 1600;
        mediaH = 900;
        node.addEventListener('loadedmetadata', () => {
          if (node.videoWidth) { mediaW = node.videoWidth; mediaH = node.videoHeight; fit(); }
        }, { once: true });
      }
    }

    const old = mediaEl;
    mediaEl = node;
    stopMedia(old);
    lbStage.textContent = '';
    lbStage.appendChild(node);
    fit();

    $('#lbCount').textContent = index + 1 + ' of ' + visible.length;
    $('#lbTitle').textContent = it.title || '';
    $('#lbText').textContent = it.caption || '';
    $('#lbDate').textContent = it.createdAt ? dateFmt.format(new Date(it.createdAt)) : '';
    lbPrev.hidden = visible.length < 2;
    lbNext.hidden = visible.length < 2;

    if (reduce) return;

    if (origin) {
      // grow out of the thumbnail
      const from = origin.getBoundingClientRect();
      const to = node.getBoundingClientRect();
      if (to.width && from.width) {
        node.animate(
          [
            { transformOrigin: 'top left', transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + from.width / to.width + ',' + from.height / to.height + ')' },
            { transformOrigin: 'top left', transform: 'none' },
          ],
          { duration: 460, easing: EASE }
        );
      }
    } else if (direction) {
      node.animate(
        [{ opacity: 0, transform: 'translate3d(' + direction * 56 + 'px,0,0)' }, { opacity: 1, transform: 'none' }],
        { duration: 280, easing: EASE }
      );
    }
  }

  function chrome() {
    return [lbBg, lbTop, lbCap, lbPrev, lbNext];
  }

  function openViewer(index, originTile) {
    if (busy) return;
    opener = originTile || null;
    lb.hidden = false;
    document.documentElement.classList.add('lb-open');
    chrome().forEach((n) => n.getAnimations().forEach((a) => a.cancel()));
    if (!reduce) {
      lbBg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
      [lbTop, lbCap, lbPrev, lbNext].forEach((n) => n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 160, fill: 'backwards' }));
    }
    mount(index, 0, originTile);
    lbClose.focus({ preventScroll: true });
  }

  function step(direction) {
    if (visible.length < 2) return;
    const next = (current + direction + visible.length) % visible.length;
    mount(next, direction, null);
  }

  function closeViewer() {
    if (lb.hidden || busy) return;
    const node = mediaEl;
    const target = tileFor(current);
    const finish = () => {
      busy = false;
      stopMedia(node);
      mediaEl = null;
      lbStage.textContent = '';
      lb.hidden = true;
      document.documentElement.classList.remove('lb-open');
      const back = tileFor(current) || opener;
      if (back) back.focus({ preventScroll: true });
    };

    if (node && node.pause) node.pause();

    const rect = target ? target.getBoundingClientRect() : null;
    const onScreen = rect && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    if (reduce || !onScreen || !node) return finish();

    busy = true;
    const now = node.getBoundingClientRect();
    chrome().forEach((n) => n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }));
    const anim = node.animate(
      [
        { transformOrigin: 'top left', transform: 'none' },
        { transformOrigin: 'top left', transform: 'translate(' + (rect.left - now.left) + 'px,' + (rect.top - now.top) + 'px) scale(' + rect.width / now.width + ',' + rect.height / now.height + ')' },
      ],
      { duration: 360, easing: EASE, fill: 'forwards' }
    );
    anim.finished.then(finish, finish);
  }

  lbClose.addEventListener('click', closeViewer);
  lbPrev.addEventListener('click', () => step(-1));
  lbNext.addEventListener('click', () => step(1));
  lbBg.addEventListener('click', closeViewer);
  lbStage.addEventListener('click', (e) => { if (e.target === lbStage) closeViewer(); });
  window.addEventListener('resize', fit);

  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    const onVideo = e.target && e.target.tagName === 'VIDEO';
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft' && !onVideo) step(-1);
    else if (e.key === 'ArrowRight' && !onVideo) step(1);
    else if (e.key === 'Tab') {
      const stops = Array.from(lb.querySelectorAll('button:not([hidden]), video')).filter((n) => !n.closest('[hidden]'));
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* swipe left or right to move between items */
  let startX = null;
  let startY = 0;
  lbStage.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'VIDEO') return;
    startX = e.clientX;
    startY = e.clientY;
  });
  lbStage.addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    startX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  lbStage.addEventListener('pointercancel', () => { startX = null; });

  /* ---------- go ---------- */
  renderReel();
  load().then(() => {
    const photos = items.filter((i) => i.type === 'image').slice(0, 12);
    if (photos.length) renderReel(photos);
  });
})();
