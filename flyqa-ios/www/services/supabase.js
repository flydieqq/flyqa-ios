// ============================================================
//  flyqa — Supabase Client Singleton & Cloud Sync Service
// ============================================================

(function (global) {
  const DEFAULT_SUPABASE_URL = 'https://oafzlggcpswffuzmzxcy.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'sb_publishable_pyoPUoTMUvvPqq4fZ_5OwA_BZg-k5BI';

  class SupabaseService {
    constructor() {
      this.client = null;
      this.session = null;
      this.user = null;
      this.profile = null;
      this.initialized = false;
      this._initPromise = null;
      this._authListeners = new Set();
    }

    /**
     * Initialize singleton Supabase client from /api/config (backed by .env)
     * with safe fallback to project configuration.
     */
    async init() {
      if (this.initialized) return this.client;
      if (this._initPromise) return this._initPromise;

      this._initPromise = (async () => {
        let supabaseUrl = DEFAULT_SUPABASE_URL;
        let supabaseKey = DEFAULT_SUPABASE_KEY;

        if (global.location && (global.location.protocol === 'http:' || global.location.protocol === 'https:') && global.location.hostname === 'localhost') {
          try {
            const res = await fetch('/api/config');
            if (res.ok) {
              const cfg = await res.json();
              if (cfg.supabaseUrl) supabaseUrl = cfg.supabaseUrl;
              if (cfg.supabaseAnonKey) supabaseKey = cfg.supabaseAnonKey;
            }
          } catch (e) {
            // Use defaults when running offline or standalone
          }
        }

        if (!global.supabase || typeof global.supabase.createClient !== 'function') {
          console.error('[flyqa] Supabase SDK failed to load.');
          return null;
        }

        this.client = global.supabase.createClient(supabaseUrl, supabaseKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storageKey: 'flyqa_supabase_auth'
          }
        });

        try {
          const { data, error } = await this.client.auth.getSession();
          if (!error && data?.session) {
            this.session = data.session;
            this.user = data.session.user;
            await this.fetchProfile(this.user.id);
          }
        } catch (err) {
          console.warn('[flyqa] Session restore warning:', err.message);
        }

        this.client.auth.onAuthStateChange(async (event, session) => {
          this.session = session;
          this.user = session?.user || null;

          if (this.user) {
            await this.fetchProfile(this.user.id);
          } else {
            this.profile = null;
          }

          this._notifyAuthListeners(event, this.user, this.profile);
        });

        this.initialized = true;
        return this.client;
      })();

      return this._initPromise;
    }

    getClient() {
      return this.client;
    }

    isAuthenticated() {
      return !!(this.client && this.session && this.user);
    }

    getUser() {
      return this.user;
    }

    getProfile() {
      return this.profile;
    }

    onAuthChange(cb) {
      if (typeof cb === 'function') {
        this._authListeners.add(cb);
      }
      return () => this._authListeners.delete(cb);
    }

    _notifyAuthListeners(event, user, profile) {
      this._authListeners.forEach((cb) => {
        try {
          cb(event, user, profile);
        } catch (e) {
          console.error('[flyqa] Auth listener error:', e);
        }
      });
    }

    // ============================================================
    //  Authentication (Sign In, Sign Up, Sign Out, Profile)
    // ============================================================
    async signIn(email, password) {
      await this.init();
      if (!this.client) throw new Error('Supabase клиент не инициализирован');

      const { data, error } = await this.client.auth.signInWithPassword({
        email: email.trim(),
        password
      });
      if (error) throw error;

      this.session = data.session;
      this.user = data.user;
      if (this.user) {
        await this.fetchProfile(this.user.id);
      }
      return { user: this.user, profile: this.profile };
    }

    async signUp(email, password, username) {
      await this.init();
      if (!this.client) throw new Error('Supabase клиент не инициализирован');

      const cleanName = (username || '').trim() || email.split('@')[0];
      const { data, error } = await this.client.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            username: cleanName
          }
        }
      });
      if (error) throw error;

      this.session = data.session;
      this.user = data.user;

      // If auto-confirmed (session active), ensure profile exists
      if (data.session && data.user) {
        await this._ensureProfile(data.user.id, cleanName);
        await this.fetchProfile(data.user.id);
      }

      return {
        user: data.user,
        session: data.session,
        needsEmailConfirmation: !!(data.user && !data.session)
      };
    }

    async signOut() {
      await this.init();
      if (!this.client) return;
      const { error } = await this.client.auth.signOut();
      if (error) throw error;
      this.session = null;
      this.user = null;
      this.profile = null;
    }

    async fetchProfile(userId) {
      if (!this.client || !userId) return null;
      try {
        const { data, error } = await this.client
          .from('profiles')
          .select('id, username, avatar_url, created_at')
          .eq('id', userId)
          .maybeSingle();

        if (error) {
          // Table might not exist yet before schema execution
          console.warn('[flyqa] Profile lookup skipped:', error.message);
          return null;
        }

        if (data) {
          this.profile = data;
          return data;
        }

        // Create profile lazily if user exists without profile row
        const fallbackName =
          this.user?.user_metadata?.username ||
          (this.user?.email ? this.user.email.split('@')[0] : 'flyqa user');
        return await this._ensureProfile(userId, fallbackName);
      } catch (e) {
        console.warn('[flyqa] fetchProfile warning:', e.message);
        return null;
      }
    }

    async _ensureProfile(userId, username) {
      if (!this.client || !userId) return null;
      try {
        const { data, error } = await this.client
          .from('profiles')
          .upsert({ id: userId, username }, { onConflict: 'id' })
          .select('id, username, avatar_url, created_at')
          .single();
        if (!error && data) {
          this.profile = data;
          return data;
        }
      } catch (e) {}
      return null;
    }

    // ============================================================
    //  Cloud Sync: Playlists & Tracks
    // ============================================================
    async getPlaylists() {
      if (!this.isAuthenticated()) return [];
      const { data, error } = await this.client
        .from('playlists')
        .select('id, user_id, title, description, cover_url, color_tag, created_at')
        .eq('user_id', this.user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data || []).map((row) => ({
        id: row.id,
        user_id: row.user_id,
        name: row.title,
        title: row.title,
        description: row.description || '',
        cover_image: row.cover_url || '',
        color_tag: row.color_tag || '#6eb6ff',
        created_at: row.created_at,
        isCloud: true
      }));
    }

    async createPlaylist({ name, description = '', color_tag = '#6eb6ff', cover_image = '' }) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      const { data, error } = await this.client
        .from('playlists')
        .insert({
          user_id: this.user.id,
          title: name,
          description,
          color_tag,
          cover_url: cover_image
        })
        .select('id, user_id, title, description, cover_url, color_tag, created_at')
        .single();

      if (error) throw error;
      return {
        id: data.id,
        user_id: data.user_id,
        name: data.title,
        title: data.title,
        description: data.description || '',
        cover_image: data.cover_url || '',
        color_tag: data.color_tag || '#6eb6ff',
        created_at: data.created_at,
        isCloud: true
      };
    }

    async updatePlaylist(playlistId, { name, description, color_tag, cover_image }) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      const patch = {};
      if (name !== undefined) patch.title = name;
      if (description !== undefined) patch.description = description;
      if (color_tag !== undefined) patch.color_tag = color_tag;
      if (cover_image !== undefined) patch.cover_url = cover_image;

      const { data, error } = await this.client
        .from('playlists')
        .update(patch)
        .eq('id', playlistId)
        .eq('user_id', this.user.id)
        .select('id, user_id, title, description, cover_url, color_tag, created_at')
        .single();

      if (error) throw error;
      return data;
    }

    async deletePlaylist(playlistId) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      const { error } = await this.client
        .from('playlists')
        .delete()
        .eq('id', playlistId)
        .eq('user_id', this.user.id);

      if (error) throw error;
    }

    async getPlaylistTracks(playlistId) {
      if (!this.isAuthenticated()) return [];
      const { data, error } = await this.client
        .from('playlist_tracks')
        .select(`
          id,
          position,
          track_id,
          tracks (
            id,
            title,
            artist,
            audio_url,
            cover_url,
            duration,
            video_id,
            source,
            created_at
          )
        `)
        .eq('playlist_id', playlistId)
        .order('position', { ascending: true });

      if (error) throw error;
      return (data || [])
        .filter((row) => row.tracks)
        .map((row) => {
          const t = row.tracks;
          const isLocal = t.source === 'local';
          return {
            id: row.id, // playlist_tracks ID used for reorder/delete/multi-select
            playlistTrackId: row.id,
            trackId: t.id,
            position: row.position,
            title: t.title || 'Unknown',
            artist: t.artist || '',
            duration: t.duration || '',
            thumbnail: t.cover_url || '',
            video_id: t.video_id || '',
            source: t.source || 'youtube',
            local_path: isLocal ? (t.audio_url || '') : '',
            webpage_url: !isLocal ? (t.audio_url || '') : ''
          };
        });
    }

    async addTrackToPlaylist(playlistId, track) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');

      // 1. Insert track metadata into tracks table
      const { data: insertedTrack, error: trackError } = await this.client
        .from('tracks')
        .insert({
          user_id: this.user.id,
          title: track.title || 'Unknown',
          artist: track.artist || '',
          audio_url: track.webpageUrl || track.webpage_url || track.localPath || track.local_path || '',
          cover_url: track.thumbnail || '',
          duration: track.duration || '',
          video_id: track.videoId || track.video_id || '',
          source: track.source || 'youtube'
        })
        .select('id')
        .single();

      if (trackError) throw trackError;

      // 2. Determine next position in playlist_tracks
      const { data: existingRows, error: posError } = await this.client
        .from('playlist_tracks')
        .select('position')
        .eq('playlist_id', playlistId)
        .order('position', { ascending: false })
        .limit(1);

      if (posError) throw posError;
      const nextPos = existingRows && existingRows.length > 0 ? existingRows[0].position + 1 : 0;

      // 3. Link track into playlist_tracks
      const { data: linkRow, error: linkError } = await this.client
        .from('playlist_tracks')
        .insert({
          playlist_id: playlistId,
          track_id: insertedTrack.id,
          position: nextPos
        })
        .select('id, position')
        .single();

      if (linkError) throw linkError;
      return linkRow;
    }

    async reorderPlaylistTracks(playlistId, orderedTracks) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      if (!Array.isArray(orderedTracks) || !orderedTracks.length) return;

      await Promise.all(
        orderedTracks.map((t, index) =>
          this.client
            .from('playlist_tracks')
            .update({ position: index })
            .eq('id', t.playlistTrackId || t.id)
            .eq('playlist_id', playlistId)
        )
      );
    }

    async deleteTrackFromPlaylist(playlistTrackId) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      const { error } = await this.client
        .from('playlist_tracks')
        .delete()
        .eq('id', playlistTrackId);
      if (error) throw error;
    }

    async batchDeleteTracks(playlistId, playlistTrackIds) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      if (!playlistTrackIds.length) return;
      const { error } = await this.client
        .from('playlist_tracks')
        .delete()
        .eq('playlist_id', playlistId)
        .in('id', playlistTrackIds);
      if (error) throw error;
    }

    async batchMoveTracks(sourcePlaylistId, targetPlaylistId, playlistTrackIds) {
      if (!this.isAuthenticated()) throw new Error('Требуется вход в аккаунт');
      if (!playlistTrackIds.length) return;

      // 1. Read track_ids from source playlist_tracks
      const { data: selectedRows, error: fetchErr } = await this.client
        .from('playlist_tracks')
        .select('id, track_id, position')
        .eq('playlist_id', sourcePlaylistId)
        .in('id', playlistTrackIds)
        .order('position', { ascending: true });
      if (fetchErr) throw fetchErr;
      if (!selectedRows || !selectedRows.length) return;

      // 2. Find target playlist end position
      const { data: targetTail, error: tailErr } = await this.client
        .from('playlist_tracks')
        .select('position')
        .eq('playlist_id', targetPlaylistId)
        .order('position', { ascending: false })
        .limit(1);
      if (tailErr) throw tailErr;

      let nextPos = targetTail && targetTail.length > 0 ? targetTail[0].position + 1 : 0;

      // 3. Insert into target playlist
      const newLinks = selectedRows.map((row) => ({
        playlist_id: targetPlaylistId,
        track_id: row.track_id,
        position: nextPos++
      }));
      const { error: insertErr } = await this.client.from('playlist_tracks').insert(newLinks);
      if (insertErr) throw insertErr;

      // 4. Delete from source playlist
      const { error: delErr } = await this.client
        .from('playlist_tracks')
        .delete()
        .eq('playlist_id', sourcePlaylistId)
        .in('id', playlistTrackIds);
      if (delErr) throw delErr;
    }
  }

  global.supabaseService = new SupabaseService();
})(window);
