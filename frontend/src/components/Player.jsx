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
  onChangeQuality = () => {},
  preloadedLyrics = null
}) => {
  const accent = '#1db954';
  const accentSoft = 'rgba(29,185,84,0.4)';
  const accentBg = 'rgba(29,185,84,0.08)';
  // ----------------------
  // 🔥 LYRICS MODAL
  // ----------------------
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("Cargando...");
  const [lyricsStructured, setLyricsStructured] = useState(null);
  const linesRef = React.useRef([]);
  const [activeLineIndex, setActiveLineIndex] = React.useState(-1);
  const [activeSyllableIndex, setActiveSyllableIndex] = React.useState(-1);

  const toMs = (t) => {
    if (t == null) return 0;
    const num = Number(t);
    if (Number.isNaN(num)) return 0;
    return num;
  };

  const toSeconds = (t) => {
    const ms = toMs(t);
    return ms / 1000;
  };

  const normalizeLyricsPayload = (payload) => {
    const raw = payload?.raw ?? payload;
    if (!raw) return { structured: null, text: "No se encontraron letras." };
    const data = raw?.data ?? raw;

    if (typeof data === 'string') {
      return { structured: null, text: data };
    }

    if (data.lyrics && typeof data.lyrics === 'string') {
      return { structured: null, text: data.lyrics };
    }

    if (data.result && typeof data.result === 'string') {
      return { structured: null, text: data.result };
    }

    if (data.lyrics && Array.isArray(data.lyrics) && data.lyrics.length > 0) {
      const timesMs = data.lyrics.map(l => toMs(l?.time));
      const validTimes = timesMs.filter(t => Number.isFinite(t) && t > 0);
      const hasTiming = validTimes.length >= 2;

      let finalTimesMs = null;
      if (hasTiming) {
        finalTimesMs = timesMs;
      } else {
        const durationsMs = data.lyrics.map(l => toMs(l?.duration));
        const validDurations = durationsMs.filter(d => Number.isFinite(d) && d > 0);
        if (validDurations.length >= 2) {
          let acc = 0;
          finalTimesMs = durationsMs.map((d) => {
            const t = acc;
            acc += d || 0;
            return t;
          });
        }
      }

      const isUntimed = data.type === 'None' || !finalTimesMs;

      if (isUntimed) {
        const lines = data.lyrics
          .map(l => (l && typeof l.text === 'string' ? l.text.trim() : ''))
          .filter(Boolean);
        return {
          structured: null,
          text: lines.length > 0 ? lines.join('\n') : "No se encontraron letras."
        };
      }

      const structured = data.lyrics.map((line, idx) => {
        const syllabusRaw = Array.isArray(line.syllabus) ? line.syllabus : [];
        const validSyllableTimes = syllabusRaw.filter(s => {
          const t = toMs(s?.time);
          return Number.isFinite(t) && t > 0;
        });

        const syllabus = validSyllableTimes.length > 0
          ? syllabusRaw.map((s, si) => ({
              id: si,
              time: toSeconds(s.time),
              duration: toSeconds(s.duration),
              text: s.text || ''
            }))
          : [];

        return {
          id: idx,
          time: toSeconds(finalTimesMs[idx]),
          duration: toSeconds(line.duration),
          text: line.text || '',
          syllabus
        };
      });

      return { structured, text: '' };
    }

    return { structured: null, text: "No se encontraron letras." };
  };

  const getAbsoluteSyllableTime = (line, syllable) => {
    if (!syllable || syllable.time == null) return 0;
    const sTime = Number(syllable.time);
    if (Number.isNaN(sTime)) return 0;
    const lTime = line?.time != null ? Number(line.time) : 0;
    if (Number.isNaN(lTime)) return sTime;
    if (lTime > 0 && sTime < lTime) return sTime + lTime;
    return sTime;
  };

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
        const syllableTime = getAbsoluteSyllableTime(line, line.syllabus[j]);
        if (syllableTime <= timeSeconds) {
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

  React.useEffect(() => {
    if (!lyricsOpen || !preloadedLyrics) return;
    const { structured, text } = normalizeLyricsPayload(preloadedLyrics);
    setLyricsStructured(structured);
    setLyricsContent(text || '');
  }, [lyricsOpen, preloadedLyrics]);

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
      let payload = preloadedLyrics;
      let parsed = normalizeLyricsPayload(payload);

      if (!payload || (!parsed.structured && (!parsed.text || parsed.text === "No se encontraron letras."))) {
        payload = await api.track.getLyrics(currentTrack.title, getArtistName(currentTrack));
        parsed = normalizeLyricsPayload(payload);
      }

      setLyricsStructured(parsed.structured);
      setLyricsContent(parsed.text || '');
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
          background: ${accent};
          box-shadow: 0 0 0 6px rgba(29,185,84,0.18);
          margin-top: -2px; /* center the thumb */
        }
        .yupify-range:focus { box-shadow: 0 0 0 4px rgba(29,185,84,0.18); }
        .yupify-range::-moz-range-track { height:10px; border-radius:999px; }
        .yupify-range::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background: ${accent}; }
        
        .lyrics-container {
          scrollbar-color: ${accent} transparent;
          scrollbar-width: thin;
        }
        .lyrics-container::-webkit-scrollbar {
          width: 8px;
        }
        .lyrics-container::-webkit-scrollbar-track {
          background: transparent;
        }
        .lyrics-container::-webkit-scrollbar-thumb {
          background: ${accent};
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
            className="bg-gray-900 p-8 rounded-2xl max-w-3xl w-full max-h-[85vh] border shadow-2xl flex flex-col"
            style={{ borderColor: 'rgba(29,185,84,0.3)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-2xl font-bold mb-6 text-white">
              🎤 Letras de <span style={{ color: accent }}>{currentTrack.title}</span>
            </h2>

            {lyricsStructured ? (
              <div className="lyrics-container text-gray-100 leading-relaxed space-y-4 flex-1 overflow-y-auto pr-2">
                {lyricsStructured.map((line, li) => {
                  const isActiveLine = li === activeLineIndex;
                  const hasSyllabus = line.syllabus && line.syllabus.length > 0;
                  return (
                    <div
                      key={line.id}
                      ref={(el) => (linesRef.current[li] = el)}
                      className="text-base lg:text-lg py-2 cursor-pointer hover:opacity-80 transition-opacity rounded-md px-2"
                      style={isActiveLine ? { backgroundColor: accentBg } : undefined}
                      onClick={() => {
                        if (Number.isFinite(line.time)) handleSyllableClick(line.time);
                      }}
                    >
                      {hasSyllabus ? (
                        line.syllabus.map((s, si) => {
                          const isSung = li === activeLineIndex && si <= activeSyllableIndex;
                          const syllableTime = getAbsoluteSyllableTime(line, s);
                          const isActiveSyllableLine = li === activeLineIndex;
                          return (
                            <span
                              key={s.id}
                              className={isSung ? 'font-bold text-lg drop-shadow-md' : 'text-gray-500'}
                              style={{
                                transition: 'all 0.08s ease-out',
                                cursor: 'pointer',
                                color: isSung ? accent : (isActiveSyllableLine ? accentSoft : undefined)
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (Number.isFinite(syllableTime)) handleSyllableClick(syllableTime);
                              }}
                            >
                              {s.text}
                            </span>
                          );
                        })
                      ) : (
                        <span style={{ color: isActiveLine ? accent : undefined }} className={isActiveLine ? 'font-bold' : 'text-gray-300'}>
                          {line.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-gray-300 leading-relaxed flex-1 overflow-y-auto">
                {lyricsContent}
              </pre>
            )}

            <button
              onClick={() => setLyricsOpen(false)}
              className="mt-6 w-full py-3 rounded-lg font-semibold transition"
              style={{ backgroundColor: accent }}
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
            <span className="text-xs" style={{ color: accent }}>LOSSLESS</span>
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
                background: `linear-gradient(90deg, ${accent} ${duration ? (currentTime / duration) * 100 : 0}%, rgba(255,255,255,0.06) ${duration ? (currentTime / duration) * 100 : 0}%)`
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
            className="rounded-full p-4 hover:opacity-90"
            style={{ backgroundColor: accent }}
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
