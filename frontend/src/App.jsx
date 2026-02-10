// src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import { Music, TrendingUp, Disc, Heart, Clock, Plus, Loader } from 'lucide-react';

// Hooks
import useAudio from './hooks/useAudio';
import useAuth from './hooks/useAuth';

// Components
import Player from './components/Player';
import SearchBar from './components/SearchBar';
import TrackCard from './components/TrackCard';
import TrackList from './components/TrackList';
import AuthModal from './components/AuthModal';
import Navigation from './components/Navigation';

// Services
import api from './services/api';
import { getArtistName, shuffleArray } from './utils/helpers';

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
  const autoplaySeedRef = useRef(null);
  const lyricsInFlightRef = useRef(new Set());
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

  // Cargar datos al iniciar
  useEffect(() => {
    loadHomeContent();
    loadTrending(true);
    if (isAuthenticated) {
      loadUserData();
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
      
      setMyPlaylists(playlistsData.playlists || []);
      setFavorites(favoritesData.favorites || []);
      setHistory(historyData.history || []);
    } catch (err) {
      console.error('Error cargando datos:', err);
    }
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

  // Reproducir track
  const handlePlayTrack = async (track) => {
    playTrack(track);
    
    // Agregar a cola si no está
    if (track?.id != null) {
      playedRef.current.add(track.id);
    }
    if (track?.title) {
      const normalized = normalizeTitle(track.title);
      if (normalized) {
        playedTitleRef.current.add(normalized);
      }
    }

    setQueue(prev =>
      track?.id != null && !prev.find(t => t.id === track.id)
        ? [...prev, track]
        : prev
    );
    
    // Agregar al historial si está autenticado
    if (isAuthenticated) {
      try {
        await api.history.addToHistory(track.id, {
          title: track.title,
          artist: getArtistName(track),
          cover: track.album?.cover || track.cover,
          duration: track.duration
        });
      } catch (err) {
        console.error('Error agregando al historial:', err);
      }
    }
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
    if (autoplaySeedRef.current != null) return;
    const key = 'yupify_autoplay_seed';
    const stored = sessionStorage.getItem(key);
    let seed = Number(stored);
    if (!Number.isFinite(seed)) {
      seed = Math.floor(Math.random() * 1_000_000_000);
      sessionStorage.setItem(key, String(seed));
    }
    autoplaySeedRef.current = seed;
  }, []);

  useEffect(() => {
    if (!currentTrack) return;
    const key = getLyricsKey(currentTrack);
    if (!key) return;
    if (lyricsCache[key]) return;
    if (lyricsInFlightRef.current.has(key)) return;

    lyricsInFlightRef.current.add(key);
    api.track
      .getLyrics(currentTrack.title, getArtistName(currentTrack))
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

  const seededRandom = (seed) => {
    let t = seed + 0x6D2B79F5;
    return () => {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  const seededShuffle = (array, seed) => {
    const shuffled = [...array];
    const rand = seededRandom(seed);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const normalizeTitle = (text) => {
    if (!text) return '';
    return text
      .toString()
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/[^a-z0-9à-öø-ÿ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const getLyricsKey = (track) => {
    if (!track) return '';
    const artist = getArtistName(track);
    const title = track.title || '';
    const id = track.id ?? '';
    return `${id}|${title}|${artist}`.toLowerCase();
  };

  const getFirstWord = (text) => {
    if (!text) return '';
    const cleaned = text
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/[^A-Za-z0-9À-ÖØ-öø-ÿ\s]/g, ' ')
      .trim();
    if (!cleaned) return '';
    const word = cleaned.split(/\s+/)[0];
    return word.length >= 3 ? word : '';
  };

  const getGenreTerm = (track) => {
    if (!track) return '';
    if (typeof track.genre === 'string') return track.genre;
    if (track.genre?.name) return track.genre.name;
    if (Array.isArray(track.genres) && track.genres.length > 0) {
      const first = track.genres[0];
      if (typeof first === 'string') return first;
      if (first?.name) return first.name;
    }
    return '';
  };

  const fetchAutoplayTracks = async () => {
    if (!currentTrack) return [];

    const artistName = getArtistName(currentTrack);
    const useArtist = artistName && artistName !== 'Artista Desconocido';
    const titleFirstWord = getFirstWord(currentTrack.title);
    const genreTerm = getGenreTerm(currentTrack);
    const currentTitleNorm = normalizeTitle(currentTrack.title);

    try {
      const queries = [];
      if (titleFirstWord) queries.push({ type: 'query', value: titleFirstWord });
      if (useArtist) queries.push({ type: 'artist', value: artistName });
      if (genreTerm) queries.push({ type: 'query', value: genreTerm });
      if (currentTrack.title) queries.push({ type: 'query', value: currentTrack.title });

      let items = [];
      for (const q of queries) {
        if (q.type === 'artist') {
          const artistResults = await api.search.searchArtist(q.value, 25);
          items = artistResults.items || [];
          if (items.length === 0) {
            const fallbackArtist = await api.search.search(q.value, 25);
            items = fallbackArtist.items || [];
          }
        } else {
          const res = await api.search.search(q.value, 25);
          items = res.items || [];
        }
        if (items.length > 0) break;
      }

      const existingIds = new Set(queue.map(t => t.id));
      const playedIds = playedRef.current;

      const filtered = items.filter(t => {
        if (!t || t.id == null) return false;
        if (t.id === currentTrack.id) return false;
        if (existingIds.has(t.id)) return false;
        if (playedIds.has(t.id)) return false;

        const candidateTitleNorm = normalizeTitle(t.title);
        if (currentTitleNorm && candidateTitleNorm === currentTitleNorm) return false;
        if (candidateTitleNorm && playedTitleRef.current.has(candidateTitleNorm)) return false;

        return true;
      });

      const seedBase = autoplaySeedRef.current ?? 0;
      const seed = seedBase ^ (currentTrack.id ?? 0);
      const diversified = seededShuffle(filtered, seed);
      return isShuffle ? shuffleArray(diversified) : diversified;
    } catch (err) {
      console.error('Error en autoplay:', err);
      return [];
    }
  };

  const handleAutoNext = async () => {
    if (autoNextInFlightRef.current) return;
    autoNextInFlightRef.current = true;

    try {
    const nextFromQueue = getNextTrackFromQueue();
    if (nextFromQueue) {
      handlePlayTrack(nextFromQueue);
      return;
    }

    const autoplayTracks = await fetchAutoplayTracks();
    if (autoplayTracks.length > 0) {
      appendToQueue(autoplayTracks);
      handlePlayTrack(autoplayTracks[0]);
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
      if (autoNextRef.current) {
        autoNextRef.current();
      }
    });
    return () => setOnEndedCallback(null);
  }, [setOnEndedCallback]);

  // Navegación
  const handleSkipNext = () => {
    handleAutoNext();
  };

  const handleSkipPrevious = () => {
    const currentIndex = queue.findIndex(t => t.id === currentTrack?.id);
    if (currentIndex > 0) {
      handlePlayTrack(queue[currentIndex - 1]);
    }
  };

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
    setHistory([]);
    setShowUserMenu(false);
  };

  const lyricsKey = getLyricsKey(currentTrack);
  const preloadedLyrics = lyricsKey ? lyricsCache[lyricsKey] : null;

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      {/* Header */}
      <div className="bg-gray-950 border-b border-gray-800 p-4 shadow-lg z-20">
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
                  onClick={() => isAuthenticated ? setActiveTab('favorites') : setShowAuthModal(true)}
                  className="bg-gradient-to-br from-[#1db954] to-emerald-400 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Heart size={32} className="mb-2" />
                  <h3 className="font-bold">Favoritos</h3>
                  <p className="text-sm opacity-80">{favorites.length} canciones</p>
                </div>
                <div className="bg-gradient-to-br from-blue-600 to-cyan-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all">
                  <Clock size={32} className="mb-2" />
                  <h3 className="font-bold">Historial</h3>
                  <p className="text-sm opacity-80">{history.length} canciones</p>
                </div>
                <div className="bg-gradient-to-br from-green-600 to-teal-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all">
                  <Music size={32} className="mb-2" />
                  <h3 className="font-bold">Playlists</h3>
                  <p className="text-sm opacity-80">{myPlaylists.length} playlists</p>
                </div>
                <div 
                  onClick={() => isAuthenticated ? {} : setShowAuthModal(true)}
                  className="bg-gradient-to-br from-orange-600 to-red-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
                >
                  <Plus size={32} className="mb-2" />
                  <h3 className="font-bold">Crear</h3>
                  <p className="text-sm opacity-80">Nueva playlist</p>
                </div>
              </div>
              
              {isAuthenticated && favorites.length > 0 && (
                <section>
                  <h2 className="text-2xl font-bold mb-4">Tus Favoritos</h2>
                  <TrackList
                    tracks={favorites.slice(0, 10)}
                    onPlay={handlePlayTrack}
                    onToggleFavorite={handleToggleFavorite}
                    favorites={favorites}
                    currentTrackId={currentTrack?.id}
                  />
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
