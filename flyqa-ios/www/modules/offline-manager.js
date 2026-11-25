// ============================================================
//  Offline Manager — IndexedDB Audio Cache & Download Queue
// ============================================================

(function (global) {
  const DB_NAME = 'flyqa_offline_db';
  const DB_VERSION = 2;
  const STORE_NAME = 'tracks';

  class OfflineManager {
    constructor() {
      this.db = null;
      this.downloadedMap = new Map(); // key -> metadata (without blob for fast sync lookups)
      this.downloadingKeys = new Set();
      this.objectUrls = new Map(); // key -> blob: URL
      this._initPromise = null;
      this._listeners = new Set();
    }

    getTrackKey(track) {
      if (!track) return '';
      if (typeof track === 'string') return track;
      const vid = (track.videoId || track.video_id || '').trim();
      if (vid) return `vid:${vid}`;
      const lp = (track.localPath || track.local_path || '').trim();
      if (lp) return `loc:${lp}`;
      const url = (track.webpageUrl || track.webpage_url || '').trim();
      if (url) return `url:${url}`;
      const title = (track.title || '').trim().toLowerCase();
      const artist = (track.artist || '').trim().toLowerCase();
      return title ? `meta:${artist}|${title}` : '';
    }

    onChange(cb) {
      if (typeof cb === 'function') this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    }

    _emitChange() {
      this._listeners.forEach((cb) => {
        try { cb(); } catch (e) {}
      });
    }

    async init() {
      if (this.db) return this.db;
      if (this._initPromise) return this._initPromise;

      this._initPromise = new Promise((resolve) => {
        if (!('indexedDB' in global)) {
          resolve(null);
          return;
        }
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (db.objectStoreNames.contains(STORE_NAME)) {
              // Purge legacy v1 preview entries cleanly on schema upgrade
              try { db.deleteObjectStore(STORE_NAME); } catch (err) {}
            }
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          };
          req.onsuccess = async (e) => {
            this.db = e.target.result;
            await this._loadIndex();
            resolve(this.db);
          };
          req.onerror = () => {
            console.warn('[flyqa] IndexedDB open failed');
            resolve(null);
          };
        } catch (err) {
          resolve(null);
        }
      });

      return this._initPromise;
    }

    async _loadIndex() {
      if (!this.db) return;
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();
          req.onsuccess = () => {
            this.downloadedMap.clear();
            const rows = req.result || [];
            rows.forEach((row) => {
              if (row && row.key) {
                this.downloadedMap.set(row.key, {
                  key: row.key,
                  track: row.track,
                  sizeBytes: row.sizeBytes || (row.blob ? row.blob.size : 0),
                  downloadedAt: row.downloadedAt || Date.now()
                });
              }
            });
            this._emitChange();
            resolve();
          };
          req.onerror = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    }

    isDownloaded(track) {
      const key = this.getTrackKey(track);
      return Boolean(key && this.downloadedMap.has(key));
    }

    isDownloading(track) {
      const key = this.getTrackKey(track);
      return Boolean(key && this.downloadingKeys.has(key));
    }

    getAllTracks() {
      return Array.from(this.downloadedMap.values())
        .sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0))
        .map((entry) => ({
          ...entry.track,
          offlineKey: entry.key,
          sizeBytes: entry.sizeBytes,
          downloadedAt: entry.downloadedAt
        }));
    }

    getTotalSizeMB() {
      let bytes = 0;
      this.downloadedMap.forEach((entry) => { bytes += entry.sizeBytes || 0; });
      return (bytes / (1024 * 1024)).toFixed(1);
    }

    async _getRecord(key) {
      await this.init();
      if (!this.db || !key) return null;
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }

    async getOfflineAudioUrl(track) {
      const key = this.getTrackKey(track);
      if (!key || !this.downloadedMap.has(key)) return '';

      if (this.objectUrls.has(key)) {
        return this.objectUrls.get(key);
      }

      const record = await this._getRecord(key);
      if (!record || !record.blob) return '';

      try {
        const blobUrl = URL.createObjectURL(record.blob);
        this.objectUrls.set(key, blobUrl);
        return blobUrl;
      } catch (e) {
        return '';
      }
    }

    async saveBlobTrack(track, blob) {
      await this.init();
      const key = this.getTrackKey(track);
      if (!this.db || !key || !blob) throw new Error('Хранилище недоступно');

      const cleanTrack = {
        id: track.id || key,
        videoId: track.videoId || track.video_id || '',
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
        duration: track.duration || '',
        thumbnail: track.thumbnail || '',
        source: track.source || 'offline',
        localPath: track.localPath || track.local_path || '',
        webpageUrl: track.webpageUrl || track.webpage_url || ''
      };

      const record = {
        key,
        track: cleanTrack,
        blob,
        mimeType: blob.type || 'audio/mp4',
        sizeBytes: blob.size || 0,
        downloadedAt: Date.now()
      };

      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      });

      this.downloadedMap.set(key, {
        key,
        track: cleanTrack,
        sizeBytes: record.sizeBytes,
        downloadedAt: record.downloadedAt
      });
      this._emitChange();
      return cleanTrack;
    }

    _parseDurationSeconds(durStr) {
      if (!durStr) return 0;
      if (typeof durStr === 'number') return durStr;
      const parts = String(durStr).split(':').map(Number);
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
      if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return 0;
    }

    _isValidFullBlob(blob, expectedContentLength, track) {
      if (!blob) return false;
      const type = (blob.type || '').toLowerCase();
      if (type.includes('text/html') || type.includes('application/json') || type.includes('mpegurl')) {
        return false;
      }
      if (expectedContentLength > 0 && blob.size < expectedContentLength * 0.95) {
        return false;
      }
      const durSec = this._parseDurationSeconds(track?.duration);
      // Full-length tracks (60s+) must be at least 1.0 MB; shorter tracks at least 450 KB
      const minBytes = durSec >= 60 || durSec === 0 ? 1024 * 1024 : 450 * 1024;
      return blob.size >= minBytes;
    }

    async _fetchFullAudioBlob(url, track) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
      try {
        const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!response.ok) return null;
        const clHeader = response.headers.get('content-length');
        const expectedLen = clHeader ? parseInt(clHeader, 10) : 0;
        const blob = await response.blob();
        if (!this._isValidFullBlob(blob, expectedLen, track)) {
          return null;
        }
        return blob;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async _downloadHlsFmp4AsBlob(m3u8Url, track) {
      const isLocalDev = global.location &&
        (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1') &&
        global.location.port === '3457';
      const fetchVia = async (u) => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
        try {
          try {
            const r = await fetch(u, controller ? { signal: controller.signal } : undefined);
            if (r.ok) return r;
          } catch (e) {}
          if (isLocalDev) {
            return await fetch(`/api/proxy-audio?url=${encodeURIComponent(u)}`, controller ? { signal: controller.signal } : undefined);
          }
          throw new Error('HLS fetch failed');
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const m3u8Res = await fetchVia(m3u8Url);
      if (!m3u8Res || !m3u8Res.ok) return null;
      const text = await m3u8Res.text();
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      const segmentUrls = [];
      for (const line of lines) {
        if (line.startsWith('#EXT-X-MAP:')) {
          const m = line.match(/URI="([^"]+)"/i);
          if (m && m[1]) segmentUrls.push(new URL(m[1], m3u8Url).toString());
        } else if (!line.startsWith('#')) {
          segmentUrls.push(new URL(line, m3u8Url).toString());
        }
      }
      if (!segmentUrls.length) return null;

      // Download segments in parallel batches of 6 for fast assembly
      const buffers = new Array(segmentUrls.length);
      const BATCH_SIZE = 6;
      for (let i = 0; i < segmentUrls.length; i += BATCH_SIZE) {
        const batch = segmentUrls.slice(i, i + BATCH_SIZE);
        const batchData = await Promise.all(batch.map(async (segUrl) => {
          const segRes = await fetchVia(segUrl);
          if (!segRes || !segRes.ok) throw new Error('Segment fetch failed');
          return segRes.arrayBuffer();
        }));
        for (let j = 0; j < batchData.length; j++) {
          buffers[i + j] = batchData[j];
        }
      }
      const blob = new Blob(buffers, { type: 'audio/mp4' });
      return this._isValidFullBlob(blob, 0, track) ? blob : null;
    }

    async downloadTrack(track, resolveStreamUrlFn) {
      await this.init();
      const key = this.getTrackKey(track);
      if (!key) throw new Error('Некорректный трек');
      if (this.downloadedMap.has(key)) {
        return { alreadyDownloaded: true, key };
      }
      if (this.downloadingKeys.has(key)) {
        return { inProgress: true, key };
      }

      this.downloadingKeys.add(key);
      this._emitChange();

      try {
        let streamUrl = '';
        if (typeof resolveStreamUrlFn === 'function') {
          streamUrl = await resolveStreamUrlFn(track);
        } else if (track.webpageUrl || track.webpage_url) {
          streamUrl = track.webpageUrl || track.webpage_url;
        }

        if (!streamUrl) {
          throw new Error('Полный аудиопоток для скачивания недоступен');
        }

        let blob = null;
        if (/\.m3u8(\?|$)|mpegurl/i.test(streamUrl)) {
          blob = await this._downloadHlsFmp4AsBlob(streamUrl, track);
          if (!blob && typeof global.resolveProgressiveAudioFallback === 'function') {
            const progUrl = await global.resolveProgressiveAudioFallback(track);
            if (progUrl) {
              streamUrl = progUrl;
            }
          }
        }

        if (!blob && !/\.m3u8(\?|$)|mpegurl/i.test(streamUrl)) {
          try {
            blob = await this._fetchFullAudioBlob(streamUrl, track);
          } catch (directErr) {
            // Direct fetch failed (e.g. CORS on localhost) — try progressive full-length fallback or dev proxy
          }
        }

        if (!blob && typeof global.resolveProgressiveAudioFallback === 'function') {
          try {
            const progUrl = await global.resolveProgressiveAudioFallback(track);
            if (progUrl && progUrl !== streamUrl) {
              blob = await this._fetchFullAudioBlob(progUrl, track);
            }
          } catch (fbErr) {}
        }

        if (!blob &&
            !/\.m3u8(\?|$)|mpegurl/i.test(streamUrl) &&
            global.location &&
            (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1') &&
            global.location.port === '3457') {
          blob = await this._fetchFullAudioBlob(`/api/proxy-audio?url=${encodeURIComponent(streamUrl)}`, track);
        }

        if (!blob) {
          throw new Error('Не удалось скачать полный аудиофайл (файл повреждён или неполный)');
        }

        await this.saveBlobTrack(track, blob);
        return { downloaded: true, key, sizeBytes: blob.size };
      } finally {
        this.downloadingKeys.delete(key);
        this._emitChange();
      }
    }

    async removeTrack(trackOrKey) {
      await this.init();
      const key = typeof trackOrKey === 'string' && this.downloadedMap.has(trackOrKey)
        ? trackOrKey
        : this.getTrackKey(trackOrKey);
      if (!this.db || !key) return;

      if (this.objectUrls.has(key)) {
        try { URL.revokeObjectURL(this.objectUrls.get(key)); } catch (e) {}
        this.objectUrls.delete(key);
      }

      await new Promise((resolve) => {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });

      this.downloadedMap.delete(key);
      this._emitChange();
    }
  }

  global.offlineManager = new OfflineManager();
})(window);
