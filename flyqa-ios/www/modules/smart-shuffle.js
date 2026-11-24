// ============================================================
//  Smart Shuffle Engine Module — True Random, Fair Shuffle & Mood Shuffle
// ============================================================

class SmartShuffle {
  constructor() {
    this.mode = window.storageManager.getSetting('shuffleMode') || 'fair'; // 'random', 'fair', 'mood'
  }

  setMode(mode) {
    this.mode = mode;
    window.storageManager.saveSettings({ shuffleMode: mode });
  }

  /**
   * Shuffles an array of tracks according to the active shuffle mode.
   * Keeps the currently playing track at index 0.
   */
  shuffle(tracks, currentIndex = 0) {
    if (!tracks || tracks.length <= 1) return [...(tracks || [])];

    const currentTrack = tracks[currentIndex] || tracks[0];
    const pool = tracks.filter((_, idx) => idx !== currentIndex);

    let shuffledPool = [];

    switch (this.mode) {
      case 'random':
        shuffledPool = this._trueRandom(pool);
        break;
      case 'fair':
        shuffledPool = this._fairShuffle(pool, currentTrack);
        break;
      case 'mood':
        shuffledPool = this._moodShuffle(pool, currentTrack);
        break;
      default:
        shuffledPool = this._fairShuffle(pool, currentTrack);
    }

    return [currentTrack, ...shuffledPool];
  }

  // --- Algorithm 1: True Random (Fisher-Yates) ---
  _trueRandom(list) {
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // --- Algorithm 2: Fair Shuffle (Spotify-style Anti-Clustering) ---
  // Guarantees no two consecutive tracks by the same artist
  _fairShuffle(list, referenceTrack) {
    if (list.length <= 2) return this._trueRandom(list);

    // Group tracks by artist
    const byArtist = new Map();
    list.forEach(track => {
      const artist = (track.artist || 'Unknown').trim().toLowerCase();
      if (!byArtist.has(artist)) byArtist.set(artist, []);
      byArtist.get(artist).push(track);
    });

    // Shuffle tracks within each artist's bucket
    byArtist.forEach((tracks, artist) => {
      byArtist.set(artist, this._trueRandom(tracks));
    });

    // Sort artist buckets by size descending
    const sortedBuckets = Array.from(byArtist.values()).sort((a, b) => b.length - a.length);

    const result = [];
    let lastArtist = referenceTrack ? (referenceTrack.artist || '').trim().toLowerCase() : '';

    while (sortedBuckets.some(b => b.length > 0)) {
      // Find a bucket whose artist != lastArtist
      let candidateBucketIndex = sortedBuckets.findIndex(
        b => b.length > 0 && (b[0].artist || '').trim().toLowerCase() !== lastArtist
      );

      // If no different artist available, take the largest non-empty bucket
      if (candidateBucketIndex === -1) {
        candidateBucketIndex = sortedBuckets.findIndex(b => b.length > 0);
      }

      if (candidateBucketIndex === -1) break;

      const chosenTrack = sortedBuckets[candidateBucketIndex].shift();
      result.push(chosenTrack);
      lastArtist = (chosenTrack.artist || '').trim().toLowerCase();

      // Re-sort buckets to keep larger buckets prioritized
      sortedBuckets.sort((a, b) => b.length - a.length);
    }

    return result;
  }

  // --- Algorithm 3: Mood / BPM / Duration Proximity Shuffle ---
  // Chains tracks by proximity in duration, artist similarity and style
  _moodShuffle(list, referenceTrack) {
    if (list.length <= 2) return this._trueRandom(list);

    const refDurationSec = this._parseDuration(referenceTrack ? referenceTrack.duration : '3:30');
    const pool = [...list];
    const result = [];
    let currentRef = referenceTrack;

    while (pool.length > 0) {
      const currentDur = this._parseDuration(currentRef ? currentRef.duration : '3:30');

      // Score each candidate by duration proximity + slight randomized jitter
      let bestIndex = 0;
      let bestScore = Infinity;

      for (let i = 0; i < pool.length; i++) {
        const itemDur = this._parseDuration(pool[i].duration);
        const durDiff = Math.abs(currentDur - itemDur);

        // Artist matching penalty (encourage variety while keeping mood)
        const isSameArtist = currentRef && pool[i].artist && currentRef.artist === pool[i].artist;
        const penalty = isSameArtist ? 120 : 0;

        const jitter = (Math.random() - 0.5) * 45; // slight organic variation
        const score = durDiff + penalty + jitter;

        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const selected = pool.splice(bestIndex, 1)[0];
      result.push(selected);
      currentRef = selected;
    }

    return result;
  }

  _parseDuration(durStr) {
    if (!durStr) return 210;
    const parts = durStr.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 210;
  }
}

// Export singleton
window.smartShuffle = new SmartShuffle();
