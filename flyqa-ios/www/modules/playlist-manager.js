// ============================================================
//  Advanced Playlist Manager Module — Drag & Drop, Multi-Select, Sorting & Batch Actions
// ============================================================

class PlaylistManager {
  constructor() {
    this.selectedTrackIds = new Set();
    this.isMultiSelectMode = false;
    this.currentTracks = [];
    this.filteredTracks = [];
    this.searchQuery = '';
    this.sortBy = 'default'; // 'default', 'title-asc', 'title-desc', 'artist-asc', 'duration-asc', 'duration-desc'
    this.draggedIndex = null;
  }

  setTracks(tracks) {
    this.currentTracks = [...tracks];
    this.selectedTrackIds.clear();
    this.applyFilterAndSort();
  }

  setSearchQuery(q) {
    this.searchQuery = (q || '').trim().toLowerCase();
    this.applyFilterAndSort();
  }

  setSortBy(sortKey) {
    this.sortBy = sortKey;
    this.applyFilterAndSort();
  }

  applyFilterAndSort() {
    let result = [...this.currentTracks];

    // Filter
    if (this.searchQuery) {
      result = result.filter(t =>
        (t.title && t.title.toLowerCase().includes(this.searchQuery)) ||
        (t.artist && t.artist.toLowerCase().includes(this.searchQuery))
      );
    }

    // Sort
    switch (this.sortBy) {
      case 'title-asc':
        result.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        break;
      case 'title-desc':
        result.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
        break;
      case 'artist-asc':
        result.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
        break;
      case 'duration-asc':
        result.sort((a, b) => this._parseDuration(a.duration) - this._parseDuration(b.duration));
        break;
      case 'duration-desc':
        result.sort((a, b) => this._parseDuration(b.duration) - this._parseDuration(a.duration));
        break;
      default:
        // 'default' keeps original positions
        break;
    }

    this.filteredTracks = result;
    return this.filteredTracks;
  }

  // --- Multi-Select & Batch Actions ---

  toggleTrackSelection(trackId) {
    const idKey = String(trackId);
    if (this.selectedTrackIds.has(idKey)) {
      this.selectedTrackIds.delete(idKey);
    } else {
      this.selectedTrackIds.add(idKey);
    }
    this.isMultiSelectMode = this.selectedTrackIds.size > 0;
  }

  selectAll() {
    this.filteredTracks.forEach(t => this.selectedTrackIds.add(String(t.id)));
    this.isMultiSelectMode = true;
  }

  clearSelection() {
    this.selectedTrackIds.clear();
    this.isMultiSelectMode = false;
  }

  getSelectedCount() {
    return this.selectedTrackIds.size;
  }

  getSelectedTracks() {
    return this.currentTracks.filter(t => this.selectedTrackIds.has(String(t.id)));
  }

  // --- Reordering & Position Movement ---

  moveTrack(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return false;
    if (fromIndex >= this.currentTracks.length || toIndex >= this.currentTracks.length) return false;

    const [moved] = this.currentTracks.splice(fromIndex, 1);
    this.currentTracks.splice(toIndex, 0, moved);

    this.applyFilterAndSort();
    return true;
  }

  moveToTop(index) {
    return this.moveTrack(index, 0);
  }

  moveToBottom(index) {
    return this.moveTrack(index, this.currentTracks.length - 1);
  }

  moveToPosition(fromIndex, targetPos1Based) {
    const toIndex = targetPos1Based - 1;
    return this.moveTrack(fromIndex, toIndex);
  }

  // --- Drag and Drop Handlers ---

  handleDragStart(e, index) {
    this.draggedIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  }

  handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  handleDrop(e, targetIndex) {
    e.preventDefault();
    if (this.draggedIndex === null || this.draggedIndex === targetIndex) return false;
    const success = this.moveTrack(this.draggedIndex, targetIndex);
    this.draggedIndex = null;
    return success;
  }

  _parseDuration(durStr) {
    if (!durStr) return 0;
    const parts = durStr.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }
}

// Export singleton
window.playlistManager = new PlaylistManager();
