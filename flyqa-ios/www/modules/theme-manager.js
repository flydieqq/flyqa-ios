// ============================================================
//  Theme & Customization Manager Module
// ============================================================

const THEMES = {
  'oled': {
    name: 'Dark OLED',
    bg: '#000000',
    glassBg: 'rgba(255, 255, 255, 0.04)',
    glassHover: 'rgba(255, 255, 255, 0.08)',
    border: 'rgba(255, 255, 255, 0.1)',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(255, 255, 255, 0.6)',
    textTertiary: 'rgba(255, 255, 255, 0.35)',
    defaultAccent: '#38ef7d'
  },
  'classic-dark': {
    name: 'Classic Dark',
    bg: '#0a0a0f',
    glassBg: 'rgba(255, 255, 255, 0.06)',
    glassHover: 'rgba(255, 255, 255, 0.10)',
    border: 'rgba(255, 255, 255, 0.12)',
    textPrimary: 'rgba(255, 255, 255, 0.95)',
    textSecondary: 'rgba(255, 255, 255, 0.55)',
    textTertiary: 'rgba(255, 255, 255, 0.35)',
    defaultAccent: '#6eb6ff'
  },
  'light': {
    name: 'Clean Light',
    bg: '#eef2f7',
    glassBg: 'rgba(255, 255, 255, 0.65)',
    glassHover: 'rgba(255, 255, 255, 0.85)',
    border: 'rgba(0, 0, 0, 0.08)',
    textPrimary: '#1a1d24',
    textSecondary: '#5a6270',
    textTertiary: '#8f98a8',
    defaultAccent: '#2563eb'
  },
  'cyberpunk': {
    name: 'Cyberpunk Neon',
    bg: '#090814',
    glassBg: 'rgba(254, 231, 21, 0.05)',
    glassHover: 'rgba(254, 231, 21, 0.12)',
    border: 'rgba(254, 231, 21, 0.25)',
    textPrimary: '#00ffcc',
    textSecondary: '#ff007f',
    textTertiary: 'rgba(0, 255, 204, 0.5)',
    defaultAccent: '#fee715'
  },
  'retro-synth': {
    name: 'Retro Synthwave',
    bg: '#140c24',
    glassBg: 'rgba(255, 0, 127, 0.06)',
    glassHover: 'rgba(255, 0, 127, 0.14)',
    border: 'rgba(255, 0, 127, 0.22)',
    textPrimary: '#ffeef8',
    textSecondary: '#f783ac',
    textTertiary: '#a56de2',
    defaultAccent: '#ff2a85'
  },
  'monochrome': {
    name: 'Minimalist Mono',
    bg: '#121212',
    glassBg: 'rgba(255, 255, 255, 0.05)',
    glassHover: 'rgba(255, 255, 255, 0.09)',
    border: 'rgba(255, 255, 255, 0.15)',
    textPrimary: '#f0f0f0',
    textSecondary: '#a0a0a0',
    textTertiary: '#666666',
    defaultAccent: '#ffffff'
  },
  'cat': {
    name: 'Котики',
    bg: '#1a1423',
    glassBg: 'rgba(255, 208, 224, 0.09)',
    glassHover: 'rgba(255, 208, 224, 0.16)',
    border: 'rgba(255, 198, 218, 0.24)',
    textPrimary: '#fff6f0',
    textSecondary: '#e8cad8',
    textTertiary: '#b392a5',
    defaultAccent: '#ffb3c6',
    secondaryAccent: '#ffcaa6'
  }
};

class ThemeManager {
  constructor() {
    this.currentTheme = 'classic-dark';
    this.extractedColors = null;
  }

  init() {
    const s = window.storageManager.settings;
    this.applyTheme(s.theme || 'classic-dark');
    this.applyCornerRadius(s.cornerRadius || 'medium');
    this.applyBlurIntensity(s.blurIntensity || 'medium');
    this.applyAnimSpeed(s.animSpeed || '1x');
    this.applyReduceMotion(s.reduceMotion || false);
    this.applyPlayerStyle(s.playerStyle || 'cover');

    if (!s.dynamicPalette && s.accentColor) {
      this.setCustomAccent(s.accentColor);
    }

    this._initCatMicroInteractions();
  }

  _initCatMicroInteractions() {
    if (this._catTapBound) return;
    this._catTapBound = true;

    document.addEventListener('pointerdown', (e) => {
      if (this.currentTheme !== 'cat') return;
      if (window.storageManager?.getSetting('reduceMotion')) return;
      const interactive = e.target.closest('button, .track-item, .mobile-playlist-card, .theme-card, .ios-tab-btn, .player-cover-wrap, .sidebar-item');
      if (!interactive) return;

      const x = e.clientX;
      const y = e.clientY;
      if (typeof x !== 'number' || typeof y !== 'number' || (x === 0 && y === 0)) return;

      const paw = document.createElement('span');
      paw.className = 'cat-tap-paw';
      paw.setAttribute('aria-hidden', 'true');
      paw.style.left = `${x}px`;
      paw.style.top = `${y}px`;
      paw.style.setProperty('--paw-rot', `${(Math.random() * 34 - 17).toFixed(1)}deg`);
      paw.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><ellipse cx="7" cy="8.5" rx="2.1" ry="2.7"/><ellipse cx="12" cy="6.8" rx="2.1" ry="2.7"/><ellipse cx="17" cy="8.5" rx="2.1" ry="2.7"/><ellipse cx="4.5" cy="13" rx="1.8" ry="2.3"/><path d="M12 11.2c-3.3 0-5.8 2.5-5.8 5.2 0 1.8 1.4 3 3.1 3 1.1 0 1.8-.4 2.7-.4s1.6.4 2.7.4c1.7 0 3.1-1.2 3.1-3 0-2.7-2.5-5.2-5.8-5.2z"/></svg>`;
      document.body.appendChild(paw);
      setTimeout(() => paw.remove(), 620);
    }, { passive: true });
  }

  applyTheme(themeKey, options = {}) {
    if (!THEMES[themeKey]) themeKey = 'classic-dark';
    this.currentTheme = themeKey;
    const theme = THEMES[themeKey];
    const root = document.documentElement;

    root.style.setProperty('--bg-dark', theme.bg);
    root.style.setProperty('--glass-bg', theme.glassBg);
    root.style.setProperty('--glass-bg-hover', theme.glassHover);
    root.style.setProperty('--glass-border', theme.border);
    root.style.setProperty('--text-primary', theme.textPrimary);
    root.style.setProperty('--text-secondary', theme.textSecondary);
    root.style.setProperty('--text-tertiary', theme.textTertiary);

    if (options.userSelected) {
      window.storageManager.saveSettings({ accentColor: theme.defaultAccent });
      const picker = document.getElementById('setting-accent-picker');
      if (picker) picker.value = theme.defaultAccent;
    }

    // If dynamic palette is not active, set default theme accent
    if (!window.storageManager.getSetting('dynamicPalette')) {
      const customAccent = window.storageManager.getSetting('accentColor');
      this.setCustomAccent(customAccent || theme.defaultAccent);
    } else if (this.extractedColors && themeKey !== 'cat') {
      this.setDynamicAccent(this.extractedColors.accent);
    } else {
      this.setCustomAccent(theme.defaultAccent);
    }

    if (window.audioVisualizer && theme.secondaryAccent && (!this.extractedColors || themeKey === 'cat')) {
      window.audioVisualizer.setColors(theme.defaultAccent, theme.secondaryAccent);
    }

    const bgCanvas = document.getElementById('bg-canvas');
    if (bgCanvas && !this.extractedColors) {
      if (themeKey === 'cat') {
        bgCanvas.style.setProperty('--bg-color-1', 'rgba(255, 179, 198, 0.28)');
        bgCanvas.style.setProperty('--bg-color-2', 'rgba(216, 180, 254, 0.24)');
        bgCanvas.classList.add('active');
      } else {
        bgCanvas.style.removeProperty('--bg-color-1');
        bgCanvas.style.removeProperty('--bg-color-2');
      }
    }

    document.body.setAttribute('data-theme', themeKey);
    window.storageManager.saveSettings({ theme: themeKey });
  }

  setCustomAccent(color) {
    const root = document.documentElement;
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-glow', this._hexToRgba(color, 0.3));

    if (window.audioVisualizer) {
      window.audioVisualizer.setColors(color, null);
    }
  }

  setDynamicAccent(color) {
    if (!color) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-glow', this._hexToRgba(color, 0.35));

    if (window.audioVisualizer) {
      window.audioVisualizer.setColors(color, null);
    }
  }

  applyCornerRadius(mode) {
    const root = document.documentElement;
    let radius = '12px';
    let btnRadius = '10px';

    if (mode === 'sharp') {
      radius = '0px';
      btnRadius = '0px';
    } else if (mode === 'pill') {
      radius = '24px';
      btnRadius = '999px';
    }

    root.style.setProperty('--border-radius-panel', radius);
    root.style.setProperty('--border-radius-btn', btnRadius);
    document.body.setAttribute('data-radius', mode);
    window.storageManager.saveSettings({ cornerRadius: mode });
  }

  applyBlurIntensity(intensity) {
    const root = document.documentElement;
    let blur = '24px';

    if (intensity === 'none') blur = '0px';
    else if (intensity === 'low') blur = '10px';
    else if (intensity === 'high') blur = '40px';

    root.style.setProperty('--glass-blur', blur);
    document.body.setAttribute('data-blur', intensity);
    window.storageManager.saveSettings({ blurIntensity: intensity });
  }

  applyAnimSpeed(speed) {
    const root = document.documentElement;
    let factor = 1.0;
    if (speed === '0.5x') factor = 2.0; // slower duration
    if (speed === '1.5x') factor = 0.67; // faster duration

    root.style.setProperty('--anim-duration-factor', factor);
    window.storageManager.saveSettings({ animSpeed: speed });
  }

  applyReduceMotion(reduce) {
    if (reduce) {
      document.body.classList.add('reduce-motion');
    } else {
      document.body.classList.remove('reduce-motion');
    }
    window.storageManager.saveSettings({ reduceMotion: reduce });
  }

  applyPlayerStyle(style) {
    const coverWrap = document.querySelector('.player-cover-wrap');
    if (coverWrap) {
      coverWrap.classList.remove('style-cover', 'style-vinyl', 'style-cassette', 'style-tilt');
      coverWrap.classList.add(`style-${style}`);
    }
    const fsCoverWrap = document.querySelector('#fs-cover-wrap');
    if (fsCoverWrap) {
      fsCoverWrap.classList.remove('style-cover', 'style-vinyl', 'style-cassette', 'style-tilt');
      fsCoverWrap.classList.add(`style-${style}`);
    }
    window.storageManager.saveSettings({ playerStyle: style });
  }

  applyTransitionStyle(style) {
    document.body.setAttribute('data-transition', style);
    window.storageManager.saveSettings({ transitionStyle: style });
  }

  onTrackColorsExtracted(colors) {
    this.extractedColors = colors;
    const fsOverlay = document.getElementById('fullscreen-player');
    if (fsOverlay && colors.accent) {
      fsOverlay.style.setProperty('--fs-accent-1', colors.accent);
      if (colors.secondary) {
        fsOverlay.style.setProperty('--fs-accent-2', colors.secondary);
      }
    }
    if (window.storageManager.getSetting('dynamicPalette') && colors.accent) {
      this.setDynamicAccent(colors.accent);
    }
    if (window.audioVisualizer) {
      window.audioVisualizer.setColors(colors.accent, colors.secondary);
    }
  }

  _hexToRgba(hex, alpha) {
    if (hex.startsWith('rgb')) return hex;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
  }
}

// Export singleton
window.themeManager = new ThemeManager();
