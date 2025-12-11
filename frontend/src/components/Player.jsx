import React, { useState } from "react";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  Heart,
  Share2,
  Repeat,
  Shuffle,
  FileText
} from "lucide-react";

const Player = ({
  currentTrack = null,
  streamUrl = "",
  isPlaying = false,
  currentTime = 0,
  duration = 0,
  volume = 1,
  isMuted = false,
  isRepeat = false,
  isShuffle = false,
  isFavorite = false,

  onTogglePlay = () => {},
  onSkipNext = () => {},
  onSkipPrevious = () => {},
  onSeek = () => {},
  onVolumeChange = () => {},
  onToggleMute = () => {},
  onToggleFavorite = () => {},
  onToggleRepeat = () => {},
  onToggleShuffle = () => {},
  audioRef = null,
  onTimeUpdate = () => {},
  onEnded = () => {},

  // 🔥 AGREGAR ESTO
  quality = "LOSSLESS",
  onChangeQuality = () => {}
}) => {
  // ----------------------
  // 🔥 LYRICS MODAL
  // ----------------------
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("Cargando...");

  const openLyrics = async () => {
    if (!currentTrack) return;

    setLyricsOpen(true);
    setLyricsContent("Cargando letras...");

    try {
      const res = await fetch(
        `/api/lyrics?track=${encodeURIComponent(currentTrack.title)}&artist=${encodeURIComponent(currentTrack.artist?.name || "")}`
      );
      const data = await res.json();

      setLyricsContent(data?.lyrics || "No se encontraron letras.");
    } catch (err) {
      setLyricsContent("Error al obtener letras.");
    }
  };

  // ----------------------
  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  if (!currentTrack) return null;

  const tidalCover = currentTrack.album?.cover
    ? `https://resources.tidal.com/images/${currentTrack.album.cover.replace(/-/g, "/")}/1280x1280.jpg`
    : currentTrack.cover || "";

  return (
    <>
      {/* 🎤 Modal de Letras */}
      {lyricsOpen && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex justify-center items-center p-4"
          onClick={() => setLyricsOpen(false)}
        >
          <div
            className="bg-gray-900 p-6 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-gray-700 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">
              Letras de {currentTrack.title}
            </h2>

            <pre className="whitespace-pre-wrap text-gray-300 leading-relaxed">
              {lyricsContent}
            </pre>

            <button
              onClick={() => setLyricsOpen(false)}
              className="mt-4 w-full py-2 bg-purple-600 hover:bg-purple-700 rounded-lg"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

    {/* Selector de calidad */}
<div className="mt-3 px-4">
  <label className="text-gray-400 text-xs font-semibold px-1">
    Calidad de audio
  </label>
  <select
    className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-2 outline-none focus:border-green-500 transition"
    value={quality}
    onChange={(e) => {
      const q = e.target.value;
      onChangeQuality(q);
      localStorage.setItem("audioQuality", q);
    }}
  >
    <option value="LOSSLESS">LOSSLESS</option>
    <option value="HIGH">HIGH</option>
    <option value="MEDIUM">MEDIUM</option>
    <option value="LOW">LOW</option>
  </select>
</div>
      {/* 🎧 PLAYER */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 shadow-2xl lg:pl-64">

        {/* Info */}
        <div className="flex items-center gap-4 px-4 pt-3">
          <img
            src={tidalCover}
            alt={currentTrack.title}
            className="w-16 h-16 rounded-lg shadow-lg"
            onError={(e) => (e.target.src = currentTrack.cover || "")}
          />

          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate">{currentTrack.title}</h3>
            <p className="text-sm text-gray-400 truncate">
              {currentTrack.artist?.name || "Desconocido"}
            </p>
            <span className="text-xs text-purple-400">LOSSLESS</span>
          </div>

          <button onClick={onToggleFavorite}>
            <Heart
              size={24}
              className={
                isFavorite
                  ? "fill-red-500 text-red-500"
                  : "text-gray-400 hover:text-white"
              }
            />
          </button>

          <button className="ml-2" onClick={openLyrics}>
            <FileText size={24} className="text-gray-400 hover:text-white" />
          </button>
        </div>

        {/* Barra progreso */}
        <div className="px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>{formatTime(currentTime)}</span>

            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="flex-1"
            />

            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Controles */}
        <div className="flex items-center justify-center gap-4 px-4 pb-4">
          <button onClick={onToggleShuffle}>
            <Shuffle className={isShuffle ? "text-green-500" : "text-gray-400"} />
          </button>

          <button onClick={onSkipPrevious}>
            <SkipBack size={32} className="text-gray-400" />
          </button>

          <button
            onClick={onTogglePlay}
            className="bg-green-600 hover:bg-green-700 rounded-full p-4"
          >
            {isPlaying ? <Pause size={28} /> : <Play size={28} />}
          </button>

          <button onClick={onSkipNext}>
            <SkipForward size={32} className="text-gray-400" />
          </button>

          <button onClick={onToggleRepeat}>
            <Repeat className={isRepeat ? "text-green-500" : "text-gray-400"} />
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
              onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
            />
          </div>
        </div>

        {/* 🎵 Audio real */}
        {streamUrl && (
          <audio
            ref={audioRef}
            src={streamUrl}
            crossOrigin="anonymous"
            onTimeUpdate={onTimeUpdate}
            onEnded={onEnded}
          />
        )}
      </div>
    </>
  );
};

export default Player;
