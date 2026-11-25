// ============================================================
//  flyqa iOS Bridge — Lock Screen MediaSession, Swipe & Tab Bar
// ============================================================

(function (global) {
  const $ = (sel) => document.querySelector(sel);

  const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  let iosAudioUnlocked = false;

  function getActiveAudio() {
    if (typeof global.flyqaGetActiveAudio === 'function') {
      return global.flyqaGetActiveAudio() || $('#audio-element');
    }
    return $('#audio-element');
  }

  function primeAudioForGesture() {
    const audio = getActiveAudio();
    if (global.audioEngine && $('#audio-element')) {
      try {
        global.audioEngine.init($('#audio-element'));
        global.audioEngine.ensureRunning();
      } catch (e) {}
    }

    if (!iosAudioUnlocked && audio) {
      iosAudioUnlocked = true;
      if (!audio.getAttribute('src')) {
        try {
          audio.src = SILENT_WAV;
          const p = audio.play();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              audio.pause();
              audio.currentTime = 0;
            }).catch(() => {});
          }
        } catch (e) {}
      }
    }
  }

  function initAudioElementForIOS() {
    const primary = $('#audio-element');
    const hls = $('#audio-hls-element');
    const elements = [primary, hls].filter(Boolean);
    if (!elements.length) return;

    if (primary) {
      primary.setAttribute('playsinline', 'true');
      primary.setAttribute('webkit-playsinline', 'true');
      primary.setAttribute('crossorigin', 'anonymous');
    }
    if (hls) {
      hls.setAttribute('playsinline', 'true');
      hls.setAttribute('webkit-playsinline', 'true');
      hls.removeAttribute('crossorigin');
    }

    const unlockOnce = () => {
      primeAudioForGesture();
    };
    document.addEventListener('touchstart', unlockOnce, { once: true, capture: true, passive: true });
    document.addEventListener('click', unlockOnce, { once: true, capture: true });

    elements.forEach((el) => {
      el.addEventListener('play', () => {
        if (el !== getActiveAudio()) return;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
      });

      el.addEventListener('pause', () => {
        if (el !== getActiveAudio()) return;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      });

      el.addEventListener('timeupdate', () => {
        if (el === getActiveAudio()) updateMediaPositionState();
      });
      el.addEventListener('loadedmetadata', () => {
        if (el === getActiveAudio()) updateMediaPositionState();
      });
    });

    // Keep Web Audio context alive when returning from Lock Screen / background on iOS
    document.addEventListener('visibilitychange', () => {
      const active = getActiveAudio();
      if (!document.hidden && global.audioEngine && active && !active.paused && active === primary) {
        try { global.audioEngine.ensureRunning(); } catch (e) {}
      }
    });
  }

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      const artwork = track.thumbnail
        ? [{ src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
        : [];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'flyqa',
        artist: track.artist || 'Unknown Artist',
        album: 'flyqa',
        artwork
      });
    } catch (e) {
      // Ignore if MediaMetadata unsupported
    }
  }

  function updateMediaPositionState() {
    const audio = getActiveAudio();
    if (!audio || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!audio.duration || isNaN(audio.duration) || !isFinite(audio.duration)) return;

    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, audio.duration)
      });
    } catch (e) {}
  }

  function registerMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;

    const safeSet = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {}
    };

    safeSet('play', () => {
      const audio = getActiveAudio();
      if (typeof global.togglePlay === 'function' && audio?.paused) global.togglePlay();
      else audio?.play();
    });

    safeSet('pause', () => {
      const audio = getActiveAudio();
      if (typeof global.togglePlay === 'function' && audio && !audio.paused) global.togglePlay();
      else audio?.pause();
    });

    safeSet('previoustrack', () => {
      if (typeof global.playPrev === 'function') global.playPrev();
    });

    safeSet('nexttrack', () => {
      if (typeof global.playNext === 'function') global.playNext();
    });

    safeSet('seekto', (details) => {
      const audio = getActiveAudio();
      if (audio && details && typeof details.seekTime === 'number') {
        audio.currentTime = details.seekTime;
        updateMediaPositionState();
      }
    });

    safeSet('seekbackward', (details) => {
      const audio = getActiveAudio();
      if (audio) {
        audio.currentTime = Math.max(0, audio.currentTime - (details?.seekOffset || 10));
        updateMediaPositionState();
      }
    });

    safeSet('seekforward', (details) => {
      const audio = getActiveAudio();
      if (audio && audio.duration) {
        audio.currentTime = Math.min(audio.duration, audio.currentTime + (details?.seekOffset || 10));
        updateMediaPositionState();
      }
    });
  }

  // ============================================================
  //  Swipe Down Gesture to Dismiss Full-Screen Player
  // ============================================================
  function initFullscreenSwipeDown() {
    const overlay = $('#fullscreen-player');
    if (!overlay) return;

    let startY = 0;
    let startTime = 0;
    let currentDeltaY = 0;
    let isTracking = false;

    overlay.addEventListener('touchstart', (e) => {
      if (!overlay.classList.contains('active')) return;
      // Do not intercept seek bar drags
      if (e.target.closest('#fs-progress-wrap') || e.target.closest('input[type="range"]')) {
        isTracking = false;
        return;
      }
      const touch = e.touches[0];
      startY = touch.clientY;
      startTime = Date.now();
      currentDeltaY = 0;
      isTracking = true;
    }, { passive: true });

    overlay.addEventListener('touchmove', (e) => {
      if (!isTracking) return;
      const touch = e.touches[0];
      const dy = touch.clientY - startY;
      if (dy > 0) {
        currentDeltaY = dy;
        overlay.style.transition = 'none';
        overlay.style.transform = `translateY(${dy}px)`;
        overlay.style.opacity = String(Math.max(0.35, 1 - dy / 520));
      } else {
        currentDeltaY = 0;
        overlay.style.transform = '';
      }
    }, { passive: true });

    const finishSwipe = () => {
      if (!isTracking) return;
      isTracking = false;
      const elapsed = Math.max(1, Date.now() - startTime);
      const velocity = currentDeltaY / elapsed;

      if (currentDeltaY > 95 || (currentDeltaY > 40 && velocity > 0.45)) {
        if (typeof global.closeFullscreenPlayer === 'function') {
          global.closeFullscreenPlayer({ fromSwipe: true });
        }
      } else {
        overlay.style.transition = 'transform 0.42s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.36s cubic-bezier(0.16, 1, 0.3, 1)';
        overlay.style.transform = 'translateY(0)';
        overlay.style.opacity = '1';
        setTimeout(() => {
          overlay.style.transition = '';
          overlay.style.transform = '';
        }, 430);
      }
      currentDeltaY = 0;
    };

    overlay.addEventListener('touchend', finishSwipe, { passive: true });
    overlay.addEventListener('touchcancel', finishSwipe, { passive: true });
  }

  // ============================================================
  //  iOS Mobile Tab Bar & Sidebar Drawer Navigation
  // ============================================================
  function closeAllOverlays() {
    const sidebar = $('#sidebar');
    const backdrop = $('#ios-sidebar-backdrop');
    const authOverlay = $('#auth-modal-overlay');
    const contextMenu = $('#context-menu');
    const fullscreenPlayer = $('#fullscreen-player');
    const addPlaylistSheet = $('#add-to-playlist-overlay');

    sidebar?.classList.remove('ios-open', 'open', 'active');
    if (backdrop) {
      backdrop.classList.remove('active', 'open');
      backdrop.style.display = '';
    }
    if (authOverlay && authOverlay.style.display !== 'none') {
      authOverlay.style.display = 'none';
      authOverlay.setAttribute('aria-hidden', 'true');
    }
    if (addPlaylistSheet && addPlaylistSheet.style.display !== 'none') {
      if (typeof global.closeAddToPlaylistSheet === 'function') {
        global.closeAddToPlaylistSheet();
      } else {
        addPlaylistSheet.style.display = 'none';
        addPlaylistSheet.setAttribute('aria-hidden', 'true');
      }
    }
    if (contextMenu) contextMenu.style.display = 'none';
    // Close fullscreen player if stuck open
    if (fullscreenPlayer && fullscreenPlayer.classList.contains('active')) {
      if (typeof global.closeFullscreenPlayer === 'function') {
        global.closeFullscreenPlayer();
      } else {
        fullscreenPlayer.classList.remove('active');
        fullscreenPlayer.style.opacity = '0';
        fullscreenPlayer.style.visibility = 'hidden';
        fullscreenPlayer.setAttribute('aria-hidden', 'true');
      }
    }
    document.querySelectorAll('.blurred').forEach((el) => el.classList.remove('blurred'));
    document.querySelectorAll('.motion-blur').forEach((el) => el.classList.remove('motion-blur'));
  }

  function updateTabIndicator(activeBtn) {
    const tabbar = $('#ios-tabbar');
    const indicator = $('#ios-tab-indicator');
    if (!tabbar || !indicator) return;

    const barRect = tabbar.getBoundingClientRect();
    if (!activeBtn || !barRect.width || !barRect.height || getComputedStyle(tabbar).display === 'none') {
      indicator.style.opacity = '0';
      return;
    }

    const btnRect = activeBtn.getBoundingClientRect();
    if (!btnRect.width) return;

    const padX = 4;
    const width = Math.max(44, btnRect.width - padX * 2);
    const x = (btnRect.left - barRect.left) + padX;
    const top = Math.max(5, btnRect.top - barRect.top);
    const height = Math.max(42, btnRect.height - 2);

    indicator.style.width = `${width}px`;
    indicator.style.height = `${height}px`;
    indicator.style.top = `${top}px`;
    indicator.style.transform = `translate3d(${x}px, 0, 0)`;
    indicator.style.opacity = '1';
  }

  function syncTabBar(viewName) {
    const tabBtns = document.querySelectorAll('.ios-tab-btn');
    if (!tabBtns.length) return;
    const mapped = (viewName === 'mobile-playlists' || viewName === 'playlist') ? 'playlists' : viewName;
    let activeBtn = null;
    tabBtns.forEach((b) => {
      const match = b.dataset.iosView === mapped;
      b.classList.toggle('active', match);
      if (match) activeBtn = b;
    });
    if (activeBtn) {
      requestAnimationFrame(() => updateTabIndicator(activeBtn));
    } else {
      const indicator = $('#ios-tab-indicator');
      if (indicator) indicator.style.opacity = '0';
    }
  }

  function initMobileNav() {
    const sidebar = $('#sidebar');
    const backdrop = $('#ios-sidebar-backdrop');
    const menuBtn = $('#ios-btn-menu');
    const authBtn = $('#ios-btn-auth');
    const tabBtns = document.querySelectorAll('.ios-tab-btn');

    const closeDrawer = () => {
      sidebar?.classList.remove('ios-open');
      backdrop?.classList.remove('active');
    };

    const toggleDrawer = () => {
      const opening = !sidebar?.classList.contains('ios-open');
      sidebar?.classList.toggle('ios-open', opening);
      backdrop?.classList.toggle('active', opening);
    };

    menuBtn?.addEventListener('click', toggleDrawer);
    backdrop?.addEventListener('click', closeDrawer);

    // Clicking sidebar items or playlists closes drawer automatically on mobile
    sidebar?.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar-item') || e.target.closest('.playlist-item')) {
        closeDrawer();
      }
    });

    authBtn?.addEventListener('click', () => {
      closeDrawer();
      $('#btn-open-auth')?.click();
    });

    $('#btn-mobile-new-playlist')?.addEventListener('click', () => {
      closeAllOverlays();
      $('#btn-new-playlist')?.click();
    });

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.iosView;
        closeAllOverlays();
        tabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        updateTabIndicator(btn);

        const targetView = view === 'playlists' ? 'mobile-playlists' : view;
        if (typeof global.switchView === 'function') {
          global.switchView(targetView);
        }
      });
    });

    // Sync initial floating indicator position
    requestAnimationFrame(() => {
      const active = $('#ios-tabbar .ios-tab-btn.active');
      if (active) updateTabIndicator(active);
    });
    window.addEventListener('resize', () => {
      const active = $('#ios-tabbar .ios-tab-btn.active');
      if (active) updateTabIndicator(active);
    });

    // Prevent pinch zoom gestures on iOS
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  }

  global.flyqaIOS = {
    updateMediaSession,
    updateMediaPositionState,
    closeAllOverlays,
    primeAudioForGesture,
    syncTabBar
  };

  window.addEventListener('DOMContentLoaded', () => {
    initAudioElementForIOS();
    registerMediaSessionHandlers();
    initFullscreenSwipeDown();
    initMobileNav();
  });
})(window);
