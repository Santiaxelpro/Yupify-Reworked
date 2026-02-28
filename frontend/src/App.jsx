// src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import { Music, TrendingUp, Disc, Heart, Clock, Plus, Loader } from 'lucide-react';

// Hooks
import useAudio from './hooks/useAudio';
import useAuth from './hooks/useAuth';
import useMediaSession from './hooks/useMediaSession';

// Components
import Player from './components/Player';
import SearchBar from './components/SearchBar';
import TrackCard from './components/TrackCard';
import TrackList from './components/TrackList';
import AuthModal from './components/AuthModal';
import Navigation from './components/Navigation';

// Services
import api from './services/api';
import { getArtistName, getLocalStorage, setLocalStorage, getTrackQualityValue } from './utils/helpers';
import { normalizeText, getTrackKey } from './utils/autoplay';

const GUEST_HISTORY_KEY = 'yupify_guest_history';
const MAX_HISTORY_ITEMS = 100;
const SKIP_RATIO_THRESHOLD = 0.35;
const SKIP_SECONDS_THRESHOLD = 30;

const App = () => {
  // Audio hook
  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    currentTrack,
    streamUrl,
    isRepeat,
    isShuffle,
    quality,
    setQuality,
    audioRef,
    togglePlay,
    playCurrent,
    pauseWithFade,
    playTrack,
    handleTimeUpdate,
    handleSeek,
    handleVolumeChange,
    toggleMute,
    handleEnded,
    setIsRepeat,
    setIsShuffle,
    setOnEndedCallback
  } = useAudio();

  // Auth hook
  const { user, isAuthenticated, loading: authLoading, error: authError, login, register, logout } = useAuth();

  // Estados
  const [activeTab, setActiveTab] = useState('home');
  const [searchResults, setSearchResults] = useState([]);
  const [queue, setQueue] = useState([]);
  const playedRef = useRef(new Set());
  const playedTitleRef = useRef(new Set());
  const autoNextInFlightRef = useRef(false);
  const autoNextRef = useRef(null);
  const autoplayRunIdRef = useRef(0);
  const lyricsInFlightRef = useRef(new Set());
  const downloadInFlightRef = useRef(false);
  const [lyricsCache, setLyricsCache] = useState({});
  const [favorites, setFavorites] = useState([]);
  const [trendingTracks, setTrendingTracks] = useState([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingHasMore, setTrendingHasMore] = useState(true);
  const [myPlaylists, setMyPlaylists] = useState([]);
  const [history, setHistory] = useState([]);
  const [homeContent, setHomeContent] = useState(null);
  
  
  // Estados UI
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const contentRef = useRef(null);
  const trendingOffsetRef = useRef(0);
  const trendingLoadingRef = useRef(false);
  const trendingHasMoreRef = useRef(true);
  const playbackRef = useRef(null);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    if (!currentTrack) return;
    const state = playbackRef.current;
    if (!state?.track) return;
    const stateId = state.track?.id ?? state.track?.trackId;
    const currentId = currentTrack?.id ?? currentTrack?.trackId;
    if (stateId == null || currentId == null) return;
    if (String(stateId) !== String(currentId)) return;
    playbackRef.current = { ...state, track: currentTrack };
  }, [currentTrack]);

  // Cargar datos al iniciar
  useEffect(() => {
    loadHomeContent();
    loadTrending(true);
    if (isAuthenticated) {
      loadUserData();
    } else {
      loadGuestHistory();
    }
  }, [isAuthenticated]);

  // Cargar contenido home
  const loadHomeContent = async () => {
    try {
      const data = await api.explore.getHome('US');
      setHomeContent(data);
    } catch (err) {
      console.error('Error cargando home:', err);
    }
  };

  const TRENDING_LIMIT = 20;
  const loadTrending = async (reset = false) => {
    if (trendingLoadingRef.current) return;
    if (!reset && !trendingHasMoreRef.current) return;

    trendingLoadingRef.current = true;
    setTrendingLoading(true);
    if (reset) {
      trendingOffsetRef.current = 0;
      trendingHasMoreRef.current = true;
      setTrendingHasMore(true);
    }

    try {
      const offset = trendingOffsetRef.current;
      const data = await api.explore.getTrending(TRENDING_LIMIT, offset);
      const items = data.items || [];
      setTrendingTracks(prev => {
        const seen = new Set(prev.map(t => t.id));
        const next = reset ? [] : [...prev];
        items.forEach(t => {
          if (!t || t.id == null || seen.has(t.id)) return;
          seen.add(t.id);
          next.push(t);
        });
        return next;
      });

      trendingOffsetRef.current = offset + items.length;
      const hasMore = data.raw?.hasMore;
      if (hasMore === false) {
        trendingHasMoreRef.current = false;
        setTrendingHasMore(false);
      } else if (hasMore === true) {
        trendingHasMoreRef.current = true;
        setTrendingHasMore(true);
      } else if (items.length < TRENDING_LIMIT) {
        trendingHasMoreRef.current = false;
        setTrendingHasMore(false);
      }
    } catch (err) {
      console.error('Error cargando trending:', err);
    } finally {
      trendingLoadingRef.current = false;
      setTrendingLoading(false);
    }
  };

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => {
      if (trendingLoadingRef.current || !trendingHasMoreRef.current) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
        loadTrending(false);
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Cargar datos del usuario
  const loadUserData = async () => {
    try {
      const [playlistsData, favoritesData, historyData] = await Promise.all([
        api.playlist.getMyPlaylists(),
        api.favorite.getFavorites(),
        api.history.getHistory(50)
      ]);
      
      setMyPlaylists(playlistsData.playlists || playlistsData.raw?.playlists || playlistsData.items || []);
      setFavorites(favoritesData.favorites || favoritesData.raw?.favorites || favoritesData.items || []);
      setHistory(historyData.history || historyData.raw?.history || historyData.items || []);
    } catch (err) {
      console.error('Error cargando datos:', err);
      const message = String(err?.message || '').toLowerCase();
      if (message.includes('token') || message.includes('401')) {
        handleLogout();
        setShowAuthModal(true);
      }
    }
  };

  const loadGuestHistory = () => {
    const stored = getLocalStorage(GUEST_HISTORY_KEY, []);
    if (Array.isArray(stored)) {
      setHistory(stored);
    } else {
      setHistory([]);
    }
  };

  const appendHistoryEntry = (entry, persistToLocal = false) => {
    if (!entry) return;
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY_ITEMS);
      if (persistToLocal) {
        setLocalStorage(GUEST_HISTORY_KEY, next);
      }
      return next;
    });
  };

  // Búsqueda
  const handleSearch = async (query) => {
    setLoading(true);
    try {
      const results = await api.search.search(query, 50);
      setSearchResults(results.items || []);
      setActiveTab('search');
    } catch (err) {
      setError('Error en la búsqueda');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const recordPlayback = async ({ skipReason = null, endedNaturally = false } = {}) => {
    const state = playbackRef.current;
    if (!state?.track || state.recorded) return;

    const track = state.track;
    const listenSecondsRaw = Number.isFinite(currentTimeRef.current) ? currentTimeRef.current : 0;
    const durationValue = Number.isFinite(durationRef.current) && durationRef.current > 0
      ? durationRef.current
      : (Number.isFinite(track?.duration) ? track.duration : 0);
    const listenSeconds = durationValue > 0
      ? Math.min(listenSecondsRaw, durationValue)
      : listenSecondsRaw;
    const listenRatio = durationValue > 0 ? Math.min(1, listenSeconds / durationValue) : null;

    const manualSkip = Boolean(skipReason);
    const autoSkip = listenSeconds < SKIP_SECONDS_THRESHOLD
      || (listenRatio != null && listenRatio < SKIP_RATIO_THRESHOLD);

    const skipped = endedNaturally ? false : (manualSkip || autoSkip);
    const finalSkipReason = manualSkip ? skipReason : (skipped ? 'short_listen' : null);

    const resolvedQuality = getTrackQualityValue(track, quality);
    const requestedQuality = track?.requestedQuality || quality || null;
    const usedQuality = track?.usedQuality || null;

    const entry = {
      id: track.id,
      title: track.title,
      artist: getArtistName(track),
      cover: track.album?.cover || track.cover,
      duration: track.duration,
      quality: resolvedQuality || null,
      requestedQuality,
      usedQuality,
      listenSeconds,
      listenRatio,
      skipped,
      skipReason: finalSkipReason,
      source: state.source || 'manual',
      endedNaturally: endedNaturally && !skipped,
      playedAt: new Date().toISOString()
    };

    playbackRef.current = { ...state, recorded: true };

    if (track?.id != null && isAuthenticated) {
      try {
        await api.history.addToHistory(track.id, entry);
      } catch (err) {
        console.error('Error guardando historial:', err);
      }
    }

    appendHistoryEntry(entry, !isAuthenticated);
  };


  // Reproducir track
  const handlePlayTrack = async (track, options = {}) => {
    const { source = null, action = 'manual_select' } = options || {};
    const resolvedSource = source || (activeTab === 'search' ? 'search' : 'manual');
    const prev = playbackRef.current;
    if (prev?.track && prev.track?.id !== track?.id && !prev.recorded) {
      void recordPlayback({ skipReason: action, endedNaturally: false });
    }

    playbackRef.current = {
      track,
      source: resolvedSource,
      startedAt: Date.now(),
      recorded: false
    };

    playTrack(track);

    // Agregar a cola si no est??
    if (track?.id != null) {
      playedRef.current.add(track.id);
    }
    if (track?.title) {
      const normalized = normalizeText(track.title);
      if (normalized) {
        playedTitleRef.current.add(normalized);
      }
    }

    setQueue(prev =>
      track?.id != null && !prev.find(t => t.id === track.id)
        ? [...prev, track]
        : prev
    );
  };

  // Favoritos
  const handleToggleFavorite = async (track) => {
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }
    
    const isFav = favorites.some(f => f.id === track.id);
    
    try {
      if (isFav) {
        await api.favorite.removeFavorite(track.id);
        setFavorites(favorites.filter(f => f.id !== track.id));
      } else {
        await api.favorite.addFavorite(track.id, {
          title: track.title,
          artist: getArtistName(track),
          cover: track.album?.cover || track.cover,
          duration: track.duration
        });
        setFavorites([...favorites, track]);
      }
    } catch (err) {
      console.error('Error con favorito:', err);
    }
  };

  // Autoplay continuo
  const appendToQueue = (tracks) => {
    if (!tracks || tracks.length === 0) return;
    setQueue(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      const next = [...prev];
      tracks.forEach(t => {
        if (!t || t.id == null) return;
        if (!existingIds.has(t.id)) {
          existingIds.add(t.id);
          next.push(t);
        }
      });
      return next;
    });
  };

  const getNextTrackFromQueue = () => {
    if (!currentTrack || queue.length === 0) return null;

    if (isShuffle) {
      const candidates = queue.filter(t => t.id !== currentTrack.id);
      if (candidates.length === 0) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    const currentIndex = queue.findIndex(t => t.id === currentTrack.id);
    if (currentIndex === -1) {
      return null;
    }
    if (currentIndex < queue.length - 1) {
      return queue[currentIndex + 1];
    }
    return null;
  };

  useEffect(() => {
    if (!currentTrack) return;
    const key = getLyricsKey(currentTrack);
    if (!key) return;
    if (lyricsCache[key]) return;
    if (lyricsInFlightRef.current.has(key)) return;

    lyricsInFlightRef.current.add(key);
    const trackVersion = typeof currentTrack?.version === 'string' ? currentTrack.version.trim() : '';
    api.track
      .getLyrics(currentTrack.title, getArtistName(currentTrack), {
        version: trackVersion,
        album: currentTrack?.album?.title || currentTrack?.albumTitle,
        duration: currentTrack?.duration
      })
      .then(response => {
        const raw = response?.raw ?? response;
        setLyricsCache(prev => ({ ...prev, [key]: raw }));
      })
      .catch(err => {
        console.error('Error precargando letras:', err);
      })
      .finally(() => {
        lyricsInFlightRef.current.delete(key);
      });
  }, [currentTrack, lyricsCache]);

  const getLyricsKey = (track) => {
    if (!track) return '';
    const artist = getArtistName(track);
    const title = track.title || '';
    const version = typeof track.version === 'string' ? track.version.trim() : '';
    const id = track.id ?? '';
    return `${id}|${title}|${version}|${artist}`.toLowerCase();
  };

  const fetchAutoplayTracks = async () => {
    if (!currentTrack) return [];

    const runId = ++autoplayRunIdRef.current;
    const currentSnapshot = currentTrack;
    const currentId = currentSnapshot?.id ?? null;

    try {
      const recommendationsPromise = api.recommendations
        .getRecommendations(currentId, 30, 0)
        .catch(() => null);

      const recommendationsResult = await recommendationsPromise;
      if (runId !== autoplayRunIdRef.current || currentTrack?.id !== currentId) return [];

      const recommendationsItems = recommendationsResult?.items || [];
      const recommendationsTracks = Array.isArray(recommendationsItems)
        ? recommendationsItems
            .map((item) => (item && item.track ? item.track : item))
            .filter(Boolean)
        : [];

      let trendingSource = trendingTracks;
      if (!Array.isArray(trendingSource) || trendingSource.length === 0) {
        const trendingData = await api.explore.getTrending(20, 0).catch(() => null);
        trendingSource = trendingData?.items || [];
      }

      if (runId !== autoplayRunIdRef.current || currentTrack?.id !== currentId) return [];

      const queueIds = new Set(queue.map(t => t?.id).filter(id => id != null));
      const seenIds = new Set([currentId, ...queueIds, ...playedRef.current]);
      const seenKeys = new Set();

      const filterTracks = (items, limit, allowRepeats = false) => {
        if (!Array.isArray(items) || items.length === 0) return [];
        const results = [];
        for (const track of items) {
          if (!track) continue;
          const trackId = track.id ?? track.trackId ?? null;
          if (trackId == null) continue;
          if (!allowRepeats && seenIds.has(trackId)) continue;
          const key = getTrackKey(track);
          if (!allowRepeats && key && seenKeys.has(key)) continue;
          seenIds.add(trackId);
          if (key) seenKeys.add(key);
          results.push(track);
          if (results.length >= limit) break;
        }
        return results;
      };

      let results = filterTracks(recommendationsTracks, 20, false);
      if (results.length === 0 && Array.isArray(recommendationsTracks) && recommendationsTracks.length > 0) {
        // Si hay recomendaciones pero todas quedaron filtradas, permitir repetidos antes de ir a trending
        results = filterTracks(recommendationsTracks, 20, true);
      }
      if (results.length === 0 && Array.isArray(trendingSource) && trendingSource.length > 0) {
        results = filterTracks(trendingSource, 20, false);
      }
      if (results.length === 0 && Array.isArray(trendingSource) && trendingSource.length > 0) {
        // Relax repeats to avoid dead-ends
        results = filterTracks(trendingSource, 20, true);
      }

      return results;
    } catch (err) {
      console.error('Error en autoplay:', err);
      return [];
    }
  };

  const handleDownloadTrack = async (track) => {
    if (!track?.id) return;
    if (downloadInFlightRef.current) return;
    downloadInFlightRef.current = true;

    try {
      const { blob, filename } = await api.track.downloadTrack(track, quality);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const fallbackExt = quality?.includes('LOSSLESS') ? 'flac' : 'm4a';
      link.download = filename || `${track.title || 'track'}.${fallbackExt}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error descargando track:', err);
    } finally {
      downloadInFlightRef.current = false;
    }
  };

  const handleAutoNext = async () => {
    if (autoNextInFlightRef.current) return;
    autoNextInFlightRef.current = true;

    try {
      const nextFromQueue = getNextTrackFromQueue();
      if (nextFromQueue) {
        handlePlayTrack(nextFromQueue, { source: 'queue', action: 'autoplay_next' });
        return;
      }

      const autoplayTracks = await fetchAutoplayTracks();
      if (autoplayTracks.length > 0) {
        appendToQueue(autoplayTracks);
        handlePlayTrack(autoplayTracks[0], { source: 'autoplay', action: 'autoplay_next' });
      }
    } finally {
      autoNextInFlightRef.current = false;
    }
  };

  useEffect(() => {
    autoNextRef.current = handleAutoNext;
  }, [handleAutoNext]);

  useEffect(() => {
    if (!setOnEndedCallback) return;
    setOnEndedCallback(() => {
      recordPlayback({ endedNaturally: true });
      if (autoNextRef.current) {
        autoNextRef.current();
      }
    });
    return () => setOnEndedCallback(null);
  }, [setOnEndedCallback]);

  // Navegación
  const handleSkipNext = () => {
    recordPlayback({ skipReason: 'manual_next', endedNaturally: false });
    handleAutoNext();
  };

  const handleSkipPrevious = () => {
    const currentIndex = queue.findIndex(t => t.id === currentTrack?.id);
    if (currentIndex > 0) {
      recordPlayback({ skipReason: 'manual_prev', endedNaturally: false });
      handlePlayTrack(queue[currentIndex - 1], { source: 'queue', action: 'manual_prev' });
    }
  };

  useMediaSession({
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    audioRef,
    onPlay: playCurrent,
    onPause: pauseWithFade,
    onNext: handleSkipNext,
    onPrevious: handleSkipPrevious
  });

  // Auth handlers
  const handleLogin = async (email, password) => {
    try {
      await login(email, password);
      setShowAuthModal(false);
      await loadUserData();
    } catch (err) {
      // Error manejado por useAuth
    }
  };

  const handleRegister = async (email, password, name) => {
    try {
      await register(email, password, name);
      setShowAuthModal(false);
      await loadUserData();
    } catch (err) {
      // Error manejado por useAuth
    }
  };

  const handleLogout = () => {
    logout();
    setMyPlaylists([]);
    setFavorites([]);
    loadGuestHistory();
    setShowUserMenu(false);
  };

  const handleCreatePlaylist = async () => {
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }
    const name = window.prompt('Nombre de la playlist');
    if (!name || !name.trim()) return;
    const description = window.prompt('Descripción (opcional)') || '';
    try {
      await api.playlist.createPlaylist(name.trim(), description.trim(), true);
      await loadUserData();
    } catch (err) {
      console.error('Error creando playlist:', err);
    }
  };

  const scrollToLibrarySection = (sectionId) => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {}
  };

  const normalizeHistoryTrack = (entry) => {
    if (!entry) return null;
    const base = entry.trackData || entry.track || entry;
    const id = base.id ?? entry.id ?? entry.trackId;
    const title = base.title ?? entry.title;
    const artistName = entry.artist || base.artist?.name || (typeof base.artist === 'string' ? base.artist : null);
    const artists = Array.isArray(base.artists) && base.artists.length > 0
      ? base.artists
      : (artistName ? artistName.split(',').map(name => ({ name: name.trim() })) : []);
    const album = base.album || (entry.cover ? { cover: entry.cover } : undefined);
    const usedQuality = base.usedQuality ?? entry.usedQuality ?? null;
    const requestedQuality = base.requestedQuality ?? entry.requestedQuality ?? null;
    const audioQuality = base.audioQuality ?? entry.audioQuality ?? null;
    const qualityValue = base.quality ?? entry.quality ?? null;

    return {
      ...base,
      id,
      title,
      artists,
      artist: base.artist || (artistName ? { name: artistName } : base.artist),
      album,
      cover: base.cover || entry.cover,
      duration: base.duration ?? entry.duration,
      usedQuality,
      requestedQuality,
      audioQuality,
      quality: qualityValue
    };
  };

  const historyTracks = Array.isArray(history)
    ? history.map(normalizeHistoryTrack).filter(Boolean)
    : [];

  const lyricsKey = getLyricsKey(currentTrack);
  const preloadedLyrics = lyricsKey ? lyricsCache[lyricsKey] : null;

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      {/* Header */}
      <div className="bg-gray-950 border-b border-gray-800 p-4 shadow-lg z-20 relative">
        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2 flex-shrink-0">
          <div className="bg-green-600 rounded-full p-2">
            <Music size={28} />
          </div>
            <h1 className="text-3xl font-bold text-white">
              Yupify
            </h1>
          </div>
          <div className="flex-1" />
          
          {!isAuthenticated ? (
            <button 
              onClick={() => setShowAuthModal(true)}
              className="bg-green-600 hover:bg-green-700 rounded-full px-6 py-2 transition-all shadow-lg font-semibold flex-shrink-0"
            >
              Iniciar Sesión
            </button>
          ) : (
            <div className="md:hidden flex-shrink-0">
              <button 
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="w-10 h-10 rounded-full bg-green-600 flex items-center justify-center"
              >
                <span className="text-white font-bold">
                  {user?.name?.charAt(0).toUpperCase()}
                </span>
              </button>
            </div>
          )}
        </div>

        {isAuthenticated && showUserMenu && (
          <div className="md:hidden absolute right-4 top-20 bg-gray-900 rounded-xl shadow-2xl border border-gray-800 z-40 min-w-[220px]">
            <div className="px-4 py-3 border-b border-gray-800">
              <p className="text-sm font-semibold text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-400 truncate">{user?.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full text-left px-4 py-3 text-sm text-red-400 hover:bg-red-900/20 rounded-b-xl"
            >
              Cerrar sesión
            </button>
          </div>
        )}
        
        <div className="lg:pl-64">
          <SearchBar onSearch={handleSearch} loading={loading} />
        </div>
      </div>

      {/* Contenido principal */}
      <div ref={contentRef} className="flex-1 overflow-y-auto pb-32 md:pb-24 lg:pl-64">
        <div className="p-4 md:p-6">
          {activeTab === 'home' && (
            <div className="space-y-8">
              {trendingTracks.length > 0 ? (
                <section>
                  <div className="flex items-center gap-2 mb-4">
                    <TrendingUp className="text-[#1db954]" size={24} />
                    <h2 className="text-2xl font-bold">Popular Ahora</h2>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {trendingTracks.map((track) => (
                      <TrackCard
                        key={track.id}
                        track={track}
                        onPlay={handlePlayTrack}
                        onToggleFavorite={handleToggleFavorite}
                        onDownload={handleDownloadTrack}
                        isFavorite={favorites.some(f => f.id === track.id)}
                      />
                    ))}
                  </div>
                  {trendingLoading && (
                    <div className="flex justify-center py-6">
                      <Loader className="animate-spin text-[#1db954]" size={28} />
                    </div>
                  )}
                </section>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Music className="text-gray-600 mb-4" size={48} />
                  <p className="text-gray-400 text-lg">Usa la búsqueda para descubrir música</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'search' && (
            <div>
              <h2 className="text-2xl font-bold mb-4">Resultados de Búsqueda</h2>
              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader className="animate-spin text-[#1db954]" size={48} />
                </div>
              ) : searchResults.length > 0 ? (
                <TrackList
                  tracks={searchResults}
                  onPlay={handlePlayTrack}
                  onToggleFavorite={handleToggleFavorite}
                  onDownload={handleDownloadTrack}
                  favorites={favorites}
                  currentTrackId={currentTrack?.id}
                />
              ) : (
                <p className="text-gray-400 text-center py-12">
                  No se encontraron resultados
                </p>
              )}
            </div>
          )}

          {activeTab === 'queue' && (
            <div>
              <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                <Disc size={28} />
                Cola de Reproducción
              </h2>
              {queue.length > 0 ? (
                <TrackList
                  tracks={queue}
                  onPlay={handlePlayTrack}
                  onToggleFavorite={handleToggleFavorite}
                  onDownload={handleDownloadTrack}
                  favorites={favorites}
                  currentTrackId={currentTrack?.id}
                />
              ) : (
                <p className="text-gray-400 text-center py-12">
                  No hay canciones en la cola
                </p>
              )}
            </div>
          )}

          {activeTab === 'library' && (
            <div className="space-y-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div 
                  onClick={() => isAuthenticated ? scrollToLibrarySection('library-favorites') : setShowAuthModal(true)}
                  className="bg-gradient-to-br from-[#1db954] to-emerald-400 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Heart size={32} className="mb-2" />
                  <h3 className="font-bold">Favoritos</h3>
                  <p className="text-sm opacity-80">{favorites.length} canciones</p>
                </div>
                <div 
                  onClick={() => scrollToLibrarySection('library-history')}
                  className="bg-gradient-to-br from-blue-600 to-cyan-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Clock size={32} className="mb-2" />
                  <h3 className="font-bold">Historial</h3>
                  <p className="text-sm opacity-80">{history.length} canciones</p>
                </div>
                <div 
                  onClick={() => isAuthenticated ? scrollToLibrarySection('library-playlists') : setShowAuthModal(true)}
                  className="bg-gradient-to-br from-green-600 to-teal-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Music size={32} className="mb-2" />
                  <h3 className="font-bold">Playlists</h3>
                  <p className="text-sm opacity-80">{myPlaylists.length} playlists</p>
                </div>
                <div 
                  onClick={handleCreatePlaylist}
                  className="bg-gradient-to-br from-orange-600 to-red-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Plus size={32} className="mb-2" />
                  <h3 className="font-bold">Crear</h3>
                  <p className="text-sm opacity-80">Nueva playlist</p>
                </div>
              </div>
              
              {isAuthenticated && (
                <section id="library-favorites">
                  <h2 className="text-2xl font-bold mb-4">Tus Favoritos</h2>
                  {favorites.length > 0 ? (
                    <TrackList
                      tracks={favorites.slice(0, 10)}
                      onPlay={handlePlayTrack}
                      onToggleFavorite={handleToggleFavorite}
                      onDownload={handleDownloadTrack}
                      favorites={favorites}
                      currentTrackId={currentTrack?.id}
                    />
                  ) : (
                    <p className="text-gray-400">Aún no tienes favoritos.</p>
                  )}
                </section>
              )}

              <section id="library-history">
                <h2 className="text-2xl font-bold mb-4">Historial</h2>
                {historyTracks.length > 0 ? (
                  <TrackList
                    tracks={historyTracks.slice(0, 20)}
                    onPlay={handlePlayTrack}
                    onToggleFavorite={handleToggleFavorite}
                    onDownload={handleDownloadTrack}
                    favorites={favorites}
                    currentTrackId={currentTrack?.id}
                  />
                ) : (
                  <p className="text-gray-400">No hay historial todavía.</p>
                )}
              </section>

              {isAuthenticated && (
                <section id="library-playlists">
                  <h2 className="text-2xl font-bold mb-4">Playlists</h2>
                  {myPlaylists.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {myPlaylists.map((pl) => (
                        <div key={pl.id || pl._id || pl.name} className="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
                          <h3 className="font-semibold text-white truncate">{pl.name || pl.title || 'Playlist'}</h3>
                          {pl.description && (
                            <p className="text-xs text-gray-400 mt-1 line-clamp-2">{pl.description}</p>
                          )}
                          <p className="text-xs text-gray-500 mt-2">
                            {(pl.trackCount ?? pl.tracks?.length ?? 0)} canciones
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-400">Aún no tienes playlists.</p>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Navegación */}
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isAuthenticated={isAuthenticated}
        user={user}
        showUserMenu={showUserMenu}
        onToggleUserMenu={() => setShowUserMenu(!showUserMenu)}
        onLogout={handleLogout}
        quality={quality}
        setQuality={setQuality}
      />

<Player
  currentTrack={currentTrack}
  streamUrl={streamUrl || ""}
  isPlaying={isPlaying}
  currentTime={currentTime}
  duration={duration}
  volume={volume}
  isMuted={isMuted}
  isRepeat={isRepeat}
  isShuffle={isShuffle}

  onTogglePlay={togglePlay}
  onSkipNext={handleSkipNext}
  onSkipPrevious={handleSkipPrevious}
  onSeek={handleSeek}
  onVolumeChange={handleVolumeChange}
  onToggleMute={toggleMute}
  onToggleFavorite={handleToggleFavorite}
  onDownload={handleDownloadTrack}
  onToggleRepeat={() => setIsRepeat(!isRepeat)}
  onToggleShuffle={() => setIsShuffle(!isShuffle)}
  onTimeUpdate={handleTimeUpdate}
  onEnded={handleEnded}
  audioRef={audioRef}
  preloadedLyrics={preloadedLyrics}

  // Control de calidad
  quality={quality}
  onChangeQuality={setQuality}
/>

      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onLogin={handleLogin}
        onRegister={handleRegister}
        loading={authLoading}
        error={authError}
      />
    </div>
  );
};

export default App;
