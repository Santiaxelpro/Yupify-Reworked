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
import { getArtistName } from '../utils/helpers';
import api from '../services/api';

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
  const purple = '#9333ea';
  // ----------------------
  // 🔥 LYRICS MODAL
  // ----------------------
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("Cargando...");
  const [lyricsStructured, setLyricsStructured] = useState(null);
  const linesRef = React.useRef([]);
  const [activeLineIndex, setActiveLineIndex] = React.useState(-1);
  const [activeSyllableIndex, setActiveSyllableIndex] = React.useState(-1);

  // Función que busca sílaba en un tiempo dado
  const findActiveSyllable = React.useCallback((timeSeconds) => {
    if (!lyricsStructured) return { foundLine: -1, foundSyll: -1 };

    // Buscar la línea activa (la última que ha empezado)
    let foundLine = -1;
    for (let i = 0; i < lyricsStructured.length; i++) {
      if (lyricsStructured[i].time <= timeSeconds) {
        foundLine = i;
      } else {
        break;
      }
    }

    if (foundLine === -1) return { foundLine: -1, foundSyll: -1 };

    // Buscar la sílaba activa dentro de la línea (la última que ha empezado)
    let foundSyll = -1;
    const line = lyricsStructured[foundLine];
    if (line.syllabus) {
      for (let j = 0; j < line.syllabus.length; j++) {
        if (line.syllabus[j].time <= timeSeconds) {
          foundSyll = j;
        } else {
          break;
        }
      }
    }
    
    return { foundLine, foundSyll };
  }, [lyricsStructured]);

  // SIMPLE: actualizar sílaba activa cuando currentTime cambia (event listener del audio)
  React.useEffect(() => {
    if (!lyricsStructured) return;

    const { foundLine, foundSyll } = findActiveSyllable(currentTime);
    setActiveLineIndex(foundLine);
    setActiveSyllableIndex(foundSyll);

    // Scroll al verso activo
    if (foundLine >= 0 && linesRef.current[foundLine]) {
      try {
        linesRef.current[foundLine].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
    }
  }, [currentTime, lyricsStructured, findActiveSyllable]);

  // Click handler para seek a una sílaba
  const handleSyllableClick = React.useCallback((syllableTime) => {
    const audio = document.getElementById('yupify-audio-player');
    if (audio) {
      audio.currentTime = syllableTime;
      audio.play();
    }
  }, []);

  const openLyrics = async () => {
    if (!currentTrack) return;

    setLyricsOpen(true);
    setLyricsContent("Cargando letras...");

    try {
      const response = await api.track.getLyrics(currentTrack.title, getArtistName(currentTrack));
      const data = response.raw;
      // Si la respuesta contiene estructura temporal tipo LRC (array con syllabus)
      // API SIEMPRE entrega tiempos en milisegundos, convertir a segundos
      const toSeconds = (t) => {
        if (t == null) return 0;
        const num = Number(t);
        if (Number.isNaN(num)) return 0;
        // Dividir por 1000: ms → segundos
        return num / 1000;
      };

      if (data && Array.isArray(data.lyrics) && data.lyrics.length > 0 && data.lyrics[0].syllabus) {
        const structured = data.lyrics.map((line, idx) => ({
          id: idx,
          time: toSeconds(line.time),
          duration: toSeconds(line.duration),
          text: line.text || '',
          syllabus: Array.isArray(line.syllabus) ? line.syllabus.map((s, si) => ({
            id: si,
            time: toSeconds(s.time),
            duration: toSeconds(s.duration),
            text: s.text || ''
          })) : []
        }));

        setLyricsStructured(structured);
        setLyricsContent('');
      } else {
        // Fallback a texto plano como antes
        let lyricsText = "";
        if (!data) lyricsText = "No se encontraron letras.";
        else if (typeof data === 'string') lyricsText = data;
        else if (data.lyrics && typeof data.lyrics === 'string') lyricsText = data.lyrics;
        else if (data.result && typeof data.result === 'string') lyricsText = data.result;
        else lyricsText = JSON.stringify(data, null, 2);

        setLyricsStructured(null);
        setLyricsContent(lyricsText || "No se encontraron letras.");
      }
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
      <style>{`
        .yupify-range {
          -webkit-appearance: none;
          appearance: none;
          height: 10px;
          border-radius: 999px;
          background: rgba(255,255,255,0.06);
          outline: none;
        }
        .yupify-range::-webkit-slider-runnable-track { height: 10px; border-radius: 999px; }
        .yupify-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: ${purple};
          box-shadow: 0 0 0 6px rgba(147,51,234,0.12);
          margin-top: -2px; /* center the thumb */
        }
        .yupify-range:focus { box-shadow: 0 0 0 4px rgba(147,51,234,0.08); }
        .yupify-range::-moz-range-track { height:10px; border-radius:999px; }
        .yupify-range::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background: ${purple}; }
        
        .lyrics-container {
          scrollbar-color: ${purple} transparent;
          scrollbar-width: thin;
        }
        .lyrics-container::-webkit-scrollbar {
          width: 8px;
        }
        .lyrics-container::-webkit-scrollbar-track {
          background: transparent;
        }
        .lyrics-container::-webkit-scrollbar-thumb {
          background: ${purple};
          border-radius: 999px;
        }
      `}</style>
      {/* 🎤 Modal de Letras */}
      {lyricsOpen && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex justify-center items-center p-4 backdrop-blur-sm"
          onClick={() => setLyricsOpen(false)}
        >
          <div
            className="bg-gray-900 p-8 rounded-2xl max-w-3xl w-full max-h-[85vh] border border-purple-500/30 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-2xl font-bold mb-6 text-white">
              🎤 Letras de <span className="text-purple-400">{currentTrack.title}</span>
            </h2>

            {lyricsStructured ? (
              <div className="lyrics-container text-gray-100 leading-relaxed space-y-4 flex-1 overflow-y-auto pr-2">
                {lyricsStructured.map((line, li) => (
                  <div
                    key={line.id}
                    ref={(el) => (linesRef.current[li] = el)}
                    className="text-base lg:text-lg py-2 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => {
                      if (line.time != null) handleSyllableClick(line.time);
                    }}
                  >
                    {line.syllabus.length > 0 ? (
                      line.syllabus.map((s, si) => {
                        const isSung = li === activeLineIndex && si <= activeSyllableIndex;
                        return (
                          <span
                            key={s.id}
                            className={isSung ? 'text-purple-400 font-bold text-lg drop-shadow-md' : 'text-gray-500'}
                            style={{ transition: 'all 0.08s ease-out', cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (s.time != null) handleSyllableClick(s.time);
                            }}
                          >
                            {s.text}
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-gray-300">{line.text}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-gray-300 leading-relaxed flex-1 overflow-y-auto">
                {lyricsContent}
              </pre>
            )}

            <button
              onClick={() => setLyricsOpen(false)}
              className="mt-6 w-full py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition"
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
    }}
  >
    <option value="HI_RES_LOSSLESS">HI-RES</option>
    <option value="LOSSLESS">LOSSLESS (FLAC)</option>
    <option value="HIGH">HIGH (320kbps)</option>
    <option value="LOW">LOW (96kbps)</option>
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
              {getArtistName(currentTrack)}
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
              max={100}
              value={duration ? (currentTime / duration) * 100 : 0}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="flex-1 yupify-range"
              style={{
                background: `linear-gradient(90deg, ${purple} ${duration ? (currentTime / duration) * 100 : 0}%, rgba(255,255,255,0.06) ${duration ? (currentTime / duration) * 100 : 0}%)`
              }}
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
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="yupify-range"
              style={{ width: 120 }}
            />
          </div>
        </div>

        {/* 🎵 El elemento <audio> ahora es global, creado en useAudio.js */}
        {/* No renderizar aquí para evitar duplicados */}
      </div>
    </>
  );
};

export default Player;
