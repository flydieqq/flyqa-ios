// ============================================================
//  Audio Visualizer Module — 4 Real-time Canvas Modes (60–144 FPS Delta-Time)
// ============================================================

class AudioVisualizer {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.animationId = null;
    this.running = false;
    this.lastFrameTime = 0;

    // Audio data buffers
    this.freqData = null;
    this.timeData = null;
    this.bufferLength = 0;

    // Peak bars state for Classic Bars
    this.peakValues = [];
    this.peakDecay = 0.96;

    // Particles state for Particle Storm
    this.particles = [];
    this.maxParticles = 110;
    this.prevBass = 0;

    // Circular rotation angle
    this.rotationAngle = 0;

    // Dynamic colors & cached gradient
    this.accentColor = '#6eb6ff';
    this.secondaryColor = '#ff61d2';
    this._gradCacheKey = '';
    this._cachedGrad = null;
  }

  init(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.resize();

    window.addEventListener('resize', () => this.resize());

    // Init particle pool
    this._initParticles();

    // Start loop if enabled
    if (window.storageManager.getSetting('visualizerEnabled')) {
      this.start();
    }
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this._gradCacheKey = '';
    if (this.ctx) {
      this.ctx.resetTransform();
      this.ctx.scale(dpr, dpr);
    }
  }

  setColors(accent, secondary) {
    if (accent) this.accentColor = accent;
    if (secondary) this.secondaryColor = secondary;
    this._gradCacheKey = '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this._loop(this.lastFrameTime);
  }

  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  _loop(now) {
    if (!this.running) return;

    const dt = Math.min((now - this.lastFrameTime) / 16.6667, 3);
    this.lastFrameTime = now;

    // Skip expensive canvas draws when hidden or off-screen
    if (!document.hidden && this.canvas && this.canvas.offsetParent !== null) {
      this._render(dt || 1);
    }

    this.animationId = requestAnimationFrame((t) => this._loop(t));
  }

  _getLinearGradient(key, x0, y0, x1, y1, stops) {
    if (this._gradCacheKey === key && this._cachedGrad) {
      return this._cachedGrad;
    }
    const grad = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [offset, color] of stops) {
      grad.addColorStop(offset, color);
    }
    this._gradCacheKey = key;
    this._cachedGrad = grad;
    return grad;
  }

  _render(dt) {
    if (!this.ctx || !this.canvas) return;

    const enabled = window.storageManager.getSetting('visualizerEnabled');
    if (!enabled) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      return;
    }

    const analyser = window.audioEngine ? window.audioEngine.analyser : null;
    if (!analyser) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      return;
    }

    if (!this.width || !this.height) {
      this.resize();
      if (!this.width || !this.height) return;
    }

    // Allocate buffers if needed
    if (!this.freqData || this.bufferLength !== analyser.frequencyBinCount) {
      this.bufferLength = analyser.frequencyBinCount;
      this.freqData = new Uint8Array(this.bufferLength);
      this.timeData = new Uint8Array(this.bufferLength);
      this.peakValues = new Float32Array(this.bufferLength).fill(0);
    }

    analyser.getByteFrequencyData(this.freqData);
    analyser.getByteTimeDomainData(this.timeData);

    const mode = window.storageManager.getSetting('visualizerMode') || 'spectrum';
    const sensitivity = window.storageManager.getSetting('visualizerSensitivity') || 1.2;

    this.ctx.clearRect(0, 0, this.width, this.height);

    // Pick visualizer color palette
    const colorMode = window.storageManager.getSetting('visualizerColorMode') || 'dynamic';
    let baseColor = this.accentColor;
    let secColor = this.secondaryColor;

    if (colorMode === 'custom') {
      baseColor = window.storageManager.getSetting('visualizerCustomColor') || '#6eb6ff';
      secColor = '#ffffff';
    } else if (colorMode === 'gradient') {
      baseColor = '#ff5e62';
      secColor = '#ff9966';
    }

    switch (mode) {
      case 'spectrum':
        this._renderBars(baseColor, secColor, sensitivity, dt);
        break;
      case 'waveform':
        this._renderWaveform(baseColor, secColor, sensitivity);
        break;
      case 'circular':
        this._renderCircular(baseColor, secColor, sensitivity, dt);
        break;
      case 'particles':
        this._renderParticles(baseColor, secColor, sensitivity, dt);
        break;
      default:
        this._renderBars(baseColor, secColor, sensitivity, dt);
    }
  }

  // --- Mode 1: Classic Bars with Falling Peak Caps ---
  _renderBars(color1, color2, sensitivity, dt) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const numBars = Math.min(64, Math.floor(w / 10));
    if (numBars <= 0) return;

    const barWidth = Math.max(3, (w / numBars) - 3);
    const gap = (w - (numBars * barWidth)) / (numBars + 1);
    const decayFactor = Math.pow(this.peakDecay, dt);

    const grad = this._getLinearGradient(
      `bars:${color1}:${color2}:${w}:${h}`,
      0, h, 0, 0,
      [[0, color1], [1, color2]]
    );

    ctx.fillStyle = grad;
    for (let i = 0; i < numBars; i++) {
      const freqIndex = Math.floor(Math.pow(i / numBars, 1.6) * (this.bufferLength * 0.45));
      const val = (this.freqData[freqIndex] / 255) * sensitivity;
      const barHeight = Math.min(h * 0.95, Math.max(4, val * h));

      const x = gap + i * (barWidth + gap);
      const y = h - barHeight;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [4, 4, 0, 0]);
      ctx.fill();

      if (barHeight > (this.peakValues[i] || 0)) {
        this.peakValues[i] = barHeight;
      } else {
        this.peakValues[i] = Math.max(0, (this.peakValues[i] || 0) * decayFactor - 0.5 * dt);
      }
    }

    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < numBars; i++) {
      const peakY = h - (this.peakValues[i] || 0) - 3;
      if (peakY < h - 4) {
        const x = gap + i * (barWidth + gap);
        ctx.fillRect(x, peakY, barWidth, 2);
      }
    }
  }

  // --- Mode 2: Waveform / Oscilloscope ---
  _renderWaveform(color1, color2, sensitivity) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const midY = h / 2;

    const grad = this._getLinearGradient(
      `wave:${color1}:${color2}:${w}:${h}`,
      0, 0, w, 0,
      [[0, color1], [0.5, color2], [1, color1]]
    );

    ctx.lineWidth = 3;
    ctx.strokeStyle = grad;
    ctx.shadowColor = color1;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    const sliceWidth = w / this.bufferLength;
    let x = 0;

    for (let i = 0; i < this.bufferLength; i++) {
      const v = (this.timeData[i] / 128.0) - 1.0;
      const y = midY + (v * (h * 0.4) * sensitivity);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = x - sliceWidth;
        const prevV = (this.timeData[i - 1] / 128.0) - 1.0;
        const prevY = midY + (prevV * (h * 0.4) * sensitivity);
        const xc = (prevX + x) / 2;
        const yc = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, xc, yc);
      }
      x += sliceWidth;
    }

    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // --- Mode 3: Circular Spectrum ---
  _renderCircular(color1, color2, sensitivity, dt) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const centerX = w / 2;
    const centerY = h / 2;
    const baseRadius = Math.min(centerX, centerY) * 0.45;

    this.rotationAngle += 0.005 * dt;

    const numPoints = 80;
    const angleStep = (Math.PI * 2) / numPoints;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(this.rotationAngle);

    ctx.strokeStyle = color1;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 2.5;
    for (let i = 0; i < numPoints; i++) {
      const freqIndex = Math.floor(Math.pow(i < numPoints / 2 ? i : numPoints - i, 1.4) * 3);
      const val = (this.freqData[freqIndex] / 255) * sensitivity;
      const rayLength = Math.max(2, val * (baseRadius * 0.8));

      const angle = i * angleStep;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctx.strokeStyle = i % 2 === 0 ? color1 : color2;
      ctx.beginPath();
      ctx.moveTo(cos * baseRadius, sin * baseRadius);
      ctx.lineTo(cos * (baseRadius + rayLength), sin * (baseRadius + rayLength));
      ctx.stroke();
    }

    ctx.restore();
  }

  // --- Mode 4: Particle / Fluid Beat Storm ---
  _initParticles() {
    this.particles = [];
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
        x: Math.random() * 800,
        y: Math.random() * 400,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        radius: Math.random() * 3 + 1.5,
        alpha: Math.random() * 0.7 + 0.3
      });
    }
  }

  _renderParticles(color1, color2, sensitivity, dt) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    let bassSum = 0;
    for (let i = 0; i < 6; i++) {
      bassSum += this.freqData[i] || 0;
    }
    const bass = (bassSum / (6 * 255)) * sensitivity;
    const isBeat = (bass - this.prevBass) > 0.15 && bass > 0.45;
    this.prevBass = bass;

    const centerX = w / 2;
    const centerY = h / 2;
    const friction = Math.pow(0.96, dt);

    ctx.fillStyle = isBeat ? color2 : color1;

    for (const p of this.particles) {
      if (isBeat) {
        const dx = p.x - centerX;
        const dy = p.y - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        p.vx += (dx / dist) * bass * 3.5;
        p.vy += (dy / dist) * bass * 3.5;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      p.vx *= friction;
      p.vy *= friction;

      if (p.x < 0) p.x = w;
      else if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      else if (p.y > h) p.y = 0;

      const size = p.radius * (1 + bass * 1.5);
      ctx.globalAlpha = Math.min(1, p.alpha * (0.5 + bass * 0.8));
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }
}

// Export singleton
window.audioVisualizer = new AudioVisualizer();
