// ============================================================
//  flyqa iOS Bridge — Lock Screen MediaSession, Swipe & Tab Bar
// ============================================================

(function (global) {
  const $ = (sel) => document.querySelector(sel);

  function initAudioElementForIOS() {
    const audio = $('#audio-element');
    if (!audio) return;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');

    audio.addEventListener('play', () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    audio.addEventListener('pause', () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    });

    audio.addEventListener('timeupdate', updateMediaPositionState);
    audio.addEventListener('loadedmetadata', updateMediaPositionState);
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
    const audio = $('#audio-element');
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
    const audio = $('#audio-element');

    const safeSet = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {}
    };

    safeSet('play', () => {
      if (typeof global.togglePlay === 'function' && audio?.paused) global.togglePlay();
      else audio?.play();
    });

    safeSet('pause', () => {
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
      if (audio && details && typeof details.seekTime === 'number') {
        audio.currentTime = details.seekTime;
        updateMediaPositionState();
      }
    });

    safeSet('seekbackward', (details) => {
      if (audio) {
        audio.currentTime = Math.max(0, audio.currentTime - (details?.seekOffset || 10));
        updateMediaPositionState();
      }
    });

    safeSet('seekforward', (details) => {
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
      // Do not intercept seek bar or volume slider drags
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
        overlay.style.transform = '';
        if (typeof global.closeFullscreenPlayer === 'function') {
          global.closeFullscreenPlayer();
        }
      } else {
        overlay.style.transition = 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s ease';
        overlay.style.transform = 'translateY(0)';
        overlay.style.opacity = '1';
        setTimeout(() => {
          overlay.style.transition = '';
          overlay.style.transform = '';
        }, 290);
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

    sidebar?.classList.remove('ios-open', 'open', 'active');
    if (backdrop) {
      backdrop.classList.remove('active', 'open');
      backdrop.style.display = '';
    }
    if (authOverlay && authOverlay.style.display !== 'none') {
      authOverlay.style.display = 'none';
      authOverlay.setAttribute('aria-hidden', 'true');
    }
    if (contextMenu) contextMenu.style.display = 'none';
    document.querySelectorAll('.blurred').forEach((el) => el.classList.remove('blurred'));
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

        const targetView = view === 'playlists' ? 'mobile-playlists' : view;
        if (typeof global.switchView === 'function') {
          global.switchView(targetView);
        }
      });
    });

    // Prevent pinch zoom gestures on iOS
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  }

  global.flyqaIOS = {
    updateMediaSession,
    updateMediaPositionState,
    closeAllOverlays
  };

  window.addEventListener('DOMContentLoaded', () => {
    initAudioElementForIOS();
    registerMediaSessionHandlers();
    initFullscreenSwipeDown();
    initMobileNav();
  });
})(window);
