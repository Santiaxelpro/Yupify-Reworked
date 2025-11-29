import React from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, VolumeX, Heart, Share2, Repeat, Shuffle } from 'lucide-react';

const Player = ({
  currentTrack,
  streamUrl,
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  isRepeat,
  isShuffle,
  isFavorite,

  onTogglePlay,
  onSkipNext,
  onSkipPrevious,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onToggleFavorite,
  onToggleRepeat,
  onToggleShuffle,
  audioRef,
  onTimeUpdate,
  onEnded
}) => {

  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  if (!currentTrack) return null;

  const tidalCover = currentTrack.album?.cover
    ? `https://resources.tidal.com/images/${currentTrack.album.cover.replace(/-/g, "/")}/1280x1280.jpg`
    : currentTrack.cover;

  return (
    <div className="fixed bottom-16 md:bottom-0 left-0 right-0 bg-gradient-to-t from-gray-950 via-gray-900 to-gray-900/95 backdrop-blur-xl border-t border-gray-800 shadow-2xl">

      {/* Info */}
      <div className="flex items-center gap-4 px-4 pt-3">
        <img
          src={tidalCover}
          alt={currentTrack.title}
          className="w-16 h-16 rounded-lg shadow-lg"
          onError={(e) => { e.target.src = currentTrack.cover; }}
        />

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate">{currentTrack.title}</h3>
          <p className="text-sm text-gray-400 truncate">
            {currentTrack.artist?.name}
          </p>
          <span className="text-xs text-purple-400">LOSSLESS</span>
        </div>

        <button onClick={onToggleFavorite}>
          <Heart size={24} className={isFavorite ? "fill-red-500 text-red-500" : "text-gray-400"} />
        </button>
      </div>

      {/* Progreso */}
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{formatTime(currentTime)}</span>

          <input
            type="range"
            min="0"
            max="100"
            value={(currentTime / duration) * 100 || 0}
            onChange={(e) => onSeek(e.target.value)}
            className="flex-1"
          />

          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controles */}
      <div className="flex items-center justify-center gap-4 px-4 pb-4">
        <button onClick={onToggleShuffle}>
          <Shuffle className={isShuffle ? "text-purple-400" : "text-gray-400"} />
        </button>

        <button onClick={onSkipPrevious}>
          <SkipBack size={32} className="text-gray-400" />
        </button>

        <button
          onClick={onTogglePlay}
          className="bg-gradient-to-r from-purple-600 to-pink-600 rounded-full p-4"
        >
          {isPlaying ? <Pause size={28} /> : <Play size={28} />}
        </button>

        <button onClick={onSkipNext}>
          <SkipForward size={32} className="text-gray-400" />
        </button>

        <button onClick={onToggleRepeat}>
          <Repeat className={isRepeat ? "text-purple-400" : "text-gray-400"} />
        </button>

        <div className="flex items-center gap-2 ml-4">
          <button onClick={onToggleMute}>
            {isMuted ? <VolumeX /> : <Volume2 />}
          </button>

          <input
            type="range"
            min="0"
            max="100"
            value={isMuted ? 0 : volume * 100}
            onChange={(e) => onVolumeChange(e.target.value)}
          />
        </div>
      </div>

      {/* Audio real */}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onError={(e) => console.error('Audio error:', e.target.error)}
        onLoadStart={() => console.log('Audio: loadstart')}
        onLoadedMetadata={() => console.log('Audio: loadedmetadata', audioRef.current?.duration)}
      />
    </div>
  );
};

export default Player;
