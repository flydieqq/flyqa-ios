// ============================================================
//  flyqa — Senior Fullstack Music Application Controller
// ============================================================

// Dynamic Backend URL: optional user-configured server (stored in LocalStorage),
// never blindly calling localhost on a real iPhone.
function getCustomBackendApi() {
  try {
    const saved = (localStorage.getItem('flyqa_api_url') || '').trim().replace(/\/+$/, '');
    if (saved) return saved.endsWith('/api') ? saved : `${saved}/api`;
  } catch (e) {}
  if (window.location && window.location.protocol.startsWith('http') &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
      window.location.port === '3456') {
    return `${window.location.origin}/api`;
  }
  return '';
}

function ensureHttpsUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1') && !/^http:\/\/192\.168\.|^http:\/\/10\.|^http:\/\/172\./.test(url)) {
    return 'https://' + url.slice(7);
  }
  return url;
}

function isDirectAudioUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/youtube\.com\/watch|youtu\.be\/|soundcloud\.com\//i.test(url)) return false;
  return true;
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Application State
const state = {
  currentView: 'search',
  playlists: [],
  currentPlaylistId: null,
  currentPlaylistMeta: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  currentTrack: null,
  volume: window.storageManager.getSetting('volume') || 0.8,
  searchDebounce: null,
  repeatMode: window.storageManager.getSetting('repeatMode') || 'off' // 'off' | 'all' | 'one'
};

// In-memory performance caches (avoid redundant network calls & canvas pixel scans)
const searchCache = new Map();
const colorCache = new Map();

// DOM Refs
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const primaryAudio = $('#audio-element');
const hlsAudio = $('#audio-hls-element');
let audio = primaryAudio;
window.flyqaGetActiveAudio = () => audio;
const bgCanvas = $('#bg-canvas');

// ============================================================
//  1. Window Controls (Frameless Electron IPC)
// ============================================================
if (window.electronAPI) {
  $('#btn-minimize')?.addEventListener('click', () => window.electronAPI.minimize());
  $('#btn-maximize')?.addEventListener('click', () => window.electronAPI.maximize());
  $('#btn-close')?.addEventListener('click', () => window.electronAPI.close());
}

// ============================================================
//  2. Navigation & View Switching
// ============================================================
const VIEW_ORDER = ['search', 'mobile-playlists', 'playlist', 'queue', 'local', 'equalizer', 'visualizer', 'settings'];

function switchView(viewName, playlistId = null) {
  window.flyqaIOS?.closeAllOverlays?.();

  const prevView = state.currentView;
  const prevIdx = VIEW_ORDER.indexOf(prevView);
  const nextIdx = VIEW_ORDER.indexOf(viewName);
  const slideDir = (prevIdx !== -1 && nextIdx !== -1 && nextIdx !== prevIdx)
    ? (nextIdx > prevIdx ? 'slide-from-right' : 'slide-from-left')
    : 'slide-from-bottom';

  // Update sidebar active states
  $$('.sidebar-item').forEach(el => el.classList.remove('active'));
  $$('.playlist-item').forEach(el => el.classList.remove('active'));

  const navBtn = $(`[data-view="${viewName}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Hide all views & reset directional classes
  $$('.view').forEach(v => v.classList.remove('active', 'slide-from-right', 'slide-from-left', 'slide-from-bottom'));

  if (viewName === 'playlist' && playlistId) {
    state.currentPlaylistId = playlistId;
    state.currentView = 'playlist';
    $('#view-playlist')?.classList.add('active');
    loadPlaylistTracks(playlistId);

    const playlistBtn = document.querySelector(`.playlist-item[data-id="${playlistId}"]`);
    if (playlistBtn) playlistBtn.classList.add('active');
  } else {
    state.currentView = viewName;
    $(`#view-${viewName}`)?.classList.add('active');

    if (viewName === 'queue') {
      updateQueueView();
    } else if (viewName === 'equalizer') {
      renderEqualizerUI();
    } else if (viewName === 'visualizer') {
      requestAnimationFrame(() => window.audioVisualizer?.resize());
      setTimeout(() => window.audioVisualizer?.resize(), 120);
    }
  }

  window.flyqaIOS?.syncTabBar?.(viewName);

  // Smooth GPU-accelerated Slide & Fade animation (no blur filter glitches on iOS)
  const activeView = $('.view.active');
  if (activeView && !window.storageManager.getSetting('reduceMotion')) {
    void activeView.offsetWidth; // force reflow for clean restart
    activeView.classList.add(slideDir);
    setTimeout(() => activeView.classList.remove(slideDir), 460);
  }
}

// Navigation Listeners
$('#nav-search')?.addEventListener('click', () => switchView('search'));
$('#nav-queue')?.addEventListener('click', () => switchView('queue'));
$('#nav-local')?.addEventListener('click', () => switchView('local'));
$('#nav-equalizer')?.addEventListener('click', () => switchView('equalizer'));
$('#nav-visualizer')?.addEventListener('click', () => switchView('visualizer'));
$('#nav-settings')?.addEventListener('click', () => switchView('settings'));

// Quick player bar & EQ shortcuts
$('#btn-quick-eq')?.addEventListener('click', () => switchView('equalizer'));
$('#btn-quick-vis')?.addEventListener('click', () => switchView('visualizer'));
$('#btn-eq-open-vis')?.addEventListener('click', () => switchView('visualizer'));

// ============================================================
//  3. Search (YouTube with In-Memory Cache)
// ============================================================
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const searchSpinner = $('#search-spinner');

searchInput?.addEventListener('input', () => {
  clearTimeout(state.searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 64 64" opacity="0.3"><circle cx="28" cy="28" r="18" stroke="currentColor" stroke-width="3" fill="none"/><path d="M42 42l16 16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
        <p>Введите запрос для поиска музыки</p>
      </div>`;
    return;
  }
  state.searchDebounce = setTimeout(() => performSearch(q), 420);
});

searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(state.searchDebounce);
    const q = searchInput.value.trim();
    if (q) performSearch(q);
  }
});

const INVIDIOUS_CORS_INSTANCES = [
  'https://yt.chocolatemoo53.com'
];

const INVIDIOUS_NATIVE_INSTANCES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.materialio.us',
  'https://invidious.io.lol',
  'https://inv.nadeko.net'
];

const PIPED_CORS_INSTANCES = [
  'https://api.piped.private.coffee'
];

const PIPED_NATIVE_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks'
];

function isNativeCapacitor() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

// Safe JSON fetch with timeout; avoids AbortSignal issues with CapacitorHttp on iOS
async function fetchJsonWithTimeout(url, timeoutMs = 3500, extraHeaders = {}) {
  const isNativeCap = isNativeCapacitor();
  const headers = { 'Accept': 'application/json', ...extraHeaders };

  if (isNativeCap) {
    let timer = null;
    try {
      const fetchPromise = fetch(url, { headers }).then(async (res) => {
        if (!res.ok) return null;
        try { return await res.json(); } catch (e) { return null; }
      }).catch(() => null);
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let scClientId = 'Hpp4j7peQTPimFlKMjTX3y3mK2946b7y';

async function refreshSoundCloudClientId() {
  if (!isNativeCapacitor()) return scClientId;
  try {
    const res = await fetch('https://soundcloud.com/discover');
    if (!res.ok) return scClientId;
    const html = await res.text();
    const scriptMatches = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g)].map(m => m[0]);
    for (const sUrl of scriptMatches.slice(-4)) {
      const sr = await fetch(sUrl);
      if (!sr.ok) continue;
      const js = await sr.text();
      const cm = js.match(/client_id:"([a-zA-Z0-9]{20,40})"/);
      if (cm && cm[1]) {
        scClientId = cm[1];
        return scClientId;
      }
    }
  } catch (e) {}
  return scClientId;
}

function pickBestSaavnStream(downloadUrlList) {
  if (!Array.isArray(downloadUrlList) || !downloadUrlList.length) return '';
  // Prefer 160kbps (fast, Range-friendly, ACAO:*), then 96kbps, then 320kbps, then last available
  const order = ['160kbps', '96kbps', '320kbps', '48kbps'];
  for (const q of order) {
    const found = downloadUrlList.find(d => d.quality === q && d.url);
    if (found) return ensureHttpsUrl(found.url);
  }
  return ensureHttpsUrl(downloadUrlList[downloadUrlList.length - 1]?.url || '');
}

async function fetchSaavnDirect(query, limit = 15) {
  const q = encodeURIComponent(query);
  const data = await fetchJsonWithTimeout(
    `https://saavn.sumit.co/api/search/songs?query=${q}&limit=${limit}`,
    4000
  );
  if (!data || !data.data || !Array.isArray(data.data.results)) return [];
  const tracks = [];
  for (const item of data.data.results) {
    const durSec = Number(item.duration || 0);
    // Reject <45s snippets; require full-length tracks
    if (durSec > 0 && durSec < 45) continue;
    const streamUrl = pickBestSaavnStream(item.downloadUrl);
    if (!streamUrl) continue;
    const art = item.image?.[item.image.length - 1]?.url || item.image?.[0]?.url || '';
    const artist = item.artists?.primary?.map(a => a.name).filter(Boolean).join(', ')
      || item.artists?.all?.[0]?.name
      || 'Unknown Artist';
    tracks.push({
      videoId: `sv_${item.id}`,
      title: decodeHtmlEntities(item.name || 'Unknown Title'),
      artist: decodeHtmlEntities(artist),
      duration: durSec ? formatTime(durSec) : '',
      thumbnail: ensureHttpsUrl(art),
      source: 'saavn',
      webpageUrl: streamUrl
    });
  }
  return tracks;
}

async function fetchSoundCloudSearch(query, limit = 12) {
  if (!isNativeCapacitor()) return [];
  const q = encodeURIComponent(query);
  let data = await fetchJsonWithTimeout(
    `https://api-v2.soundcloud.com/search/tracks?q=${q}&client_id=${encodeURIComponent(scClientId)}&limit=${limit}`,
    3500
  );
  if (!data || !Array.isArray(data.collection)) {
    await refreshSoundCloudClientId();
    data = await fetchJsonWithTimeout(
      `https://api-v2.soundcloud.com/search/tracks?q=${q}&client_id=${encodeURIComponent(scClientId)}&limit=${limit}`,
      3500
    );
  }
  if (!data || !Array.isArray(data.collection)) return [];

  const tracks = [];
  for (const item of data.collection) {
    const durSec = Math.round((item.duration || 0) / 1000);
    // Strictly reject 30s Go+ previews (policy === 'SNIP' or short snippets < 45s)
    if (item.policy === 'SNIP' || durSec < 45) continue;
    const transcodings = item.media?.transcodings || [];
    const chosen = transcodings.find(x => x.format?.protocol === 'progressive' && x.url)
      || transcodings.find(x => x.format?.protocol === 'hls' && /mp4|aac/i.test(x.format?.mime_type || '') && x.url)
      || transcodings.find(x => x.format?.protocol === 'hls' && x.url);
    if (!chosen) continue;

    const art = (item.artwork_url || item.user?.avatar_url || '').replace('-large.', '-t500x500.');
    tracks.push({
      videoId: `sc_${item.id}`,
      title: item.title || 'Unknown Title',
      artist: item.user?.username || 'SoundCloud Artist',
      duration: formatTime(durSec),
      thumbnail: ensureHttpsUrl(art),
      source: 'soundcloud',
      scTranscodingUrl: chosen.url,
      scTrackAuth: item.track_authorization || '',
      webpageUrl: ensureHttpsUrl(item.permalink_url || '')
    });
  }
  return tracks;
}

async function resolveSoundCloudStreamUrl(track) {
  if (!track || !track.scTranscodingUrl || !isNativeCapacitor()) return '';
  const sep = track.scTranscodingUrl.includes('?') ? '&' : '?';
  const authPart = track.scTrackAuth ? `&track_authorization=${encodeURIComponent(track.scTrackAuth)}` : '';
  const data = await fetchJsonWithTimeout(
    `${track.scTranscodingUrl}${sep}client_id=${encodeURIComponent(scClientId)}${authPart}`,
    3500
  );
  return data && data.url ? ensureHttpsUrl(data.url) : '';
}

async function fetchInvidiousSearch(query) {
  const q = encodeURIComponent(query);
  const pool = isNativeCapacitor() ? INVIDIOUS_NATIVE_INSTANCES : INVIDIOUS_CORS_INSTANCES;
  // Query instances in parallel and pick first valid non-empty response
  const attempts = pool.map(async (base) => {
    const data = await fetchJsonWithTimeout(`${base}/api/v1/search?q=${q}&type=video`, 3000);
    if (!Array.isArray(data) || !data.length) throw new Error('empty');
    const tracks = [];
    for (const item of data.slice(0, 12)) {
      if (!item.videoId || item.liveNow) continue;
      if (item.lengthSeconds && item.lengthSeconds < 45) continue;
      const thumb = item.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
      tracks.push({
        videoId: item.videoId,
        title: item.title || 'Unknown Title',
        artist: item.author || 'YouTube Music',
        duration: item.lengthSeconds ? formatTime(item.lengthSeconds) : '',
        thumbnail: ensureHttpsUrl(thumb),
        source: 'invidious',
        instanceBase: base,
        webpageUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`
      });
    }
    if (!tracks.length) throw new Error('no-tracks');
    return tracks;
  });

  try {
    return await Promise.any(attempts);
  } catch (e) {
    return [];
  }
}

async function fetchPipedSearch(query) {
  const q = encodeURIComponent(query);
  const pool = isNativeCapacitor() ? PIPED_NATIVE_INSTANCES : PIPED_CORS_INSTANCES;
  const attempts = pool.map(async (base) => {
    const data = await fetchJsonWithTimeout(`${base}/search?q=${q}&filter=music_songs`, 3000);
    if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error('empty');
    const tracks = [];
    for (const item of data.items.slice(0, 12)) {
      const match = (item.url || '').match(/[?&]v=([^&]+)/);
      const videoId = match ? match[1] : '';
      if (!videoId || item.isShort) continue;
      if (item.duration && item.duration < 45) continue;
      tracks.push({
        videoId,
        title: item.title || 'Unknown Title',
        artist: item.uploaderName || 'YouTube Music',
        duration: item.duration > 0 ? formatTime(item.duration) : '',
        thumbnail: ensureHttpsUrl(item.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
        source: 'piped',
        instanceBase: base,
        webpageUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      });
    }
    if (!tracks.length) throw new Error('no-tracks');
    return tracks;
  });

  try {
    return await Promise.any(attempts);
  } catch (e) {
    return [];
  }
}

async function resolveYouTubeStreamViaInvidiousOrPiped(videoId, preferredBase = '') {
  if (!videoId || /^(it_|dz_|sv_|sc_)/.test(videoId)) return '';

  const invPool = isNativeCapacitor() ? INVIDIOUS_NATIVE_INSTANCES : INVIDIOUS_CORS_INSTANCES;
  const invOrder = preferredBase && invPool.includes(preferredBase)
    ? [preferredBase, ...invPool.filter(u => u !== preferredBase)]
    : invPool;

  for (const base of invOrder.slice(0, 2)) {
    const data = await fetchJsonWithTimeout(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, 3000);
    if (data && Array.isArray(data.adaptiveFormats)) {
      const m4a = data.adaptiveFormats.find(f => /audio\/mp4/i.test(f.type || '') && f.url)
        || data.adaptiveFormats.find(f => /audio\//i.test(f.type || '') && !/webm|opus/i.test(f.type || '') && f.url);
      if (m4a && m4a.url) return ensureHttpsUrl(m4a.url);
    }
    if (data && Array.isArray(data.formatStreams)) {
      const mp4 = data.formatStreams.find(f => /video\/mp4/i.test(f.type || '') && f.url);
      if (mp4 && mp4.url) return ensureHttpsUrl(mp4.url);
    }
  }

  const pipedPool = isNativeCapacitor() ? PIPED_NATIVE_INSTANCES : PIPED_CORS_INSTANCES;
  const pipedOrder = preferredBase && pipedPool.includes(preferredBase)
    ? [preferredBase, ...pipedPool.filter(u => u !== preferredBase)]
    : pipedPool;

  for (const base of pipedOrder) {
    const data = await fetchJsonWithTimeout(`${base}/streams/${encodeURIComponent(videoId)}`, 3000);
    if (data && Array.isArray(data.audioStreams)) {
      const m4a = data.audioStreams.find(s => /mp4|m4a|aac/i.test(s.mimeType || s.format || '') && s.url);
      if (m4a && m4a.url) return ensureHttpsUrl(m4a.url);
    }
  }

  return '';
}

async function searchMusicDirectHTTPS(query) {
  const results = [];
  const seen = new Set();

  const addUnique = (track) => {
    const key = `${(track.artist || '').toLowerCase()}|${(track.title || '').toLowerCase()}`;
    if (!track.title || seen.has(key)) return;
    seen.add(key);
    results.push(track);
  };

  // Run full-length HTTPS audio sources in parallel (never 30s demo previews)
  const [scRes, saavnRes, invRes, pipedRes] = await Promise.allSettled([
    fetchSoundCloudSearch(query, 12),
    fetchSaavnDirect(query, 15),
    fetchInvidiousSearch(query),
    fetchPipedSearch(query)
  ]);

  // 1. SoundCloud full tracks on native iOS (best RU + global exact catalog match)
  if (scRes.status === 'fulfilled' && Array.isArray(scRes.value)) {
    scRes.value.forEach(addUnique);
  }

  // 2. Saavn full-length HTTPS .mp4 AAC tracks (works everywhere with Range + ACAO: *)
  if (saavnRes.status === 'fulfilled' && Array.isArray(saavnRes.value)) {
    saavnRes.value.forEach(addUnique);
  }

  // 3. Invidious / Piped full YouTube Music tracks
  if (invRes.status === 'fulfilled' && Array.isArray(invRes.value)) {
    invRes.value.forEach(addUnique);
  }
  if (pipedRes.status === 'fulfilled' && Array.isArray(pipedRes.value)) {
    pipedRes.value.forEach(addUnique);
  }

  return results;
}

async function performSearch(query) {
  const cacheKey = query.toLowerCase();
  if (searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    searchResults.innerHTML = cached.length
      ? cached.map((track, i) => createTrackHTML(track, 'search', i)).join('')
      : `<div class="empty-state"><p>Ничего не найдено</p></div>`;
    return;
  }

  if (searchSpinner) searchSpinner.style.display = '';
  searchResults.innerHTML = '';

  try {
    let data = null;
    const apiBase = getCustomBackendApi();

    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json) && json.length) data = json;
        }
      } catch (e) {
        // Fallback smoothly to direct HTTPS search
      }
    }

    if (!data) {
      data = await searchMusicDirectHTTPS(query);
    }

    searchCache.set(cacheKey, data);

    if (!data.length) {
      const offlineMsg = navigator.onLine === false
        ? 'Нет подключения к интернету'
        : 'Ничего не найдено';
      searchResults.innerHTML = `<div class="empty-state"><p>${offlineMsg}</p></div>`;
      return;
    }

    searchResults.innerHTML = data.map((track, i) => createTrackHTML(track, 'search', i)).join('');
  } catch (err) {
    console.warn('[flyqa] Search warning:', err);
    searchResults.innerHTML = `<div class="empty-state"><p>Не удалось выполнить поиск. Проверьте интернет-соединение.</p></div>`;
  } finally {
    if (searchSpinner) searchSpinner.style.display = 'none';
  }
}

// ============================================================
//  4. Track Item HTML Component
// ============================================================
function createTrackHTML(track, context, index, options = {}) {
  const thumb = track.thumbnail || '';
  const imgEl = thumb
    ? `<img class="track-cover" src="${escapeAttr(thumb)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
    : `<div class="track-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.05);">
        <svg width="20" height="20" viewBox="0 0 20 20"><path d="M7 4v12l9-6z" fill="currentColor" opacity="0.3"/></svg>
       </div>`;

  const isPlaying = state.currentTrack &&
    ((track.videoId && track.videoId === state.currentTrack.videoId) ||
     (track.video_id && track.video_id === state.currentTrack.videoId) ||
     (track.localPath && track.localPath === state.currentTrack.localPath));

  const sourceBadge = track.source
    ? `<span class="track-source-badge ${track.source}">${track.source}</span>`
    : '';

  const multiSelectMode = options.multiSelect || false;
  const isSelected = options.isSelected || false;
  const showDragHandle = options.draggable || false;

  const checkboxHTML = multiSelectMode
    ? `<input type="checkbox" class="track-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); handleTrackCheckbox('${escapeAttr(String(track.id))}')">`
    : '';

  const dragHandleHTML = showDragHandle
    ? `<span class="track-drag-handle" title="Перетащите для изменения порядка">☰</span>`
    : '';

  return `
    <div class="track-item ${isPlaying ? 'playing' : ''} ${isSelected ? 'selected' : ''}"
         draggable="${showDragHandle ? 'true' : 'false'}"
         data-context="${context}"
         data-index="${index}"
         data-id="${track.id || ''}"
         data-video-id="${escapeAttr(track.videoId || track.video_id || '')}"
         data-title="${escapeAttr(track.title)}"
         data-artist="${escapeAttr(track.artist || '')}"
         data-duration="${escapeAttr(track.duration || '')}"
         data-thumbnail="${escapeAttr(thumb)}"
         data-source="${escapeAttr(track.source || 'youtube')}"
         data-instance-base="${escapeAttr(track.instanceBase || '')}"
         data-sc-transcoding="${escapeAttr(track.scTranscodingUrl || '')}"
         data-sc-auth="${escapeAttr(track.scTrackAuth || '')}"
         data-local-path="${escapeAttr(track.localPath || track.local_path || '')}"
         data-webpage-url="${escapeAttr(track.webpageUrl || track.webpage_url || '')}"
         onclick="handleTrackClick(this, event)"
         oncontextmenu="handleTrackContext(event, this)">
      ${dragHandleHTML}
      ${checkboxHTML}
      ${imgEl}
      <div class="track-info">
        <div class="track-title">${escapeHTML(track.title)}${sourceBadge}</div>
        <div class="track-artist">${escapeHTML(track.artist || 'Unknown')}</div>
      </div>
      <div class="track-duration">${escapeHTML(track.duration || '')}</div>
      <div class="track-actions">
        <button class="icon-btn track-add-playlist-btn" title="Добавить в плейлист" aria-label="Добавить в плейлист" onclick="event.stopPropagation(); openAddToPlaylistSheet(getTrackData(this.closest('.track-item')))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="icon-btn" title="Добавить в очередь" aria-label="Добавить в очередь" onclick="event.stopPropagation(); addToQueue(this.closest('.track-item'))">
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 3h12M2 7h8M2 11h5M12 8v6M9 11h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>`;
}

function getTrackData(el) {
  return {
    id: el.dataset.id || undefined,
    videoId: el.dataset.videoId,
    title: el.dataset.title,
    artist: el.dataset.artist,
    duration: el.dataset.duration,
    thumbnail: el.dataset.thumbnail,
    source: el.dataset.source || 'youtube',
    instanceBase: el.dataset.instanceBase || '',
    scTranscodingUrl: el.dataset.scTranscoding || '',
    scTrackAuth: el.dataset.scAuth || '',
    localPath: el.dataset.localPath,
    webpageUrl: el.dataset.webpageUrl
  };
}

// ============================================================
//  5. Track Click & Audio Engine Playback
// ============================================================
function handleTrackClick(el, event) {
  if (window.playlistManager.isMultiSelectMode && el.dataset.id) {
    handleTrackCheckbox(el.dataset.id);
    return;
  }

  // Synchronously unlock iOS WebKit audio & AudioContext inside the tap gesture
  window.flyqaIOS?.primeAudioForGesture?.();

  const track = getTrackData(el);
  const context = el.dataset.context;

  if (context === 'search') {
    const items = $$('#search-results .track-item');
    state.queue = Array.from(items).map(it => getTrackData(it));
    state.queueIndex = parseInt(el.dataset.index);
  } else if (context === 'queue') {
    state.queueIndex = parseInt(el.dataset.index);
  } else if (context === 'playlist') {
    state.queue = [...window.playlistManager.filteredTracks].map(t => ({
      id: t.id,
      videoId: t.video_id,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      thumbnail: t.thumbnail,
      source: t.source || 'youtube',
      localPath: t.local_path,
      webpageUrl: t.webpage_url
    }));
    state.queueIndex = parseInt(el.dataset.index);
  } else if (context === 'local') {
    const items = $$('#local-files-list .track-item');
    state.queue = Array.from(items).map(it => getTrackData(it));
    state.queueIndex = parseInt(el.dataset.index);
  }

  playTrack(track);
}

async function playTrack(track) {
  state.currentTrack = track;
  state.isPlaying = true;

  // Ensure Web Audio Engine is initialized
  window.audioEngine.init(audio);
  window.audioEngine.ensureRunning();

  // Update UI Elements
  const playerTitle = $('#player-title');
  const playerArtist = $('#player-artist');
  const playerCover = $('#player-cover');

  if (playerTitle) {
    playerTitle.textContent = track.title;
    playerTitle.classList.add('track-change-enter');
    setTimeout(() => playerTitle.classList.remove('track-change-enter'), 500);
  }

  if (playerArtist) {
    playerArtist.textContent = track.artist || 'Unknown';
  }

  if (playerCover) {
    if (track.thumbnail) {
      playerCover.src = track.thumbnail;
      playerCover.classList.add('visible');
    } else {
      playerCover.classList.remove('visible');
      playerCover.src = '';
    }
  }

  // Color Extraction for Dynamic Palette
  if (track.thumbnail) {
    extractColors(track.thumbnail);
  }

  window.flyqaIOS?.updateMediaSession(track);
  syncFullscreenUI();
  updateFsMarquee();

  updatePlayIcon();
  highlightCurrentTrack();

  // Audio Source setup: full-length HTTPS stream (Saavn / SoundCloud / Invidious / Piped / custom server)
  const playTrackToken = ++state._playToken || (state._playToken = 1);
  const startAudioStream = async (url, allowCorsAttr = true) => {
    const isHlsStream = /\.m3u8(\?|$)|mpegurl/i.test(url);
    // Use direct element for native iOS HLS (.m3u8) or non-CORS fallback streams so createMediaElementSource never mutes audio
    const useDirectEl = (isHlsStream || !allowCorsAttr) && hlsAudio;
    const targetEl = useDirectEl ? hlsAudio : primaryAudio;
    const otherEl = targetEl === primaryAudio ? hlsAudio : primaryAudio;

    if (otherEl) {
      try {
        otherEl.pause();
        otherEl.removeAttribute('src');
        otherEl.load();
      } catch (e) {}
    }
    audio = targetEl;
    if (audio === primaryAudio) {
      window.audioEngine.init(primaryAudio);
      window.audioEngine.ensureRunning();
    } else if (window.audioEngine) {
      window.audioEngine.ensureRunning();
      window.audioEngine.connectFallbackStream?.(targetEl);
    }

    return await new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        targetEl.removeEventListener('error', onErr);
        targetEl.removeEventListener('canplay', onReady);
      };
      const finishOk = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const finishErr = (err) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };
      const onErr = () => finishErr(new Error('Audio stream load failed'));
      const onReady = () => {
        targetEl.play().then(finishOk).catch(finishErr);
      };
      const timer = setTimeout(() => finishErr(new Error('Audio stream timeout')), 8000);

      targetEl.addEventListener('error', onErr);
      targetEl.addEventListener('canplay', onReady);

      if (targetEl === primaryAudio && allowCorsAttr) {
        targetEl.setAttribute('crossorigin', 'anonymous');
      } else {
        targetEl.removeAttribute('crossorigin');
      }
      targetEl.src = url;
      targetEl.volume = state.volume;
      targetEl.load();
      targetEl.play().then(finishOk).catch((playErr) => {
        if (playErr && playErr.name === 'NotAllowedError') {
          finishErr(playErr);
        }
      });
    });
  };

  const resolveFullFallbackUrl = async (excludeSaavn = false) => {
    const query = `${track.artist && track.artist !== 'Unknown' && track.artist !== 'YouTube Music' ? track.artist + ' ' : ''}${track.title || ''}`.trim();
    if (!query) return '';
    if (isNativeCapacitor()) {
      const scMatches = await fetchSoundCloudSearch(query, 3);
      if (scMatches.length) {
        const scUrl = await resolveSoundCloudStreamUrl(scMatches[0]);
        if (scUrl) return scUrl;
      }
    }
    if (!excludeSaavn) {
      const svMatches = await fetchSaavnDirect(query, 3);
      if (svMatches.length && svMatches[0].webpageUrl) {
        return svMatches[0].webpageUrl;
      }
    }
    return '';
  };

  try {
    const apiBase = getCustomBackendApi();
    let streamUrl = '';

    if (track.source === 'local' && track.localPath && apiBase) {
      streamUrl = `${apiBase}/local-file?path=${encodeURIComponent(track.localPath)}`;
    } else if (track.source === 'soundcloud' && track.scTranscodingUrl) {
      streamUrl = await resolveSoundCloudStreamUrl(track);
    } else if (isDirectAudioUrl(track.webpageUrl)) {
      streamUrl = ensureHttpsUrl(track.webpageUrl);
    } else if (apiBase && (track.videoId || track.webpageUrl)) {
      const id = track.videoId || encodeURIComponent(track.webpageUrl);
      streamUrl = `${apiBase}/audio/${id}`;
    } else if (track.videoId && !/^(it_|dz_|sv_|sc_)/.test(track.videoId)) {
      streamUrl = await resolveYouTubeStreamViaInvidiousOrPiped(track.videoId, track.instanceBase || '');
    }

    // Fallback to full-length SoundCloud / Saavn track if primary resolver returned empty
    if (!streamUrl) {
      streamUrl = await resolveFullFallbackUrl(false);
    }

    if (state._playToken !== playTrackToken) return;

    if (!streamUrl) {
      showToast('Полный аудиопоток недоступен для этого трека');
      state.isPlaying = false;
      updatePlayIcon();
      return;
    }

    try {
      await startAudioStream(streamUrl, true);
    } catch (firstErr) {
      if (state._playToken !== playTrackToken) return;
      const fallbackUrl = await resolveFullFallbackUrl(streamUrl.includes('saavncdn.com'));
      if (state._playToken !== playTrackToken) return;
      if (fallbackUrl && fallbackUrl !== streamUrl) {
        await startAudioStream(fallbackUrl, true);
      } else {
        await startAudioStream(streamUrl, false);
      }
    }

    if (state._playToken !== playTrackToken) return;
    $('.player-cover-wrap')?.classList.add('playing');
    if (window.storageManager.getSetting('visualizerEnabled')) {
      window.audioVisualizer?.start();
    }
  } catch (err) {
    if (state._playToken !== playTrackToken) return;
    console.warn('Play error:', err);
    state.isPlaying = false;
    updatePlayIcon();
    showToast('Ошибка воспроизведения: проверьте интернет');
  }
}

function highlightCurrentTrack() {
  $$('.track-item').forEach(el => {
    el.classList.remove('playing');
    const vid = el.dataset.videoId;
    const lp = el.dataset.localPath;
    if (state.currentTrack) {
      if ((vid && vid === state.currentTrack.videoId) ||
          (lp && lp === state.currentTrack.localPath)) {
        el.classList.add('playing');
      }
    }
  });
}

// ============================================================
//  6. Player Controls & Smart Shuffle
// ============================================================
const btnPlay = $('#btn-play');
const btnPrev = $('#btn-prev');
const btnNext = $('#btn-next');
const progressBarWrap = $('#progress-bar-wrap');
const progressFill = $('#progress-fill');
const progressThumb = $('#progress-thumb');
const timeCurrent = $('#time-current');
const timeTotal = $('#time-total');
const volumeSlider = $('#volume-slider');

btnPlay?.addEventListener('click', togglePlay);
btnPrev?.addEventListener('click', playPrev);
btnNext?.addEventListener('click', playNext);

function togglePlay() {
  if (!state.currentTrack) return;
  window.audioEngine.ensureRunning();

  if (audio.paused) {
    audio.play();
    state.isPlaying = true;
    $('.player-cover-wrap')?.classList.add('playing');
    window.audioVisualizer?.start();
  } else {
    audio.pause();
    state.isPlaying = false;
    $('.player-cover-wrap')?.classList.remove('playing');
  }
  updatePlayIcon();
}

function updatePlayIcon() {
  const icon = $('#play-icon');
  const fsIcon = $('#fs-play-icon');
  const playSvg = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
  const pauseSvg = '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>';

  if (icon) {
    icon.innerHTML = state.isPlaying ? pauseSvg : playSvg;
  }
  if (fsIcon) {
    fsIcon.innerHTML = state.isPlaying ? pauseSvg : playSvg;
  }
  const fsCoverWrap = $('#fs-cover-wrap');
  if (fsCoverWrap) {
    fsCoverWrap.classList.toggle('playing', state.isPlaying);
  }
}

function playNext() {
  if (state.queue.length === 0) return;
  if (state.repeatMode === 'one') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
  if (state.currentView === 'queue') updateQueueView();
}

function playPrev() {
  if (state.queue.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
  if (state.currentView === 'queue') updateQueueView();
}

// Progress Bar & Audio Events (attached to both primary & HLS audio elements)
[primaryAudio, hlsAudio].filter(Boolean).forEach((el) => {
  el.addEventListener('play', () => {
    if (el !== audio) return;
    state.isPlaying = true;
    updatePlayIcon();
    $('.player-cover-wrap')?.classList.add('playing');
  });

  el.addEventListener('pause', () => {
    if (el !== audio) return;
    state.isPlaying = false;
    updatePlayIcon();
    $('.player-cover-wrap')?.classList.remove('playing');
  });

  el.addEventListener('timeupdate', () => {
    if (el !== audio || !audio.duration || !isFinite(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressThumb) progressThumb.style.left = pct + '%';
    if (timeCurrent) timeCurrent.textContent = formatTime(audio.currentTime);

    const fsFill = $('#fs-progress-fill');
    const fsThumb = $('#fs-progress-thumb');
    const fsTimeCur = $('#fs-time-current');
    if (fsFill) fsFill.style.width = pct + '%';
    if (fsThumb) fsThumb.style.left = pct + '%';
    if (fsTimeCur) fsTimeCur.textContent = formatTime(audio.currentTime);
  });

  el.addEventListener('loadedmetadata', () => {
    if (el !== audio || !audio.duration || !isFinite(audio.duration)) return;
    const tot = formatTime(audio.duration);
    if (timeTotal) timeTotal.textContent = tot;
    const fsTimeTot = $('#fs-time-total');
    if (fsTimeTot) fsTimeTot.textContent = tot;
  });

  el.addEventListener('ended', () => {
    if (el !== audio) return;
    // Only advance when the full track actually reaches its end
    if (audio.duration && isFinite(audio.duration) && audio.currentTime + 1.5 < audio.duration) {
      return;
    }
    playNext();
  });
});

// Seeking
progressBarWrap?.addEventListener('click', (e) => {
  if (!audio || !audio.duration) return;
  const rect = progressBarWrap.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
});

// Volume
if (volumeSlider) {
  volumeSlider.value = state.volume * 100;
  volumeSlider.addEventListener('input', () => {
    state.volume = volumeSlider.value / 100;
    audio.volume = state.volume;
    window.storageManager.saveSettings({ volume: state.volume });
    updateVolumeIcon();
  });
}

function updateVolumeIcon() {
  const waves = $('#volume-waves');
  if (waves) waves.style.display = state.volume === 0 ? 'none' : '';
}

$('#btn-volume-icon')?.addEventListener('click', () => {
  if (state.volume > 0) {
    state.prevVolume = state.volume;
    state.volume = 0;
  } else {
    state.volume = state.prevVolume || 0.8;
  }
  audio.volume = state.volume;
  if (volumeSlider) volumeSlider.value = state.volume * 100;
  window.storageManager.saveSettings({ volume: state.volume });
  updateVolumeIcon();
});

// --- Smart Shuffle Controls ---
const SHUFFLE_MODES = ['fair', 'random', 'mood'];
const SHUFFLE_LABELS = {
  'fair': 'Fair Shuffle',
  'random': 'True Random',
  'mood': 'Mood Shuffle'
};

$('#btn-shuffle-toggle')?.addEventListener('click', () => {
  const currentMode = window.smartShuffle.mode;
  const nextIdx = (SHUFFLE_MODES.indexOf(currentMode) + 1) % SHUFFLE_MODES.length;
  const nextMode = SHUFFLE_MODES[nextIdx];
  window.smartShuffle.setMode(nextMode);
  updateShuffleButtonUI();
  showToast(`Режим перемешивания: ${SHUFFLE_LABELS[nextMode]}`);
});

function updateShuffleButtonUI() {
  const mode = window.smartShuffle.mode;
  const label = $('#shuffle-mode-label');
  if (label) label.textContent = `Режим: ${SHUFFLE_LABELS[mode]}`;

  const shuffleIconBtn = $('#btn-shuffle-toggle');
  if (shuffleIconBtn) {
    shuffleIconBtn.classList.toggle('active', mode !== 'random');
    shuffleIconBtn.title = `Перемешивание: ${SHUFFLE_LABELS[mode]}`;
  }

  const fsShuffleBtn = $('#fs-btn-shuffle');
  if (fsShuffleBtn) {
    fsShuffleBtn.classList.toggle('active', mode !== 'random');
    fsShuffleBtn.title = `Перемешивание: ${SHUFFLE_LABELS[mode]}`;
  }
}

// Queue view shuffle actions
$('#btn-shuffle-mode-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#shuffle-mode-dropdown');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
});

document.addEventListener('click', () => {
  const menu = $('#shuffle-mode-dropdown');
  if (menu) menu.style.display = 'none';
});

$$('#shuffle-mode-dropdown .dropdown-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const mode = btn.dataset.mode;
    window.smartShuffle.setMode(mode);
    updateShuffleButtonUI();
    $('#shuffle-mode-dropdown').style.display = 'none';
    showToast(`Выбран режим: ${SHUFFLE_LABELS[mode]}`);
  });
});

$('#btn-shuffle-now')?.addEventListener('click', () => {
  if (state.queue.length <= 1) return;
  state.queue = window.smartShuffle.shuffle(state.queue, state.queueIndex);
  state.queueIndex = 0;
  updateQueueView();
  showToast(`Очередь перемешана (${SHUFFLE_LABELS[window.smartShuffle.mode]})`);
});

$('#btn-clear-queue')?.addEventListener('click', () => {
  state.queue = [];
  state.queueIndex = -1;
  updateQueueView();
  showToast('Очередь очищена');
});

// Repeat Mode Toggle
const REPEAT_MODES = ['off', 'all', 'one'];
$('#btn-repeat-toggle')?.addEventListener('click', () => {
  const idx = (REPEAT_MODES.indexOf(state.repeatMode) + 1) % REPEAT_MODES.length;
  state.repeatMode = REPEAT_MODES[idx];
  window.storageManager.saveSettings({ repeatMode: state.repeatMode });
  updateRepeatButtonUI();
});

function updateRepeatButtonUI() {
  const btn = $('#btn-repeat-toggle');
  if (btn) {
    btn.classList.toggle('active', state.repeatMode !== 'off');
    btn.title = `Повтор: ${state.repeatMode}`;
  }
  const fsBtn = $('#fs-btn-repeat');
  if (fsBtn) {
    fsBtn.classList.toggle('active', state.repeatMode !== 'off');
    fsBtn.title = `Повтор: ${state.repeatMode}`;
  }
}

// ============================================================
//  6.5 Fullscreen "Now Playing" Manager (144 FPS Shared Element)
// ============================================================
let fsIdleTimer = null;
let isFullscreenTransitioning = false;

function isFullscreenActive() {
  const overlay = $('#fullscreen-player');
  return !!(overlay && overlay.classList.contains('active'));
}

function syncFullscreenUI() {
  const track = state.currentTrack;
  const fsTitle = $('#fs-title');
  const fsArtist = $('#fs-artist');
  const fsCoverImg = $('#fs-cover-img');
  const fsCoverWrap = $('#fs-cover-wrap');
  const fsFill = $('#fs-progress-fill');
  const fsThumb = $('#fs-progress-thumb');
  const fsTimeCur = $('#fs-time-current');
  const fsTimeTot = $('#fs-time-total');

  if (track) {
    if (fsTitle) fsTitle.textContent = track.title || 'Не воспроизводится';
    if (fsArtist) fsArtist.textContent = track.artist || 'Неизвестный исполнитель';
    if (fsCoverImg) {
      if (track.thumbnail) {
        fsCoverImg.src = track.thumbnail;
        fsCoverImg.classList.add('visible');
      } else {
        fsCoverImg.classList.remove('visible');
        fsCoverImg.src = '';
      }
    }
  }

  // Mirror style class (vinyl, cassette, tilt)
  const miniCoverWrap = $('#player-cover-wrap');
  if (fsCoverWrap && miniCoverWrap) {
    fsCoverWrap.className = miniCoverWrap.className.replace('player-cover-wrap', 'fs-cover-wrap');
    fsCoverWrap.classList.toggle('playing', state.isPlaying);
  }

  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    if (fsFill) fsFill.style.width = pct + '%';
    if (fsThumb) fsThumb.style.left = pct + '%';
    if (fsTimeCur) fsTimeCur.textContent = formatTime(audio.currentTime);
    if (fsTimeTot) fsTimeTot.textContent = formatTime(audio.duration);
  }

  updatePlayIcon();
  updateShuffleButtonUI();
  updateRepeatButtonUI();
}

function updateFsMarquee() {
  const titleWrap = $('#fs-title-wrap');
  const titleEl = $('#fs-title');
  if (!titleWrap || !titleEl) return;

  titleEl.classList.remove('marquee-anim');
  titleWrap.classList.remove('is-overflowing');
  titleEl.style.removeProperty('--marquee-offset');
  titleEl.style.removeProperty('--marquee-duration');

  requestAnimationFrame(() => {
    const wrapWidth = titleWrap.clientWidth;
    const contentWidth = titleEl.scrollWidth;

    if (contentWidth > wrapWidth + 4) {
      titleWrap.classList.add('is-overflowing');
      const overflowDistance = contentWidth - wrapWidth + 16;
      titleEl.style.setProperty('--marquee-offset', `-${overflowDistance}px`);
      const duration = Math.max(5, Math.min(14, (overflowDistance / 35) + 3));
      titleEl.style.setProperty('--marquee-duration', `${duration}s`);
      titleEl.classList.add('marquee-anim');
    }
  });
}

function openFullscreenPlayer() {
  if (isFullscreenTransitioning) return;
  const overlay = $('#fullscreen-player');
  const miniCoverWrap = $('#player-cover-wrap');
  const fsCoverWrap = $('#fs-cover-wrap');
  if (!overlay || !miniCoverWrap || !fsCoverWrap) return;

  isFullscreenTransitioning = true;
  syncFullscreenUI();

  const miniRect = miniCoverWrap.getBoundingClientRect();

  // Prepare initial state for seamless backdrop fade + staged UI slide
  overlay.style.transition = 'none';
  overlay.style.transform = '';
  overlay.style.opacity = '0';
  overlay.style.visibility = 'visible';
  overlay.classList.add('active', 'fs-entering');
  overlay.setAttribute('aria-hidden', 'false');

  const fsRect = fsCoverWrap.getBoundingClientRect();

  if (miniRect.width > 0 && fsRect.width > 0) {
    const scale = miniRect.width / fsRect.width;
    const dx = (miniRect.left + miniRect.width / 2) - (fsRect.left + fsRect.width / 2);
    const dy = (miniRect.top + miniRect.height / 2) - (fsRect.top + fsRect.height / 2);

    fsCoverWrap.style.transition = 'none';
    fsCoverWrap.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
    fsCoverWrap.style.boxShadow = 'none';
  }

  // Force layout flush before starting iOS spring FLIP
  void overlay.offsetWidth;

  requestAnimationFrame(() => {
    overlay.style.transition = 'opacity 0.44s cubic-bezier(0.32, 0.72, 0, 1), visibility 0.44s ease';
    overlay.style.opacity = '1';
    overlay.classList.remove('fs-entering');

    if (miniRect.width > 0 && fsRect.width > 0) {
      fsCoverWrap.style.transition = 'transform 0.48s cubic-bezier(0.32, 0.72, 0, 1), box-shadow 0.48s cubic-bezier(0.16, 1, 0.3, 1)';
      fsCoverWrap.style.transform = 'translate3d(0, 0, 0) scale(1)';
      fsCoverWrap.style.boxShadow = '';
    }
  });

  setTimeout(updateFsMarquee, 60);
  setTimeout(updateFsMarquee, 320);

  // Inactivity auto-hide listener
  resetFsIdleTimer();
  window.addEventListener('mousemove', onFsUserActivity);
  window.addEventListener('keydown', onFsUserActivity);
  window.addEventListener('mousedown', onFsUserActivity);
  window.addEventListener('wheel', onFsUserActivity);

  setTimeout(() => {
    if (fsCoverWrap) {
      fsCoverWrap.style.transform = '';
      fsCoverWrap.style.transition = '';
    }
    isFullscreenTransitioning = false;
  }, 480);
}

function closeFullscreenPlayer(options = {}) {
  if (isFullscreenTransitioning) return;
  const overlay = $('#fullscreen-player');
  const miniCoverWrap = $('#player-cover-wrap');
  const fsCoverWrap = $('#fs-cover-wrap');
  if (!overlay || !overlay.classList.contains('active')) return;

  isFullscreenTransitioning = true;
  clearFsIdleTimer();
  overlay.classList.remove('fs-idle');

  if (options.fromSwipe) {
    // Continue sliding down smoothly from swipe offset
    overlay.style.transition = 'transform 0.38s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.34s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.38s ease';
    overlay.style.transform = 'translate3d(0, 100%, 0)';
    overlay.style.opacity = '0';
  } else {
    // Reverse FLIP animation seamlessly back into mini-player cover
    if (miniCoverWrap && fsCoverWrap) {
      const miniRect = miniCoverWrap.getBoundingClientRect();
      const fsRect = fsCoverWrap.getBoundingClientRect();
      if (miniRect.width > 0 && fsRect.width > 0) {
        const scale = miniRect.width / fsRect.width;
        const dx = (miniRect.left + miniRect.width / 2) - (fsRect.left + fsRect.width / 2);
        const dy = (miniRect.top + miniRect.height / 2) - (fsRect.top + fsRect.height / 2);

        fsCoverWrap.style.transition = 'transform 0.42s cubic-bezier(0.32, 0.72, 0, 1), box-shadow 0.36s ease';
        fsCoverWrap.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
        fsCoverWrap.style.boxShadow = 'none';
      }
    }

    overlay.classList.add('fs-leaving');
    overlay.style.transition = 'opacity 0.4s cubic-bezier(0.32, 0.72, 0, 1), visibility 0.4s ease';
    overlay.style.opacity = '0';
  }

  window.removeEventListener('mousemove', onFsUserActivity);
  window.removeEventListener('keydown', onFsUserActivity);
  window.removeEventListener('mousedown', onFsUserActivity);
  window.removeEventListener('wheel', onFsUserActivity);

  setTimeout(() => {
    overlay.classList.remove('active', 'fs-entering', 'fs-leaving');
    overlay.style.visibility = 'hidden';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.opacity = '';
    overlay.style.transform = '';
    overlay.style.transition = '';
    if (fsCoverWrap) {
      fsCoverWrap.style.transform = '';
      fsCoverWrap.style.transition = '';
      fsCoverWrap.style.boxShadow = '';
    }
    isFullscreenTransitioning = false;
  }, 420);
}

function toggleFullscreenPlayer() {
  if (isFullscreenActive()) {
    closeFullscreenPlayer();
  } else {
    openFullscreenPlayer();
  }
}

function onFsUserActivity() {
  const overlay = $('#fullscreen-player');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (overlay.classList.contains('fs-idle')) {
    overlay.classList.remove('fs-idle');
  }
  resetFsIdleTimer();
}

function resetFsIdleTimer() {
  clearFsIdleTimer();
  const overlay = $('#fullscreen-player');
  if (!overlay || !overlay.classList.contains('active')) return;

  fsIdleTimer = setTimeout(() => {
    if (overlay.classList.contains('active')) {
      overlay.classList.add('fs-idle');
    }
  }, 3500); // 3.5 seconds inactivity auto-hide
}

function clearFsIdleTimer() {
  if (fsIdleTimer) {
    clearTimeout(fsIdleTimer);
    fsIdleTimer = null;
  }
}

function toggleWindowFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.warn('Window fullscreen request rejected:', err);
    });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
}

function initFullscreenPlayerUI() {
  // Triggers to open Fullscreen
  $('#player-cover-wrap')?.addEventListener('click', openFullscreenPlayer);
  $('#btn-fullscreen-toggle')?.addEventListener('click', openFullscreenPlayer);

  // Triggers to close Fullscreen
  $('#btn-close-fullscreen')?.addEventListener('click', closeFullscreenPlayer);
  $('#fs-btn-window-fs')?.addEventListener('click', toggleWindowFullscreen);

  // Click on background or empty stage closes fullscreen
  $('#fullscreen-player')?.addEventListener('click', (e) => {
    if (e.target.id === 'fullscreen-player' ||
        e.target.id === 'fs-stage' ||
        e.target.id === 'fs-ambient-backdrop' ||
        e.target.classList.contains('fs-ambient-mesh') ||
        e.target.classList.contains('fs-ambient-blob')) {
      closeFullscreenPlayer();
    }
  });

  // Fullscreen Playback buttons
  $('#fs-btn-play')?.addEventListener('click', togglePlay);
  $('#fs-btn-prev')?.addEventListener('click', playPrev);
  $('#fs-btn-next')?.addEventListener('click', playNext);

  $('#fs-btn-shuffle')?.addEventListener('click', () => {
    const currentMode = window.smartShuffle.mode;
    const nextIdx = (SHUFFLE_MODES.indexOf(currentMode) + 1) % SHUFFLE_MODES.length;
    const nextMode = SHUFFLE_MODES[nextIdx];
    window.smartShuffle.setMode(nextMode);
    updateShuffleButtonUI();
    showToast(`Режим перемешивания: ${SHUFFLE_LABELS[nextMode]}`);
  });

  $('#fs-btn-repeat')?.addEventListener('click', () => {
    const idx = (REPEAT_MODES.indexOf(state.repeatMode) + 1) % REPEAT_MODES.length;
    state.repeatMode = REPEAT_MODES[idx];
    window.storageManager.saveSettings({ repeatMode: state.repeatMode });
    updateRepeatButtonUI();
  });

  $('#fs-btn-add-playlist')?.addEventListener('click', () => {
    if (!state.currentTrack) {
      showToast('Сначала выберите трек');
      return;
    }
    openAddToPlaylistSheet(state.currentTrack);
  });

  // Extended Fullscreen Seek Bar (mouse + iOS touch seek support)
  const fsProgressWrap = $('#fs-progress-wrap');
  const fsProgressTooltip = $('#fs-progress-tooltip');

  if (fsProgressWrap) {
    const getClientX = (e) => (e.touches && e.touches[0] ? e.touches[0].clientX : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : e.clientX));
    const handleFsSeek = (e) => {
      if (!audio || !audio.duration || !isFinite(audio.duration)) return;
      const clientX = getClientX(e);
      if (typeof clientX !== 'number') return;
      const rect = fsProgressWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      audio.currentTime = pct * audio.duration;
    };

    const onDragMove = (e) => handleFsSeek(e);
    const onDragEnd = () => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };

    fsProgressWrap.addEventListener('mousedown', (e) => {
      handleFsSeek(e);
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);
    });

    fsProgressWrap.addEventListener('touchstart', (e) => {
      handleFsSeek(e);
    }, { passive: true });
    fsProgressWrap.addEventListener('touchmove', (e) => {
      handleFsSeek(e);
    }, { passive: true });

    fsProgressWrap.addEventListener('mousemove', (e) => {
      if (!audio || !audio.duration || !fsProgressTooltip) return;
      const rect = fsProgressWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      fsProgressTooltip.style.left = `${pct * 100}%`;
      fsProgressTooltip.textContent = formatTime(pct * audio.duration);
    });
  }

  window.addEventListener('resize', updateFsMarquee);
}

// ============================================================
//  7. Queue View (Up Next)
// ============================================================
function addToQueue(trackEl) {
  const track = getTrackData(trackEl);
  state.queue.push(track);
  if (state.currentView === 'queue') updateQueueView();
  showToast(`Добавлено в очередь: ${track.title}`);
}

function updateQueueView() {
  const queueList = $('#queue-list');
  const countLabel = $('#queue-count-subtitle');
  if (countLabel) countLabel.textContent = `${state.queue.length} треков в очереди`;

  if (!queueList) return;
  if (state.queue.length === 0) {
    queueList.innerHTML = '<div class="empty-state"><p>Очередь воспроизведения пуста</p></div>';
    return;
  }

  queueList.innerHTML = state.queue.map((track, i) =>
    createTrackHTML(track, 'queue', i)
  ).join('');
}

// ============================================================
//  8. 10-Band Graphic Equalizer UI
// ============================================================
function renderEqualizerUI() {
  const list = $('#eq-bands-list');
  if (!list) return;

  const frequencies = window.audioEngine.getFrequencies();
  const eqState = window.audioEngine.state;

  list.innerHTML = frequencies.map((freq, index) => {
    const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}Hz`;
    const val = eqState.bands[index] || 0;
    return `
      <div class="eq-slider-col">
        <div class="eq-gain-val" id="val-band-${index}">${val > 0 ? '+' : ''}${val.toFixed(1)}dB</div>
        <div class="eq-vertical-slider-wrap">
          <input type="range" class="eq-v-slider" data-band-index="${index}" min="-12" max="12" step="0.5" value="${val}">
        </div>
        <div class="eq-band-label">${label}</div>
      </div>
    `;
  }).join('');

  // Attach band slider input listeners
  $$('.eq-v-slider[data-band-index]').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.bandIndex);
      const val = parseFloat(e.target.value);
      $(`#val-band-${idx}`).textContent = `${val > 0 ? '+' : ''}${val.toFixed(1)}dB`;
      window.audioEngine.setBandGain(idx, val);
      $('#eq-preset-select').value = 'Custom';
    });
  });

  // Preamp
  const preampSlider = $('#slider-preamp');
  if (preampSlider) {
    preampSlider.value = eqState.preamp;
    $('#val-preamp').textContent = `${eqState.preamp > 0 ? '+' : ''}${eqState.preamp.toFixed(1)}dB`;
    preampSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      $('#val-preamp').textContent = `${val > 0 ? '+' : ''}${val.toFixed(1)}dB`;
      window.audioEngine.setPreamp(val);
    };
  }

  // Bass Boost
  const bassSlider = $('#slider-bass-boost');
  if (bassSlider) {
    bassSlider.value = eqState.bassBoost;
    $('#val-bass-boost').textContent = `${Math.round(eqState.bassBoost)}%`;
    bassSlider.oninput = (e) => {
      const val = parseInt(e.target.value);
      $('#val-bass-boost').textContent = `${val}%`;
      window.audioEngine.setBassBoost(val);
    };
  }

  // 3D Surround
  const surroundSlider = $('#slider-surround');
  if (surroundSlider) {
    surroundSlider.value = eqState.surround3D;
    $('#val-surround').textContent = `${Math.round(eqState.surround3D)}%`;
    surroundSlider.oninput = (e) => {
      const val = parseInt(e.target.value);
      $('#val-surround').textContent = `${val}%`;
      window.audioEngine.setSurround3D(val);
    };
  }

  // Bypass toggle
  const bypassToggle = $('#eq-bypass-toggle');
  if (bypassToggle) {
    bypassToggle.checked = eqState.enabled;
    $('#eq-bypass-label').textContent = eqState.enabled ? 'Эквалайзер активен' : 'Bypass (Выключен)';
    bypassToggle.onchange = (e) => {
      const isEnabled = e.target.checked;
      window.audioEngine.setBypass(!isEnabled);
      $('#eq-bypass-label').textContent = isEnabled ? 'Эквалайзер активен' : 'Bypass (Выключен)';
    };
  }

  // Populate Presets in Dropdown
  updatePresetDropdown();
}

function updatePresetDropdown() {
  const select = $('#eq-preset-select');
  if (!select) return;

  const allPresets = window.storageManager.getAllPresets();
  const current = window.audioEngine.state.activePreset;

  select.innerHTML = Object.keys(allPresets).map(name =>
    `<option value="${escapeAttr(name)}" ${name === current ? 'selected' : ''}>${escapeHTML(name)}</option>`
  ).join('');

  select.onchange = () => {
    window.audioEngine.applyPreset(select.value);
    renderEqualizerUI();
    showToast(`Пресет эквалайзера: ${select.value}`);
  };

  const isCustom = !['Flat', 'Bass Boost', 'Electronic', 'Rock', 'Pop', 'Jazz', 'Vocal', 'Classical'].includes(current);
  const deleteBtn = $('#btn-delete-custom-preset');
  if (deleteBtn) deleteBtn.style.display = isCustom ? '' : 'none';
}

$('#btn-save-custom-preset')?.addEventListener('click', () => {
  showInputModal('Сохранить пресет эквалайзера', 'Название пресета', 'Мой звук', (name) => {
    if (!name.trim()) return;
    window.audioEngine.saveCustomPreset(name.trim());
    updatePresetDropdown();
    showToast(`Пресет "${name}" сохранён`);
  });
});

$('#btn-delete-custom-preset')?.addEventListener('click', () => {
  const active = window.audioEngine.state.activePreset;
  if (confirm(`Удалить пользовательский пресет "${active}"?`)) {
    window.audioEngine.deleteCustomPreset(active);
    renderEqualizerUI();
    showToast(`Пресет "${active}" удален`);
  }
});

$('#btn-reset-eq')?.addEventListener('click', () => {
  window.audioEngine.applyPreset('Flat');
  window.audioEngine.setPreamp(0);
  window.audioEngine.setBassBoost(0);
  window.audioEngine.setSurround3D(0);
  renderEqualizerUI();
  showToast('Настройки звука сброшены к Flat');
});

// ============================================================
//  9. Audio Visualizer UI
// ============================================================
function initVisualizerUI() {
  const canvas = $('#visualizer-canvas');
  if (canvas) window.audioVisualizer.init(canvas);

  // Enable/Disable toggle
  const visToggle = $('#vis-enable-toggle');
  if (visToggle) {
    const isEn = window.storageManager.getSetting('visualizerEnabled');
    visToggle.checked = isEn;
    $('#vis-toggle-label').textContent = isEn ? 'Визуализатор вкл' : 'Визуализатор выкл';
    visToggle.onchange = (e) => {
      const checked = e.target.checked;
      window.storageManager.saveSettings({ visualizerEnabled: checked });
      $('#vis-toggle-label').textContent = checked ? 'Визуализатор вкл' : 'Визуализатор выкл';
      if (checked) window.audioVisualizer.start();
      else window.audioVisualizer.stop();
    };
  }

  // Visualizer Mode Buttons (restore saved active mode)
  const savedVisMode = window.storageManager.getSetting('visualizerMode') || 'spectrum';
  $$('.vis-modes-group .pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vmode === savedVisMode);
    btn.addEventListener('click', () => {
      $$('.vis-modes-group .pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.vmode;
      window.storageManager.saveSettings({ visualizerMode: mode });
    });
  });

  // Color mode select
  const colorSelect = $('#vis-color-mode-select');
  const customColorPicker = $('#vis-custom-color-picker');
  if (colorSelect && customColorPicker) {
    colorSelect.value = window.storageManager.getSetting('visualizerColorMode') || 'dynamic';
    customColorPicker.style.display = colorSelect.value === 'custom' ? '' : 'none';

    colorSelect.onchange = () => {
      const mode = colorSelect.value;
      window.storageManager.saveSettings({ visualizerColorMode: mode });
      customColorPicker.style.display = mode === 'custom' ? '' : 'none';
    };

    customColorPicker.oninput = (e) => {
      window.storageManager.saveSettings({ visualizerCustomColor: e.target.value });
    };
  }

  // Sensitivity & Smoothing Sliders
  const sensSlider = $('#vis-sensitivity-slider');
  if (sensSlider) {
    sensSlider.value = window.storageManager.getSetting('visualizerSensitivity') || 1.2;
    sensSlider.oninput = (e) => {
      window.storageManager.saveSettings({ visualizerSensitivity: parseFloat(e.target.value) });
    };
  }

  const smoothSlider = $('#vis-smoothing-slider');
  if (smoothSlider) {
    smoothSlider.value = window.storageManager.getSetting('visualizerSmoothing') || 0.82;
    smoothSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      window.storageManager.saveSettings({ visualizerSmoothing: val });
      if (window.audioEngine.analyser) {
        window.audioEngine.analyser.smoothingTimeConstant = val;
      }
    };
  }
}

// ============================================================
//  10. Settings & Customization UI
// ============================================================
function initSettingsUI() {
  // Theme cards
  $$('.theme-card').forEach(card => {
    const tName = card.dataset.themeName;
    card.classList.toggle('active', tName === window.themeManager.currentTheme);

    card.addEventListener('click', () => {
      $$('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      window.themeManager.applyTheme(tName, { userSelected: true });
      showToast(`Тема оформлена: ${card.querySelector('span')?.textContent}`);
    });
  });

  // Dynamic palette
  const dynToggle = $('#setting-dynamic-palette');
  const customAccentRow = $('#row-custom-accent');
  if (dynToggle) {
    dynToggle.checked = window.storageManager.getSetting('dynamicPalette');
    if (customAccentRow) customAccentRow.style.display = dynToggle.checked ? 'none' : '';

    dynToggle.onchange = (e) => {
      const checked = e.target.checked;
      window.storageManager.saveSettings({ dynamicPalette: checked });
      if (customAccentRow) customAccentRow.style.display = checked ? 'none' : '';
      if (!checked) {
        window.themeManager.setCustomAccent(window.storageManager.getSetting('accentColor') || '#6eb6ff');
      } else if (window.themeManager.extractedColors) {
        window.themeManager.setDynamicAccent(window.themeManager.extractedColors.accent);
      }
    };
  }

  // Accent picker
  const accentPicker = $('#setting-accent-picker');
  if (accentPicker) {
    accentPicker.value = window.storageManager.getSetting('accentColor') || '#6eb6ff';
    accentPicker.oninput = (e) => {
      const color = e.target.value;
      window.storageManager.saveSettings({ accentColor: color });
      window.themeManager.setCustomAccent(color);
    };
  }

  // Player Style
  const playerStyleSelect = $('#setting-player-style');
  if (playerStyleSelect) {
    playerStyleSelect.value = window.storageManager.getSetting('playerStyle') || 'cover';
    playerStyleSelect.onchange = () => window.themeManager.applyPlayerStyle(playerStyleSelect.value);
  }

  // Transition style
  const transSelect = $('#setting-transition-style');
  if (transSelect) {
    transSelect.value = window.storageManager.getSetting('transitionStyle') || 'slide';
    transSelect.onchange = () => window.themeManager.applyTransitionStyle(transSelect.value);
  }

  // Animation speed
  const speedSelect = $('#setting-anim-speed');
  if (speedSelect) {
    speedSelect.value = window.storageManager.getSetting('animSpeed') || '1x';
    speedSelect.onchange = () => window.themeManager.applyAnimSpeed(speedSelect.value);
  }

  // Reduce motion
  const reduceToggle = $('#setting-reduce-motion');
  if (reduceToggle) {
    reduceToggle.checked = window.storageManager.getSetting('reduceMotion') || false;
    reduceToggle.onchange = (e) => window.themeManager.applyReduceMotion(e.target.checked);
  }

  // Corner radius
  const radiusSelect = $('#setting-corner-radius');
  if (radiusSelect) {
    radiusSelect.value = window.storageManager.getSetting('cornerRadius') || 'medium';
    radiusSelect.onchange = () => window.themeManager.applyCornerRadius(radiusSelect.value);
  }

  // Blur intensity
  const blurSelect = $('#setting-blur-intensity');
  if (blurSelect) {
    blurSelect.value = window.storageManager.getSetting('blurIntensity') || 'medium';
    blurSelect.onchange = () => window.themeManager.applyBlurIntensity(blurSelect.value);
  }

  // Optional Custom Streaming Server URL
  const apiUrlInput = $('#setting-api-url');
  if (apiUrlInput) {
    try {
      apiUrlInput.value = localStorage.getItem('flyqa_api_url') || '';
    } catch (e) {}

    $('#btn-save-api-url')?.addEventListener('click', () => {
      const val = apiUrlInput.value.trim().replace(/\/+$/, '');
      try {
        if (val) localStorage.setItem('flyqa_api_url', val);
        else localStorage.removeItem('flyqa_api_url');
      } catch (e) {}
      searchCache.clear();
      showToast(val ? 'URL сервера сохранён' : 'Включён прямой HTTPS-режим');
    });

    $('#btn-reset-api-url')?.addEventListener('click', () => {
      apiUrlInput.value = '';
      try { localStorage.removeItem('flyqa_api_url'); } catch (e) {}
      searchCache.clear();
      showToast('Сброшено на прямой HTTPS-режим');
    });
  }
}

// ============================================================
//  11. Advanced Playlist Management UI (Cloud Sync + Guest Fallback)
// ============================================================
function isCloudSyncActive() {
  return !!(window.supabaseService && window.supabaseService.isAuthenticated());
}

function getGuestPlaylistsCache() {
  try {
    const raw = localStorage.getItem('glass_player_playlists_cache');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveGuestPlaylistsCache(playlists) {
  try {
    localStorage.setItem('glass_player_playlists_cache', JSON.stringify(playlists || []));
  } catch (e) {}
}

async function persistPlaylistOrder(playlistId, tracks) {
  if (isCloudSyncActive()) {
    await window.supabaseService.reorderPlaylistTracks(playlistId, tracks);
  } else {
    const apiBase = getCustomBackendApi();
    if (apiBase) {
      try {
        await fetch(`${apiBase}/playlists/${playlistId}/reorder`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks })
        });
      } catch (e) {}
    }
    const cached = getGuestPlaylistsCache();
    const pl = cached.find(p => String(p.id) === String(playlistId));
    if (pl) {
      pl.tracks = tracks;
      saveGuestPlaylistsCache(cached);
    }
  }
}

async function updatePlaylistMetadataRemote(playlistId, payload) {
  if (isCloudSyncActive()) {
    await window.supabaseService.updatePlaylist(playlistId, payload);
  } else {
    const apiBase = getCustomBackendApi();
    if (apiBase) {
      try {
        await fetch(`${apiBase}/playlists/${playlistId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {}
    }
    const cached = getGuestPlaylistsCache();
    const pl = cached.find(p => String(p.id) === String(playlistId));
    if (pl) {
      Object.assign(pl, payload);
      saveGuestPlaylistsCache(cached);
    }
  }
}

async function deletePlaylistRemote(playlistId) {
  if (isCloudSyncActive()) {
    await window.supabaseService.deletePlaylist(playlistId);
  } else {
    const apiBase = getCustomBackendApi();
    if (apiBase) {
      try {
        await fetch(`${apiBase}/playlists/${playlistId}`, { method: 'DELETE' });
      } catch (e) {}
    }
    const cached = getGuestPlaylistsCache().filter(p => String(p.id) !== String(playlistId));
    saveGuestPlaylistsCache(cached);
  }
}

async function loadPlaylists() {
  try {
    if (isCloudSyncActive()) {
      state.playlists = await window.supabaseService.getPlaylists();
    } else {
      const apiBase = getCustomBackendApi();
      if (apiBase) {
        try {
          const res = await fetch(`${apiBase}/playlists`);
          state.playlists = await res.json();
          saveGuestPlaylistsCache(state.playlists);
        } catch (offlineErr) {
          state.playlists = getGuestPlaylistsCache();
        }
      } else {
        state.playlists = getGuestPlaylistsCache();
      }
    }
    renderPlaylistSidebar();
  } catch (err) {
    console.error('Failed to load playlists:', err);
    if (isCloudSyncActive() && (err.code === '42P01' || err.code === 'PGRST205')) {
      showToast('Выполните supabase_schema.sql в Supabase SQL Editor для облачной БД');
    }
    state.playlists = [];
    renderPlaylistSidebar();
  }
}

function renderPlaylistSidebar() {
  const list = $('#playlist-list');
  if (list) {
    list.innerHTML = state.playlists.map(pl => {
      const idAttr = escapeAttr(String(pl.id));
      return `
      <button class="playlist-item ${String(state.currentPlaylistId) === String(pl.id) ? 'active' : ''}"
              data-id="${idAttr}"
              onclick="switchView('playlist', '${idAttr}')"
              oncontextmenu="handlePlaylistContext(event, '${idAttr}')">
        <span class="playlist-color-tag" style="background:${pl.color_tag || '#6eb6ff'};width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span>
        <span class="playlist-item-name">${escapeHTML(pl.name)}</span>
      </button>
    `;
    }).join('');
  }

  const mobileList = $('#mobile-playlists-list');
  const mobileSub = $('#mobile-playlists-subtitle');
  if (mobileSub) {
    mobileSub.textContent = state.playlists.length
      ? `${state.playlists.length} плейлистов`
      : 'Ваша коллекция музыки';
  }
  if (mobileList) {
    if (!state.playlists.length) {
      mobileList.innerHTML = '<div class="empty-state"><p>Плейлистов пока нет. Нажмите «Создать», чтобы добавить первый!</p></div>';
    } else {
      mobileList.innerHTML = state.playlists.map(pl => {
        const idAttr = escapeAttr(String(pl.id));
        const color = escapeAttr(pl.color_tag || '#6eb6ff');
        const coverHtml = pl.cover_image
          ? `<img src="${escapeAttr(pl.cover_image)}" alt="">`
          : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
        const count = Array.isArray(pl.tracks) ? pl.tracks.length : pl.track_count;
        const countText = typeof count === 'number' ? `${count} треков` : 'Открыть плейлист';
        return `
          <button class="mobile-playlist-card" data-id="${idAttr}" onclick="switchView('playlist', '${idAttr}')">
            <div class="mobile-pl-icon" style="background:${color}33;border:1px solid ${color}66;color:${color};">
              ${coverHtml}
            </div>
            <div class="mobile-pl-meta">
              <div class="mobile-pl-title">${escapeHTML(pl.name)}</div>
              <div class="mobile-pl-sub">${escapeHTML(pl.description || countText)}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        `;
      }).join('');
    }
  }
}

$('#btn-new-playlist')?.addEventListener('click', () => {
  showInputModal('Новый плейлист', 'Название', '', async (name) => {
    if (!name.trim()) return;
    try {
      let newPl;
      if (isCloudSyncActive()) {
        newPl = await window.supabaseService.createPlaylist({ name: name.trim(), color_tag: '#6eb6ff' });
      } else {
        const apiBase = getCustomBackendApi();
        if (apiBase) {
          try {
            const res = await fetch(`${apiBase}/playlists`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name.trim(), color_tag: '#6eb6ff' })
            });
            newPl = await res.json();
          } catch (offlineErr) {}
        }
        if (!newPl) {
          newPl = { id: 'local_' + Date.now(), name: name.trim(), color_tag: '#6eb6ff', tracks: [] };
          const cached = getGuestPlaylistsCache();
          cached.push(newPl);
          saveGuestPlaylistsCache(cached);
        }
      }
      await loadPlaylists();
      if (newPl?.id) switchView('playlist', newPl.id);
    } catch (err) {
      showToast('Ошибка создания плейлиста: ' + (err.message || err));
    }
  });
});

async function loadPlaylistTracks(playlistId) {
  try {
    const pl = state.playlists.find(p => String(p.id) === String(playlistId));
    state.currentPlaylistMeta = pl;

    if (pl) {
      $('#playlist-name-display').textContent = pl.name;
      $('#playlist-desc-display').textContent = pl.description || 'Нажмите «Изменить», чтобы добавить описание плейлиста.';
      $('#playlist-color-tag-indicator').style.background = pl.color_tag || '#6eb6ff';

      const customCover = $('#playlist-custom-cover');
      const fallbackCover = $('#playlist-cover-fallback');
      if (pl.cover_image && customCover) {
        customCover.src = pl.cover_image;
        customCover.style.display = 'block';
        if (fallbackCover) fallbackCover.style.display = 'none';
      } else {
        if (customCover) customCover.style.display = 'none';
        if (fallbackCover) fallbackCover.style.display = 'flex';
      }
    }

    let tracks = [];
    if (isCloudSyncActive()) {
      tracks = await window.supabaseService.getPlaylistTracks(playlistId);
    } else {
      const apiBase = getCustomBackendApi();
      let fetched = false;
      if (apiBase) {
        try {
          const res = await fetch(`${apiBase}/playlists/${playlistId}/tracks`);
          tracks = await res.json();
          fetched = true;
        } catch (offlineErr) {}
      }
      if (!fetched) {
        const cached = getGuestPlaylistsCache().find(p => String(p.id) === String(playlistId));
        tracks = cached?.tracks || [];
      }
    }

    window.playlistManager.setTracks(tracks);
    renderPlaylistTracks();
  } catch (err) {
    console.error('Failed to load playlist tracks:', err);
  }
}

function renderPlaylistTracks() {
  const container = $('#playlist-tracks');
  const statsDisplay = $('#playlist-stats-display');
  if (!container) return;

  const tracks = window.playlistManager.filteredTracks;
  if (statsDisplay) statsDisplay.textContent = `${tracks.length} треков`;

  if (!tracks.length) {
    container.innerHTML = '<div class="empty-state"><p>Плейлист пуст. Найдите музыку и добавьте её сюда!</p></div>';
    return;
  }

  const multiSelect = window.playlistManager.isMultiSelectMode;

  container.innerHTML = tracks.map((t, i) =>
    createTrackHTML(t, 'playlist', i, {
      multiSelect: multiSelect,
      isSelected: window.playlistManager.selectedTrackIds.has(String(t.id)),
      draggable: !multiSelect
    })
  ).join('');

  updateBatchActionBar();
}

// Single delegated Drag & Drop listener on #playlist-tracks (avoids per-render listener churn)
(function initPlaylistDragDelegation() {
  const container = $('#playlist-tracks');
  if (!container) return;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.track-item');
    if (!item || window.playlistManager.isMultiSelectMode) return;
    window.playlistManager.handleDragStart(e, parseInt(item.dataset.index));
  });

  container.addEventListener('dragover', (e) => {
    if (e.target.closest('.track-item')) {
      window.playlistManager.handleDragOver(e);
    }
  });

  container.addEventListener('drop', async (e) => {
    const item = e.target.closest('.track-item');
    if (!item || window.playlistManager.isMultiSelectMode) return;
    const moved = window.playlistManager.handleDrop(e, parseInt(item.dataset.index));
    if (moved && state.currentPlaylistId) {
      renderPlaylistTracks();
      await persistPlaylistOrder(state.currentPlaylistId, window.playlistManager.currentTracks);
      showToast('Порядок треков обновлён');
    }
  });
})();

// In-Playlist Live Search & Sorting
$('#playlist-search-input')?.addEventListener('input', (e) => {
  window.playlistManager.setSearchQuery(e.target.value);
  renderPlaylistTracks();
});

$('#playlist-sort-select')?.addEventListener('change', (e) => {
  window.playlistManager.setSortBy(e.target.value);
  renderPlaylistTracks();
});

// Multi-select & Batch Actions
$('#btn-toggle-multi-select')?.addEventListener('click', () => {
  window.playlistManager.isMultiSelectMode = !window.playlistManager.isMultiSelectMode;
  $('#btn-multi-select-label').textContent = window.playlistManager.isMultiSelectMode ? 'Отмена выбора' : 'Выбрать несколько';
  if (!window.playlistManager.isMultiSelectMode) {
    window.playlistManager.clearSelection();
  }
  renderPlaylistTracks();
});

function handleTrackCheckbox(trackId) {
  window.playlistManager.toggleTrackSelection(trackId);
  renderPlaylistTracks();
}

function updateBatchActionBar() {
  const bar = $('#batch-actions-bar');
  const countLabel = $('#batch-count-info');
  if (!bar) return;

  const count = window.playlistManager.getSelectedCount();
  if (count > 0) {
    bar.style.display = 'flex';
    if (countLabel) countLabel.textContent = `Выбрано: ${count}`;
  } else {
    bar.style.display = 'none';
  }
}

$('#btn-batch-select-all')?.addEventListener('click', () => {
  window.playlistManager.selectAll();
  renderPlaylistTracks();
});

$('#btn-batch-cancel')?.addEventListener('click', () => {
  window.playlistManager.clearSelection();
  window.playlistManager.isMultiSelectMode = false;
  $('#btn-multi-select-label').textContent = 'Выбрать несколько';
  renderPlaylistTracks();
});

$('#btn-batch-delete')?.addEventListener('click', async () => {
  const selectedIds = Array.from(window.playlistManager.selectedTrackIds);
  if (!selectedIds.length) return;
  if (!confirm(`Удалить выбранные треки (${selectedIds.length})?`)) return;

  if (isCloudSyncActive()) {
    await window.supabaseService.batchDeleteTracks(state.currentPlaylistId, selectedIds);
  } else {
    const apiBase = getCustomBackendApi();
    if (apiBase) {
      await fetch(`${apiBase}/playlists/${state.currentPlaylistId}/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackIds: selectedIds })
      });
    }
    const idSet = new Set(selectedIds.map(String));
    const cached = getGuestPlaylistsCache();
    const pl = cached.find(p => String(p.id) === String(state.currentPlaylistId));
    if (pl && Array.isArray(pl.tracks)) {
      pl.tracks = pl.tracks.filter(t => !idSet.has(String(t.id)));
      saveGuestPlaylistsCache(cached);
    }
  }

  window.playlistManager.clearSelection();
  await loadPlaylistTracks(state.currentPlaylistId);
  showToast('Выбранные треки удалены');
});

$('#btn-batch-move')?.addEventListener('click', () => {
  const selectedIds = Array.from(window.playlistManager.selectedTrackIds);
  if (!selectedIds.length) return;

  const otherPlaylists = state.playlists.filter(p => String(p.id) !== String(state.currentPlaylistId));
  if (!otherPlaylists.length) {
    alert('Сначала создайте ещё один плейлист, чтобы переместить треки.');
    return;
  }

  const items = otherPlaylists.map(pl => ({
    label: `📁 ${pl.name}`,
    action: async () => {
      if (isCloudSyncActive()) {
        await window.supabaseService.batchMoveTracks(state.currentPlaylistId, pl.id, selectedIds);
      } else {
        const apiBase = getCustomBackendApi();
        if (apiBase) {
          await fetch(`${apiBase}/playlists/${state.currentPlaylistId}/batch-move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackIds: selectedIds, targetPlaylistId: pl.id })
          });
        }
        const idSet = new Set(selectedIds.map(String));
        const cached = getGuestPlaylistsCache();
        const srcPl = cached.find(p => String(p.id) === String(state.currentPlaylistId));
        const dstPl = cached.find(p => String(p.id) === String(pl.id));
        if (srcPl && dstPl && Array.isArray(srcPl.tracks)) {
          const moved = srcPl.tracks.filter(t => idSet.has(String(t.id)));
          srcPl.tracks = srcPl.tracks.filter(t => !idSet.has(String(t.id)));
          dstPl.tracks = [...(dstPl.tracks || []), ...moved];
          saveGuestPlaylistsCache(cached);
        }
      }
      window.playlistManager.clearSelection();
      await loadPlaylistTracks(state.currentPlaylistId);
      showToast(`Перемещено в "${pl.name}"`);
    }
  }));

  showContextMenu({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, preventDefault: () => {} }, items);
});

// Custom Cover Image Upload
$('#playlist-cover-wrap')?.addEventListener('click', () => {
  $('#playlist-cover-file-input')?.click();
});

$('#playlist-cover-file-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || !state.currentPlaylistId) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const base64Data = evt.target.result;
    await updatePlaylistMetadataRemote(state.currentPlaylistId, { cover_image: base64Data });
    await loadPlaylists();
    await loadPlaylistTracks(state.currentPlaylistId);
    showToast('Обложка плейлиста обновлена');
  };
  reader.readAsDataURL(file);
});

// Edit Playlist Metadata Modal
$('#btn-edit-playlist-meta')?.addEventListener('click', () => {
  const pl = state.currentPlaylistMeta;
  if (!pl) return;

  showMetadataModal(pl.name, pl.description, pl.color_tag, async (newName, newDesc, newColor) => {
    await updatePlaylistMetadataRemote(state.currentPlaylistId, { name: newName, description: newDesc, color_tag: newColor });
    await loadPlaylists();
    await loadPlaylistTracks(state.currentPlaylistId);
    showToast('Метаданные плейлиста сохранены');
  });
});

$('#btn-delete-playlist')?.addEventListener('click', async () => {
  if (!state.currentPlaylistId) return;
  if (!confirm('Удалить плейлист?')) return;
  await deletePlaylistRemote(state.currentPlaylistId);
  state.currentPlaylistId = null;
  await loadPlaylists();
  switchView('search');
});

// ============================================================
//  12. Context Menu & Track Position Movements
// ============================================================
const contextMenu = $('#context-menu');

function showContextMenu(e, items) {
  if (e.preventDefault) e.preventDefault();
  contextMenu.innerHTML = items.map(item => {
    if (item.divider) return '<div class="context-menu-divider"></div>';
    return `<button class="context-menu-item ${item.danger ? 'danger' : ''}" onclick="this.contextAction()">${item.label}</button>`;
  }).join('');

  const buttons = contextMenu.querySelectorAll('.context-menu-item');
  let btnIdx = 0;
  items.forEach(item => {
    if (!item.divider) {
      buttons[btnIdx].contextAction = () => {
        hideContextMenu();
        item.action();
      };
      btnIdx++;
    }
  });

  contextMenu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth - 210);
  const y = Math.min(e.clientY, window.innerHeight - items.length * 40);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
}

function hideContextMenu() {
  if (contextMenu) contextMenu.style.display = 'none';
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.track-item') && !e.target.closest('.playlist-item')) {
    hideContextMenu();
  }
});

function handleTrackContext(e, el) {
  e.stopPropagation();
  const track = getTrackData(el);
  const context = el.dataset.context;
  const index = parseInt(el.dataset.index);

  const items = [
    { label: '▶ Воспроизвести', action: () => handleTrackClick(el, e) },
    { label: '+ В очередь воспроизведения', action: () => addToQueue(el) },
    { divider: true }
  ];

  // In Playlist view: reorder actions
  if (context === 'playlist') {
    items.push({
      label: '⬆ В самое начало',
      action: async () => {
        window.playlistManager.moveToTop(index);
        renderPlaylistTracks();
        await persistPlaylistOrder(state.currentPlaylistId, window.playlistManager.currentTracks);
      }
    });
    items.push({
      label: '⬇ В самый конец',
      action: async () => {
        window.playlistManager.moveToBottom(index);
        renderPlaylistTracks();
        await persistPlaylistOrder(state.currentPlaylistId, window.playlistManager.currentTracks);
      }
    });
    items.push({
      label: '🔢 Переместить на позицию...',
      action: () => {
        showInputModal('Переместить на позицию', 'Номер позиции (1, 2, ...)', `${index + 1}`, async (val) => {
          const target = parseInt(val);
          if (isNaN(target)) return;
          window.playlistManager.moveToPosition(index, target);
          renderPlaylistTracks();
          await persistPlaylistOrder(state.currentPlaylistId, window.playlistManager.currentTracks);
        });
      }
    });
    items.push({ divider: true });
  }

  // Add to other playlists submenu
  if (state.playlists.length > 0) {
    state.playlists.forEach(pl => {
      items.push({
        label: `📁 Добавить в: ${pl.name}`,
        action: () => addTrackToPlaylist(pl.id, track)
      });
    });
  }

  // Delete from playlist / queue
  if (context === 'playlist' || context === 'queue') {
    items.push({ divider: true });
    items.push({
      label: 'Удалить',
      danger: true,
      action: async () => {
        if (context === 'queue') {
          state.queue.splice(index, 1);
          if (state.queueIndex >= index) state.queueIndex--;
          updateQueueView();
        } else if (context === 'playlist' && track.id) {
          if (isCloudSyncActive()) {
            await window.supabaseService.deleteTrackFromPlaylist(track.id);
          } else {
            const apiBase = getCustomBackendApi();
            if (apiBase) {
              await fetch(`${apiBase}/tracks/${track.id}`, { method: 'DELETE' });
            }
            const cached = getGuestPlaylistsCache();
            const pl = cached.find(p => String(p.id) === String(state.currentPlaylistId));
            if (pl && Array.isArray(pl.tracks)) {
              pl.tracks = pl.tracks.filter(t => String(t.id) !== String(track.id));
              saveGuestPlaylistsCache(cached);
            }
          }
          await loadPlaylistTracks(state.currentPlaylistId);
        }
      }
    });
  }

  showContextMenu(e, items);
}

function handlePlaylistContext(e, playlistId) {
  e.preventDefault();
  e.stopPropagation();
  const pl = state.playlists.find(p => String(p.id) === String(playlistId));

  showContextMenu(e, [
    {
      label: 'Открыть плейлист',
      action: () => switchView('playlist', playlistId)
    },
    {
      label: 'Переименовать',
      action: () => {
        showInputModal('Переименовать плейлист', 'Новое название', pl.name, async (name) => {
          if (!name.trim()) return;
          await updatePlaylistMetadataRemote(playlistId, { name: name.trim() });
          await loadPlaylists();
          if (String(state.currentPlaylistId) === String(playlistId)) loadPlaylistTracks(playlistId);
        });
      }
    },
    { divider: true },
    {
      label: 'Удалить плейлист',
      danger: true,
      action: async () => {
        if (!confirm(`Удалить плейлист "${pl.name}"?`)) return;
        await deletePlaylistRemote(playlistId);
        if (String(state.currentPlaylistId) === String(playlistId)) {
          state.currentPlaylistId = null;
          switchView('search');
        }
        await loadPlaylists();
      }
    }
  ]);
}

let pendingPlaylistTrack = null;

function isTrackDuplicate(existingTracks, track) {
  if (!Array.isArray(existingTracks) || !track) return false;
  const targetVid = (track.videoId || track.video_id || '').trim();
  const targetLocal = (track.localPath || track.local_path || '').trim();
  const targetUrl = (track.webpageUrl || track.webpage_url || '').trim();
  const targetTitle = (track.title || '').trim().toLowerCase();
  const targetArtist = (track.artist || '').trim().toLowerCase();

  return existingTracks.some((item) => {
    const itemVid = (item.video_id || item.videoId || '').trim();
    const itemLocal = (item.local_path || item.localPath || '').trim();
    const itemUrl = (item.webpage_url || item.webpageUrl || '').trim();
    if (targetVid && itemVid && targetVid === itemVid) return true;
    if (targetLocal && itemLocal && targetLocal === itemLocal) return true;
    if (targetUrl && itemUrl && targetUrl === itemUrl) return true;
    const itemTitle = (item.title || '').trim().toLowerCase();
    const itemArtist = (item.artist || '').trim().toLowerCase();
    return Boolean(targetTitle && itemTitle === targetTitle && itemArtist === targetArtist);
  });
}

function renderAddToPlaylistSheetList() {
  const listEl = $('#sheet-playlists-list');
  if (!listEl) return;

  if (!state.playlists.length) {
    listEl.innerHTML = '<div class="ios-sheet-empty">Плейлистов пока нет. Создайте первый прямо сейчас!</div>';
    return;
  }

  listEl.innerHTML = state.playlists.map((pl) => {
    const idAttr = escapeAttr(String(pl.id));
    const color = escapeAttr(pl.color_tag || '#6eb6ff');
    const coverHtml = pl.cover_image
      ? `<img src="${escapeAttr(pl.cover_image)}" alt="">`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const count = Array.isArray(pl.tracks) ? pl.tracks.length : pl.track_count;
    const subText = typeof count === 'number' ? `${count} треков` : 'Нажмите, чтобы добавить';
    return `
      <button type="button" class="ios-sheet-pl-item" data-playlist-id="${idAttr}">
        <div class="ios-sheet-pl-icon" style="background:${color}33;border:1px solid ${color}66;color:${color};">
          ${coverHtml}
        </div>
        <div class="ios-sheet-pl-meta">
          <div class="ios-sheet-pl-name">${escapeHTML(pl.name)}</div>
          <div class="ios-sheet-pl-sub">${escapeHTML(subText)}</div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity="0.65"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    `;
  }).join('');
}

function openAddToPlaylistSheet(track) {
  if (!track || !track.title) return;
  const overlay = $('#add-to-playlist-overlay');
  if (!overlay) return;

  pendingPlaylistTrack = { ...track };

  const coverImg = $('#sheet-track-cover');
  const coverFallback = $('#sheet-track-fallback');
  const trackNameEl = $('#sheet-track-name');

  if (trackNameEl) {
    trackNameEl.textContent = track.artist ? `${track.title} — ${track.artist}` : track.title;
  }
  if (coverImg && coverFallback) {
    if (track.thumbnail) {
      coverImg.src = track.thumbnail;
      coverImg.style.display = 'block';
      coverFallback.style.display = 'none';
    } else {
      coverImg.style.display = 'none';
      coverFallback.style.display = 'flex';
    }
  }

  renderAddToPlaylistSheetList();

  overlay.classList.remove('is-closing');
  overlay.style.display = 'flex';
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => overlay.classList.add('is-open'));
}

function closeAddToPlaylistSheet() {
  const overlay = $('#add-to-playlist-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  overlay.classList.remove('is-open');
  overlay.classList.add('is-closing');
  overlay.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('is-closing');
  }, 340);
}

window.openAddToPlaylistSheet = openAddToPlaylistSheet;
window.closeAddToPlaylistSheet = closeAddToPlaylistSheet;

function initAddToPlaylistSheetUI() {
  const overlay = $('#add-to-playlist-overlay');
  const closeBtn = $('#btn-close-playlist-sheet');
  const createBtn = $('#btn-sheet-create-playlist');
  const listEl = $('#sheet-playlists-list');

  closeBtn?.addEventListener('click', closeAddToPlaylistSheet);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeAddToPlaylistSheet();
  });

  listEl?.addEventListener('click', async (e) => {
    const itemBtn = e.target.closest('.ios-sheet-pl-item');
    if (!itemBtn || !pendingPlaylistTrack) return;
    const playlistId = itemBtn.dataset.playlistId;
    const trackToSave = pendingPlaylistTrack;
    itemBtn.disabled = true;
    try {
      const result = await addTrackToPlaylist(playlistId, trackToSave);
      if (result && result.added) {
        closeAddToPlaylistSheet();
      }
    } finally {
      itemBtn.disabled = false;
    }
  });

  createBtn?.addEventListener('click', () => {
    const trackToSave = pendingPlaylistTrack;
    showInputModal('Новый плейлист', 'Название плейлиста', '', async (name) => {
      if (!name || !name.trim()) return;
      const cleanName = name.trim();
      try {
        let newPl;
        if (isCloudSyncActive()) {
          newPl = await window.supabaseService.createPlaylist({ name: cleanName, color_tag: '#6eb6ff' });
        } else {
          const apiBase = getCustomBackendApi();
          if (apiBase) {
            try {
              const res = await fetch(`${apiBase}/playlists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cleanName, color_tag: '#6eb6ff' })
              });
              newPl = await res.json();
            } catch (offlineErr) {}
          }
          if (!newPl) {
            newPl = { id: 'local_' + Date.now(), name: cleanName, color_tag: '#6eb6ff', tracks: [] };
            const cached = getGuestPlaylistsCache();
            cached.push(newPl);
            saveGuestPlaylistsCache(cached);
          }
        }
        await loadPlaylists();
        if (newPl?.id && trackToSave) {
          await addTrackToPlaylist(newPl.id, trackToSave);
          closeAddToPlaylistSheet();
        } else {
          renderAddToPlaylistSheetList();
        }
      } catch (err) {
        showToast('Ошибка создания плейлиста: ' + (err.message || err));
      }
    });
  });
}

async function addTrackToPlaylist(playlistId, track) {
  const pl = state.playlists.find(p => String(p.id) === String(playlistId));
  const plName = pl ? pl.name : 'плейлист';

  try {
    if (isCloudSyncActive()) {
      const existing = await window.supabaseService.getPlaylistTracks(playlistId);
      if (isTrackDuplicate(existing, track)) {
        showToast(`Трек уже есть в плейлисте «${plName}»`);
        return { added: false, duplicate: true };
      }
      await window.supabaseService.addTrackToPlaylist(playlistId, track);
    } else {
      const cached = getGuestPlaylistsCache();
      const targetPl = cached.find(p => String(p.id) === String(playlistId));
      const existingTracks = targetPl?.tracks || [];

      if (isTrackDuplicate(existingTracks, track)) {
        showToast(`Трек уже есть в плейлисте «${plName}»`);
        return { added: false, duplicate: true };
      }

      const apiBase = getCustomBackendApi();
      if (apiBase) {
        try {
          await fetch(`${apiBase}/playlists/${playlistId}/tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: track.title,
              artist: track.artist,
              duration: track.duration,
              videoId: track.videoId,
              thumbnail: track.thumbnail,
              source: track.source || 'youtube',
              localPath: track.localPath,
              webpageUrl: track.webpageUrl
            })
          });
        } catch (offlineErr) {}
      }

      if (targetPl) {
        targetPl.tracks = targetPl.tracks || [];
        targetPl.tracks.push({
          id: 'trk_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          title: track.title,
          artist: track.artist || '',
          duration: track.duration || '',
          video_id: track.videoId || track.video_id || '',
          thumbnail: track.thumbnail || '',
          source: track.source || 'saavn',
          local_path: track.localPath || track.local_path || '',
          webpage_url: track.webpageUrl || track.webpage_url || '',
          scTranscodingUrl: track.scTranscodingUrl || '',
          scTrackAuth: track.scTrackAuth || ''
        });
        saveGuestPlaylistsCache(cached);
        if (pl) pl.tracks = targetPl.tracks;
        renderPlaylistSidebar();
      }
    }

    showToast(`Трек добавлен в ${plName}`);

    if (String(state.currentPlaylistId) === String(playlistId)) {
      loadPlaylistTracks(playlistId);
    }
    return { added: true, duplicate: false };
  } catch (err) {
    console.error('Failed to add track:', err);
    showToast('Ошибка добавления трека');
    return { added: false, error: err };
  }
}

// ============================================================
//  13. Local Files Loading
// ============================================================
$('#btn-open-files')?.addEventListener('click', async () => {
  let files = [];
  if (window.electronAPI) {
    files = await window.electronAPI.openFileDialog();
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*';
    input.click();
    await new Promise(resolve => {
      input.onchange = () => {
        files = Array.from(input.files).map(f => f.name);
        resolve();
      };
    });
  }

  if (!files || !files.length) return;

  const container = $('#local-files-list');
  const tracks = files.map((fp, i) => {
    const name = fp.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
    return {
      title: name,
      artist: 'Локальный файл',
      duration: '',
      videoId: '',
      thumbnail: '',
      source: 'local',
      localPath: fp
    };
  });

  container.innerHTML = tracks.map((t, i) => createTrackHTML(t, 'local', i)).join('');
});

// ============================================================
//  14. Color Extraction (Adaptive Dynamic Background)
// ============================================================
function applyExtractedPalette(palette) {
  bgCanvas.style.setProperty('--bg-color-1', palette.bg1);
  bgCanvas.style.setProperty('--bg-color-2', palette.bg2);
  bgCanvas.classList.add('active');

  const fsOverlay = $('#fullscreen-player');
  if (fsOverlay) {
    fsOverlay.style.setProperty('--fs-accent-1', palette.accent);
    fsOverlay.style.setProperty('--fs-accent-2', palette.secondary);
  }

  window.themeManager.onTrackColorsExtracted({ accent: palette.accent, secondary: palette.secondary });
}

function extractColors(imageUrl) {
  if (!imageUrl) return;
  if (colorCache.has(imageUrl)) {
    applyExtractedPalette(colorCache.get(imageUrl));
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;

      let r1 = 0, g1 = 0, b1 = 0, count1 = 0;
      let r2 = 0, g2 = 0, b2 = 0, count2 = 0;

      for (let i = 0; i < data.length; i += 16) {
        const x = (i / 4) % 64;
        const y = Math.floor((i / 4) / 64);
        const r = data[i], g = data[i+1], b = data[i+2];

        if (x < 32 && y < 32) {
          r1 += r; g1 += g; b1 += b; count1++;
        } else {
          r2 += r; g2 += g; b2 += b; count2++;
        }
      }

      if (count1) { r1 /= count1; g1 /= count1; b1 /= count1; }
      if (count2) { r2 /= count2; g2 /= count2; b2 /= count2; }

      const darken = 0.45;
      const hexAccent = `#${((1 << 24) + ((r1 & 255) << 16) + ((g1 & 255) << 8) + (b1 & 255)).toString(16).slice(1)}`;
      const hexSec = `#${((1 << 24) + ((r2 & 255) << 16) + ((g2 & 255) << 8) + (b2 & 255)).toString(16).slice(1)}`;
      const palette = {
        bg1: `rgb(${r1*darken}, ${g1*darken}, ${b1*darken})`,
        bg2: `rgb(${r2*darken}, ${g2*darken}, ${b2*darken})`,
        accent: hexAccent,
        secondary: hexSec
      };

      colorCache.set(imageUrl, palette);
      applyExtractedPalette(palette);
    } catch (e) {
      bgCanvas.style.setProperty('--bg-color-1', '#1a1a3e');
      bgCanvas.style.setProperty('--bg-color-2', '#2a1a2e');
      bgCanvas.classList.add('active');
    }
  };
  img.onerror = () => {
    bgCanvas.style.setProperty('--bg-color-1', '#1a1a3e');
    bgCanvas.style.setProperty('--bg-color-2', '#2a1a2e');
    bgCanvas.classList.add('active');
  };
  img.src = imageUrl;
}

// ============================================================
//  15. Modal Dialogs & Helpers
// ============================================================
function showInputModal(title, placeholder, defaultValue, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-title">${escapeHTML(title)}</div>
      <input class="modal-input" type="text" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(defaultValue)}">
      <div class="modal-buttons">
        <button class="modal-btn secondary" id="modal-cancel">Отмена</button>
        <button class="modal-btn primary" id="modal-ok">OK</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const input = overlay.querySelector('.modal-input');
  input.focus();
  input.select();

  const close = () => {
    if (overlay.classList.contains('is-closing')) return;
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 340);
  };
  overlay.querySelector('#modal-cancel').addEventListener('click', close);
  overlay.querySelector('#modal-ok').addEventListener('click', () => {
    onConfirm(input.value);
    close();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { onConfirm(input.value); close(); }
    if (e.key === 'Escape') close();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function showMetadataModal(currentName, currentDesc, currentColor, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-title">Настройки плейлиста</div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <label style="font-size:12px;color:var(--text-secondary);">Название:</label>
        <input class="modal-input" id="meta-name" type="text" value="${escapeAttr(currentName)}">
        <label style="font-size:12px;color:var(--text-secondary);">Описание:</label>
        <input class="modal-input" id="meta-desc" type="text" placeholder="Описание плейлиста..." value="${escapeAttr(currentDesc || '')}">
        <label style="font-size:12px;color:var(--text-secondary);">Цветовой тег:</label>
        <input type="color" id="meta-color" value="${currentColor || '#6eb6ff'}" style="width:100%;height:38px;border-radius:8px;border:none;cursor:pointer;">
      </div>
      <div class="modal-buttons">
        <button class="modal-btn secondary" id="modal-cancel">Отмена</button>
        <button class="modal-btn primary" id="modal-ok">Сохранить</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => {
    if (overlay.classList.contains('is-closing')) return;
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 340);
  };
  overlay.querySelector('#modal-cancel').addEventListener('click', close);
  overlay.querySelector('#modal-ok').addEventListener('click', () => {
    const name = overlay.querySelector('#meta-name').value;
    const desc = overlay.querySelector('#meta-desc').value;
    const color = overlay.querySelector('#meta-color').value;
    onConfirm(name, desc, color);
    close();
  });
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 105px; left: 50%; transform: translateX(-50%);
    padding: 10px 24px; background: rgba(30, 30, 42, 0.94); backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 14px;
    color: rgba(255, 255, 255, 0.96); font-size: 13px; font-weight: 500; z-index: 9950;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); animation: modalIn 0.3s ease;
    max-width: calc(100vw - 32px); text-align: center;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHTML(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Global Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  const isF = (e.code === 'KeyF' || e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') && !e.ctrlKey && !e.altKey && !e.metaKey;

  if (isF) {
    e.preventDefault();
    toggleFullscreenPlayer();
  } else if (e.code === 'Escape') {
    if (isFullscreenActive()) {
      closeFullscreenPlayer();
    }
  } else if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowRight' && (e.ctrlKey || isFullscreenActive())) {
    playNext();
  } else if (e.code === 'ArrowLeft' && (e.ctrlKey || isFullscreenActive())) {
    playPrev();
  }
});

// ============================================================
//  16. Supabase Auth UI & Initialization
// ============================================================
function formatAuthError(err) {
  const msg = (err && err.message ? err.message : String(err || '')).toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Неверный email или пароль';
  if (msg.includes('user already registered')) return 'Пользователь с таким email уже зарегистрирован';
  if (msg.includes('password should be at least')) return 'Пароль должен содержать минимум 6 символов';
  if (msg.includes('unable to validate email')) return 'Введите корректный email адрес';
  if (msg.includes('email not confirmed')) return 'Подтвердите email адрес через письмо на вашей почте';
  if (msg.includes('rate limit')) return 'Слишком много попыток. Подождите немного и попробуйте снова';
  return err?.message || 'Ошибка авторизации';
}

function updateAuthProfileUI(user, profile) {
  const guestCard = $('#profile-guest-card');
  const userCard = $('#profile-user-card');
  const avatarEl = $('#profile-avatar');
  const usernameEl = $('#profile-username');

  if (!guestCard || !userCard) return;

  const iosAuthLabel = $('#ios-auth-label');

  if (user) {
    guestCard.style.display = 'none';
    userCard.style.display = 'flex';
    const displayName =
      profile?.username ||
      user.user_metadata?.username ||
      (user.email ? user.email.split('@')[0] : 'flyqa');
    if (usernameEl) usernameEl.textContent = displayName;
    if (iosAuthLabel) iosAuthLabel.textContent = displayName;
    if (avatarEl) {
      if (profile?.avatar_url) {
        avatarEl.innerHTML = `<img src="${escapeAttr(profile.avatar_url)}" alt="">`;
      } else {
        avatarEl.textContent = displayName.charAt(0).toUpperCase();
      }
    }
  } else {
    guestCard.style.display = 'flex';
    userCard.style.display = 'none';
    if (iosAuthLabel) iosAuthLabel.textContent = 'Войти';
  }
}

function initAuthUI() {
  const overlay = $('#auth-modal-overlay');
  const tabLogin = $('#auth-tab-login');
  const tabRegister = $('#auth-tab-register');
  const usernameGroup = $('#auth-username-group');
  const usernameInput = $('#auth-username');
  const emailInput = $('#auth-email');
  const passwordInput = $('#auth-password');
  const form = $('#auth-form');
  const errorBox = $('#auth-error-msg');
  const successBox = $('#auth-success-msg');
  const submitBtn = $('#auth-submit-btn');
  const btnText = $('#auth-btn-text');
  const btnSpinner = $('#auth-btn-spinner');
  const modalTitle = $('#auth-modal-title');

  let authMode = 'login';

  const setAuthMode = (mode) => {
    authMode = mode;
    tabLogin?.classList.toggle('active', mode === 'login');
    tabRegister?.classList.toggle('active', mode === 'register');
    if (usernameGroup) usernameGroup.style.display = mode === 'register' ? 'flex' : 'none';
    if (modalTitle) modalTitle.textContent = mode === 'login' ? 'Вход в flyqa' : 'Создать аккаунт';
    if (btnText) btnText.textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    if (passwordInput) passwordInput.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    if (errorBox) errorBox.style.display = 'none';
    if (successBox) successBox.style.display = 'none';
  };

  const openAuthModal = (defaultMode = 'login') => {
    if (!overlay) return;
    setAuthMode(defaultMode);
    overlay.classList.remove('is-closing');
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    setTimeout(() => emailInput?.focus(), 120);
  };

  const closeAuthModal = () => {
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');
    overlay.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.classList.remove('is-closing');
    }, 340);
  };

  $('#btn-open-auth')?.addEventListener('click', () => openAuthModal('login'));
  $('#btn-close-auth')?.addEventListener('click', closeAuthModal);
  $('#btn-continue-guest')?.addEventListener('click', closeAuthModal);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeAuthModal();
  });

  tabLogin?.addEventListener('click', () => setAuthMode('login'));
  tabRegister?.addEventListener('click', () => setAuthMode('register'));

  $('#btn-logout')?.addEventListener('click', async () => {
    try {
      await window.supabaseService?.signOut();
      state.currentPlaylistId = null;
      if (state.currentView === 'playlist') switchView('search');
      updateAuthProfileUI(null, null);
      await loadPlaylists();
      showToast('Вы вышли из аккаунта (Гостевой режим)');
    } catch (err) {
      showToast('Ошибка выхода: ' + (err.message || err));
    }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorBox) errorBox.style.display = 'none';
    if (successBox) successBox.style.display = 'none';

    const email = (emailInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const username = (usernameInput?.value || '').trim();

    if (!email || !email.includes('@')) {
      if (errorBox) {
        errorBox.textContent = 'Введите корректный email адрес';
        errorBox.style.display = 'block';
      }
      return;
    }
    if (password.length < 6) {
      if (errorBox) {
        errorBox.textContent = 'Пароль должен содержать минимум 6 символов';
        errorBox.style.display = 'block';
      }
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (btnSpinner) btnSpinner.style.display = 'inline-block';

    try {
      if (authMode === 'login') {
        const res = await window.supabaseService.signIn(email, password);
        updateAuthProfileUI(res.user, res.profile);
        closeAuthModal();
        state.currentPlaylistId = null;
        await loadPlaylists();
        showToast('Вход выполнен! Плейлисты синхронизированы');
      } else {
        const res = await window.supabaseService.signUp(email, password, username);
        if (res.needsEmailConfirmation) {
          if (successBox) {
            successBox.textContent = 'Аккаунт создан! Проверьте почту и перейдите по ссылке подтверждения, затем войдите.';
            successBox.style.display = 'block';
          }
        } else {
          updateAuthProfileUI(res.user, window.supabaseService.getProfile());
          closeAuthModal();
          state.currentPlaylistId = null;
          await loadPlaylists();
          showToast('Регистрация завершена! Добро пожаловать в flyqa');
        }
      }
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = formatAuthError(err);
        errorBox.style.display = 'block';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (btnSpinner) btnSpinner.style.display = 'none';
    }
  });
}

function initSplashScreen() {
  const splash = $('#flyqa-splash');
  if (!splash) return;

  // Keep splash visible for ~1.5s before seamless 0.45s fade-out (~1.95s total)
  const minDisplayMs = 1500;
  const elapsed = performance.now();
  const remaining = Math.max(350, minDisplayMs - elapsed);

  setTimeout(() => {
    splash.classList.add('splash-exit');
    splash.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      splash.remove();
    }, 460);
  }, remaining);
}

window.addEventListener('DOMContentLoaded', async () => {
  window.themeManager.init();
  initVisualizerUI();
  initSettingsUI();
  initFullscreenPlayerUI();
  initAddToPlaylistSheetUI();
  initAuthUI();
  updateShuffleButtonUI();
  updateRepeatButtonUI();

  if (window.supabaseService) {
    await window.supabaseService.init();
    updateAuthProfileUI(window.supabaseService.getUser(), window.supabaseService.getProfile());
    window.supabaseService.onAuthChange(async (event, user, profile) => {
      updateAuthProfileUI(user, profile);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        await loadPlaylists();
      }
    });
  }

  await loadPlaylists();
  initSplashScreen();
});
