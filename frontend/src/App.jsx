// src/App.jsx
import React, { useState, useEffect } from 'react';
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
import { getArtistName } from './utils/helpers';

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
    setIsShuffle
  } = useAudio();

  // Auth hook
  const { user, isAuthenticated, loading: authLoading, error: authError, login, register, logout } = useAuth();

  // Estados
  const [activeTab, setActiveTab] = useState('home');
  const [searchResults, setSearchResults] = useState([]);
  const [queue, setQueue] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [myPlaylists, setMyPlaylists] = useState([]);
  const [history, setHistory] = useState([]);
  const [homeContent, setHomeContent] = useState(null);
  
  // Estados UI
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Cargar datos al iniciar
  useEffect(() => {
    loadHomeContent();
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
    if (!queue.find(t => t.id === track.id)) {
      setQueue([...queue, track]);
    }
    
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

  // Navegación
  const handleSkipNext = () => {
    const currentIndex = queue.findIndex(t => t.id === currentTrack?.id);
    if (currentIndex < queue.length - 1) {
      handlePlayTrack(queue[currentIndex + 1]);
    }
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
      <div className="flex-1 overflow-y-auto pb-32 md:pb-24 lg:pl-64">
        <div className="p-4 md:p-6">
          {activeTab === 'home' && (
            <div className="space-y-8">
              {searchResults.length > 0 ? (
                <section>
                  <div className="flex items-center gap-2 mb-4">
                    <TrendingUp className="text-purple-400" size={24} />
                    <h2 className="text-2xl font-bold">Popular Ahora</h2>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {searchResults.slice(0, 10).map((track) => (
                      <TrackCard
                        key={track.id}
                        track={track}
                        onPlay={handlePlayTrack}
                        onToggleFavorite={handleToggleFavorite}
                        isFavorite={favorites.some(f => f.id === track.id)}
                      />
                    ))}
                  </div>
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
                  <Loader className="animate-spin text-purple-500" size={48} />
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
                  className="bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl p-6 cursor-pointer hover:shadow-xl transition-all"
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