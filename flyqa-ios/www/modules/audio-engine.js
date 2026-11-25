// ============================================================
//  Audio Engine — 10-Band Graphic EQ, Preamp, Bass Boost, 3D Spatial Audio & Analyser
// ============================================================

const FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

class AudioEngine {
  constructor() {
    this.audioElement = null;
    this.ctx = null;
    this.source = null;
    this.initialized = false;
    
    // Nodes
    this.preampNode = null;
    this.filters = [];
    this.bassBoostNode = null;
    this.bassSubNode = null;
    
    // 3D Spatial Audio Nodes (Haas effect & Mid-Side stereo widening)
    this.spatialInput = null;
    this.splitter = null;
    this.merger = null;
    this.leftDelay = null;
    this.rightDelay = null;
    this.spatialDry = null;
    this.spatialWet = null;
    this.spatialOutput = null;

    // Analyser Node for Visualizer
    this.analyser = null;
    this._fallbackSources = new WeakMap();

    // Master / Limiter Node to prevent digital clipping
    this.limiterNode = null;

    // State
    this.state = window.storageManager.loadEQState();
  }

  init(audioElement) {
    if (this.initialized) return;
    this.audioElement = audioElement;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();

    try {
      this.source = this.ctx.createMediaElementSource(this.audioElement);
    } catch (e) {
      console.warn('MediaElementSource already created or error:', e);
      return;
    }

    // 1. Preamp Gain (-12dB to +12dB)
    this.preampNode = this.ctx.createGain();
    this.setPreamp(this.state.preamp);

    // 2. 10-Band Biquad Filters (peaking)
    this.filters = FREQUENCIES.map((freq, index) => {
      const filter = this.ctx.createBiquadFilter();
      if (index === 0) {
        filter.type = 'lowshelf';
      } else if (index === FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1.414; // Q-factor for 1-octave band
      }
      filter.frequency.value = freq;
      filter.gain.value = this.state.enabled ? (this.state.bands[index] || 0) : 0;
      return filter;
    });

    // 3. Bass Booster Nodes (lowshelf at 80Hz + resonant sub-peaking at 50Hz)
    this.bassBoostNode = this.ctx.createBiquadFilter();
    this.bassBoostNode.type = 'lowshelf';
    this.bassBoostNode.frequency.value = 85;
    this.bassBoostNode.gain.value = 0;

    this.bassSubNode = this.ctx.createBiquadFilter();
    this.bassSubNode.type = 'peaking';
    this.bassSubNode.frequency.value = 50;
    this.bassSubNode.Q.value = 1.8;
    this.bassSubNode.gain.value = 0;
    this.setBassBoost(this.state.bassBoost);

    // 4. 3D Spatial Audio / Stereo Widener
    this._initSpatialAudio();

    // 5. Analyser for Realtime Visualizer
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = window.storageManager.getSetting('visualizerSmoothing') || 0.82;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    // 6. Dynamics Compressor / Soft Limiter (prevents digital clipping at high EQ gains)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -0.5; // dB
    this.limiterNode.knee.value = 6;
    this.limiterNode.ratio.value = 16;
    this.limiterNode.attack.value = 0.003; // 3ms
    this.limiterNode.release.value = 0.15; // 150ms

    // --- Connect Graph ---
    // Source -> Preamp -> Filter 0 -> ... -> Filter 9 -> BassBoost -> BassSub -> SpatialAudio -> Analyser -> Limiter -> Destination
    let prev = this.source;
    prev.connect(this.preampNode);
    prev = this.preampNode;

    for (const filter of this.filters) {
      prev.connect(filter);
      prev = filter;
    }

    prev.connect(this.bassBoostNode);
    this.bassBoostNode.connect(this.bassSubNode);
    prev = this.bassSubNode;

    prev.connect(this.spatialInput);
    this.spatialOutput.connect(this.analyser);
    this.analyser.connect(this.limiterNode);
    this.limiterNode.connect(this.ctx.destination);

    this.initialized = true;

    // Resume AudioContext on first user interaction if suspended by browser
    ['click', 'keydown', 'touchstart'].forEach(evt => {
      window.addEventListener(evt, () => {
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume();
        }
      }, { once: true });
    });
  }

  _initSpatialAudio() {
    this.spatialInput = this.ctx.createGain();
    this.spatialOutput = this.ctx.createGain();

    this.spatialDry = this.ctx.createGain();
    this.spatialWet = this.ctx.createGain();

    this.splitter = this.ctx.createChannelSplitter(2);
    this.merger = this.ctx.createChannelMerger(2);

    // Haas effect delay nodes: slight interaural time difference (ITD)
    this.leftDelay = this.ctx.createDelay();
    this.rightDelay = this.ctx.createDelay();
    this.leftDelay.delayTime.value = 0.004; // 4ms
    this.rightDelay.delayTime.value = 0.012; // 12ms

    // Cross-channel feedback phase invert for 3D surround perception
    const crossL = this.ctx.createGain();
    const crossR = this.ctx.createGain();
    crossL.gain.value = -0.35;
    crossR.gain.value = -0.35;

    // Dry path
    this.spatialInput.connect(this.spatialDry);
    this.spatialDry.connect(this.spatialOutput);

    // Wet path
    this.spatialInput.connect(this.splitter);

    this.splitter.connect(this.leftDelay, 0);
    this.splitter.connect(this.rightDelay, 1);

    this.leftDelay.connect(crossR);
    this.rightDelay.connect(crossL);

    crossR.connect(this.merger, 0, 1); // R to L
    crossL.connect(this.merger, 0, 0); // L to R

    this.leftDelay.connect(this.merger, 0, 0);
    this.rightDelay.connect(this.merger, 0, 1);

    this.merger.connect(this.spatialWet);
    this.spatialWet.connect(this.spatialOutput);

    this.setSurround3D(this.state.surround3D);
  }

  // --- Controls & Setters ---

  ensureRunning() {
    if (this.ctx && this.ctx.state === 'suspended') {
      return this.ctx.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  connectFallbackStream(mediaElement) {
    if (!mediaElement || !this.ctx || !this.analyser) return;
    if (this._fallbackSources.has(mediaElement)) return;
    try {
      const captureFn = mediaElement.captureStream || mediaElement.mozCaptureStream;
      if (typeof captureFn !== 'function') return;
      const stream = captureFn.call(mediaElement);
      if (stream && stream.getAudioTracks().length > 0) {
        const src = this.ctx.createMediaStreamSource(stream);
        src.connect(this.analyser);
        this._fallbackSources.set(mediaElement, src);
      }
    } catch (e) {
      // Cross-origin or unsupported captureStream; visualizer will gracefully handle
    }
  }

  setBandGain(index, valueDb) {
    if (index < 0 || index >= this.filters.length) return;
    this.state.bands[index] = valueDb;
    if (this.state.enabled && this.filters[index]) {
      this.filters[index].gain.setTargetAtTime(valueDb, this.ctx.currentTime, 0.02);
    }
    this.state.activePreset = 'Custom';
    window.storageManager.saveEQState(this.state);
  }

  setPreamp(valueDb) {
    this.state.preamp = valueDb;
    if (this.preampNode && this.ctx) {
      // Convert dB to linear gain: gain = 10^(dB / 20)
      const linear = Math.pow(10, valueDb / 20);
      this.preampNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.02);
    }
    window.storageManager.saveEQState(this.state);
  }

  setBassBoost(percent) {
    this.state.bassBoost = percent;
    if (this.bassBoostNode && this.bassSubNode && this.ctx) {
      // 0 to 100% maps to 0 to +10 dB
      const gain = (percent / 100) * 10;
      this.bassBoostNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
      this.bassSubNode.gain.setTargetAtTime(gain * 0.7, this.ctx.currentTime, 0.02);
    }
    window.storageManager.saveEQState(this.state);
  }

  setSurround3D(percent) {
    this.state.surround3D = percent;
    if (this.spatialDry && this.spatialWet && this.ctx) {
      const wet = (percent / 100) * 0.85;
      const dry = 1.0 - (wet * 0.4);
      this.spatialDry.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.02);
      this.spatialWet.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.02);
    }
    window.storageManager.saveEQState(this.state);
  }

  setBypass(bypassed) {
    // If bypassed=true, EQ is disabled (flat)
    this.state.enabled = !bypassed;
    if (!this.ctx) return;

    this.filters.forEach((filter, index) => {
      const targetGain = this.state.enabled ? this.state.bands[index] : 0;
      filter.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.02);
    });

    if (this.bassBoostNode && this.bassSubNode) {
      const gain = this.state.enabled ? (this.state.bassBoost / 100) * 10 : 0;
      this.bassBoostNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
      this.bassSubNode.gain.setTargetAtTime(gain * 0.7, this.ctx.currentTime, 0.02);
    }

    window.storageManager.saveEQState(this.state);
  }

  applyPreset(presetName) {
    const allPresets = window.storageManager.getAllPresets();
    const presetBands = allPresets[presetName];
    if (!presetBands) return;

    this.state.activePreset = presetName;
    this.state.bands = [...presetBands];

    if (this.state.enabled && this.ctx) {
      this.filters.forEach((filter, index) => {
        filter.gain.setTargetAtTime(this.state.bands[index], this.ctx.currentTime, 0.03);
      });
    }

    window.storageManager.saveEQState(this.state);
  }

  saveCustomPreset(name) {
    if (!name || !name.trim()) return;
    const cleanName = name.trim();
    window.storageManager.saveCustomPreset(cleanName, this.state.bands);
    this.state.activePreset = cleanName;
    window.storageManager.saveEQState(this.state);
  }

  deleteCustomPreset(name) {
    window.storageManager.deleteCustomPreset(name);
    if (this.state.activePreset === name) {
      this.applyPreset('Flat');
    }
  }

  getFrequencies() {
    return FREQUENCIES;
  }
}

// Export singleton instance
window.audioEngine = new AudioEngine();
