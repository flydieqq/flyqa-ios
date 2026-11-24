// ============================================================
//  Storage Module — User Preferences & Persistent Settings
// ============================================================

const STORAGE_KEYS = {
  SETTINGS: 'glass_player_settings',
  EQ_PRESETS: 'glass_player_eq_presets',
  EQ_STATE: 'glass_player_eq_state',
  PLAYLISTS_CACHE: 'glass_player_playlists_cache'
};

const DEFAULT_SETTINGS = {
  // Theme & Appearance
  theme: 'classic-dark', // 'oled', 'classic-dark', 'light', 'cyberpunk', 'retro-synth', 'monochrome'
  dynamicPalette: true,
  accentColor: '#6eb6ff',
  cornerRadius: 'medium', // 'sharp', 'medium', 'pill'
  blurIntensity: 'medium', // 'none', 'low', 'medium', 'high'
  
  // Animations & Player Style
  transitionStyle: 'slide', // 'slide', 'fade', 'zoom'
  playerStyle: 'cover', // 'cover', 'vinyl', 'cassette', 'tilt'
  animSpeed: '1x', // '0.5x', '1x', '1.5x'
  reduceMotion: false,
  
  // Visualizer
  visualizerEnabled: true,
  visualizerMode: 'spectrum', // 'spectrum', 'waveform', 'circular', 'particles'
  visualizerColorMode: 'dynamic', // 'dynamic', 'gradient', 'custom'
  visualizerCustomColor: '#6eb6ff',
  visualizerSensitivity: 1.2,
  visualizerSmoothing: 0.82,
  
  // Shuffle & Playback
  shuffleMode: 'fair', // 'random', 'fair', 'mood'
  repeatMode: 'off', // 'off', 'all', 'one'
  volume: 0.8
};

const DEFAULT_EQ_STATE = {
  enabled: true,
  preamp: 0, // -12 to +12 dB
  bassBoost: 0, // 0 to 100%
  surround3D: 0, // 0 to 100%
  activePreset: 'Flat',
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] // 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz
};

const BUILT_IN_EQ_PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [6, 5.5, 4, 2, 0.5, 0, 0, 0, 0, 0],
  'Electronic': [4.5, 3.5, 1, 0, -1, 1.5, 0.5, 2, 4, 4.5],
  'Rock': [5, 3.5, 2, -0.5, -1.5, -0.5, 1.5, 3, 3.5, 4],
  'Pop': [-1.5, -0.5, 2, 3.5, 4, 3, 1, -0.5, -1, -1.5],
  'Jazz': [3.5, 2.5, 1, 1.5, -1, -1, 0, 1.5, 3, 3.5],
  'Vocal': [-2, -1.5, -0.5, 2, 4.5, 4.5, 3, 1.5, 0, -1],
  'Classical': [4, 3, 2, 1.5, -1, -1, 0, 2, 3, 3.5]
};

class StorageManager {
  constructor() {
    this.settings = this.loadSettings();
    this.eqState = this.loadEQState();
    this.customPresets = this.loadCustomPresets();
  }

  loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  getSetting(key) {
    return this.settings[key];
  }

  loadEQState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.EQ_STATE);
      if (saved) {
        return { ...DEFAULT_EQ_STATE, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.warn('Failed to load EQ state:', e);
    }
    return { ...DEFAULT_EQ_STATE };
  }

  saveEQState(eqState) {
    this.eqState = { ...this.eqState, ...eqState };
    try {
      localStorage.setItem(STORAGE_KEYS.EQ_STATE, JSON.stringify(this.eqState));
    } catch (e) {
      console.error('Failed to save EQ state:', e);
    }
  }

  loadCustomPresets() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.EQ_PRESETS);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load custom presets:', e);
    }
    return {};
  }

  saveCustomPreset(name, bands) {
    this.customPresets[name] = [...bands];
    try {
      localStorage.setItem(STORAGE_KEYS.EQ_PRESETS, JSON.stringify(this.customPresets));
    } catch (e) {
      console.error('Failed to save custom preset:', e);
    }
  }

  deleteCustomPreset(name) {
    if (this.customPresets[name]) {
      delete this.customPresets[name];
      try {
        localStorage.setItem(STORAGE_KEYS.EQ_PRESETS, JSON.stringify(this.customPresets));
      } catch (e) {
        console.error('Failed to delete custom preset:', e);
      }
    }
  }

  getAllPresets() {
    return { ...BUILT_IN_EQ_PRESETS, ...this.customPresets };
  }
}

// Export singleton instance
window.storageManager = new StorageManager();
