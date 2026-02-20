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
  FileText,
  Download
} from "lucide-react";
import { getArtistName, getTrackDisplayTitle, getCoverUrl } from '../utils/helpers';
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
  onDownload = () => {},
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
  // ----------------------
  // 🔥 LYRICS MODAL
  // ----------------------
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("Cargando...");
  const [lyricsStructured, setLyricsStructured] = useState(null);
  const [lyricsSource, setLyricsSource] = useState('auto');
  const [availableSources, setAvailableSources] = useState({});
  const [checkingSources, setCheckingSources] = useState(false);
  const linesRef = React.useRef([]);
  const [activeLineIndex, setActiveLineIndex] = React.useState(-1);
  const [activeSyllableIndex, setActiveSyllableIndex] = React.useState(-1);
  const [smoothTime, setSmoothTime] = React.useState(0);
  const lyricsRafRef = React.useRef(null);
  const lastAudioTimeRef = React.useRef(0);
  const lastPerfRef = React.useRef(0);
  const lastRateRef = React.useRef(1);
  const lastActiveRef = React.useRef({ line: -1, syll: -1, time: 0 });
  const lyricsSourcesCacheRef = React.useRef(new Map());
  const lyricsSources = React.useMemo(() => ([
    { id: 'auto', label: 'Automático (Apple)' },
    { id: 'apple', label: 'Apple' },
    { id: 'musixmatch', label: 'Musixmatch' },
    { id: 'lyricsplus', label: 'LyricsPlus' },
    { id: 'spotify', label: 'Spotify' },
    { id: 'musixmatch-word', label: 'Musixmatch Word' }
  ]), []);

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
    const pickTime = (obj) => toMs(obj?.time ?? obj?.startTime ?? obj?.begin);
    const pickDuration = (obj) => toMs(obj?.duration ?? obj?.dur ?? obj?.length);

    if (typeof data === 'string') {
      return { structured: null, text: data };
    }

    if (data.lyrics && typeof data.lyrics === 'string') {
      return { structured: null, text: data.lyrics };
    }

    if (data.result && typeof data.result === 'string') {
      return { structured: null, text: data.result };
    }

    const lyricsArray = Array.isArray(data?.lyrics)
      ? data.lyrics
      : (Array.isArray(data?.lines) ? data.lines : []);

    if (lyricsArray && Array.isArray(lyricsArray) && lyricsArray.length > 0) {
      const timesMs = lyricsArray.map(l => pickTime(l));
      const validTimes = timesMs.filter(t => Number.isFinite(t) && t >= 0);
      const hasTiming = validTimes.length >= 2;

      let finalTimesMs = null;
      if (hasTiming) {
        finalTimesMs = timesMs;
      } else {
        const durationsMs = lyricsArray.map(l => pickDuration(l));
        const validDurations = durationsMs.filter(d => Number.isFinite(d) && d >= 0);
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
        const lines = lyricsArray
          .map(l => (l && typeof l.text === 'string' ? l.text.trim() : ''))
          .filter(Boolean);
        return {
          structured: null,
          text: lines.length > 0 ? lines.join('\n') : "No se encontraron letras."
        };
      }

      const structured = lyricsArray.map((line, idx) => {
        const syllabusRaw = Array.isArray(line.syllabus)
          ? line.syllabus
          : (Array.isArray(line.syllables) ? line.syllables : []);
        const validSyllableTimes = syllabusRaw.filter(s => {
          const t = pickTime(s);
          return Number.isFinite(t) && t >= 0;
        });

        const syllabus = validSyllableTimes.length > 0
          ? syllabusRaw.map((s, si) => ({
              id: si,
              time: toSeconds(pickTime(s)),
              duration: toSeconds(pickDuration(s)),
              text: s.text || ''
            }))
          : [];

        const rawDurationMs = pickDuration(line);
        let lineDurationMs = Number.isFinite(rawDurationMs) ? rawDurationMs : null;
        if (!Number.isFinite(lineDurationMs) || lineDurationMs <= 0) {
          const nextStart = finalTimesMs[idx + 1];
          if (Number.isFinite(nextStart)) {
            lineDurationMs = Math.max(0, nextStart - finalTimesMs[idx]);
          }
        }

        return {
          id: idx,
          time: toSeconds(finalTimesMs[idx]),
          duration: Number.isFinite(lineDurationMs) ? toSeconds(lineDurationMs) : toSeconds(pickDuration(line)),
          text: line.text || '',
          syllabus
        };
      });

      return { structured, text: '' };
    }

    return { structured: null, text: "No se encontraron letras." };
  };

  const getLyricsSourceName = (payload) => {
    if (!payload) return '';
    const raw = payload?.raw ?? payload;
    const data = raw?.data ?? raw;
    const meta = data?.metadata ?? raw?.metadata ?? raw?.data?.metadata;
    const source = meta?.source || data?.source || raw?.source;
    return typeof source === 'string' ? source.toLowerCase().trim() : '';
  };

  const isLyricsEmpty = (parsed) => {
    if (parsed?.structured && parsed.structured.length > 0) return false;
    const text = (parsed?.text || '').trim();
    if (!text) return true;
    if (text === "No se encontraron letras.") return true;
    if (text === "No lyrics found.") return true;
    return false;
  };

  const getLyricsKey = React.useCallback(() => {
    if (!currentTrack) return '';
    const baseId = currentTrack.id || currentTrack.trackId || '';
    const title = (currentTrack.title || '').toLowerCase();
    const artist = (getArtistName(currentTrack) || '').toLowerCase();
    return `${baseId}|${title}|${artist}`;
  }, [currentTrack]);

  const getAbsoluteSyllableTime = (line, syllable) => {
    if (!syllable || syllable.time == null) return 0;
    const sTime = Number(syllable.time);
    if (Number.isNaN(sTime)) return 0;
    const lTime = line?.time != null ? Number(line.time) : 0;
    if (Number.isNaN(lTime)) return sTime;
    if (lTime > 0 && sTime < lTime) return sTime + lTime;
    return sTime;
  };

  const getSyllableStarts = React.useCallback((line) => {
    if (!line || !Array.isArray(line.syllabus) || line.syllabus.length === 0) return [];
    if (Array.isArray(line._syllableStarts) && line._syllableStarts.length === line.syllabus.length) {
      return line._syllableStarts;
    }
    const starts = line.syllabus.map(s => getAbsoluteSyllableTime(line, s));
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] < starts[i - 1]) {
        starts[i] = starts[i - 1];
      }
    }
    line._syllableStarts = starts;
    return starts;
  }, []);

  const getSyllableSpan = React.useCallback((line, idx) => {
    if (!line || !Array.isArray(line.syllabus) || line.syllabus.length === 0) return 0;
    const starts = getSyllableStarts(line);
    if (!starts[idx] && starts[idx] !== 0) return 0;
    const start = starts[idx];
    const nextStart = idx + 1 < starts.length
      ? Math.max(starts[idx + 1], start)
      : (Number.isFinite(line.duration) && Number.isFinite(line.time)
          ? Math.max(line.time + line.duration, start)
          : start + (Number.isFinite(line.syllabus[idx]?.duration) ? line.syllabus[idx].duration : 0.1));
    const declared = Number.isFinite(line.syllabus[idx]?.duration) ? line.syllabus[idx].duration : 0;
    const span = Math.max(declared, nextStart - start);
    return Math.max(0.06, span);
  }, [getSyllableStarts]);

  // Función que busca línea activa (última que empezó)
  const findActiveLine = React.useCallback((timeSeconds) => {
    if (!lyricsStructured) return -1;
    let foundLine = -1;
    for (let i = 0; i < lyricsStructured.length; i++) {
      if (lyricsStructured[i].time <= timeSeconds) {
        foundLine = i;
      } else {
        break;
      }
    }
    return foundLine;
  }, [lyricsStructured]);

  React.useEffect(() => {
    if (!lyricsOpen) {
      if (lyricsRafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(lyricsRafRef.current);
      }
      lyricsRafRef.current = null;
      lastPerfRef.current = 0;
      lastAudioTimeRef.current = 0;
      setSmoothTime(currentTime || 0);
      return;
    }

    let active = true;
    const initNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const initAudio = audioRef?.current || document.getElementById('yupify-audio-player');
    const initTime = initAudio && Number.isFinite(initAudio.currentTime) ? initAudio.currentTime : currentTime || 0;
    lastAudioTimeRef.current = Number.isFinite(initTime) ? initTime : 0;
    lastPerfRef.current = initNow;
    lastRateRef.current = initAudio?.playbackRate || 1;
    setSmoothTime(lastAudioTimeRef.current);

    const tick = () => {
      if (!active) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const audioEl = audioRef?.current || document.getElementById('yupify-audio-player');
      const actualTime = audioEl && Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : null;
      const rate = audioEl?.playbackRate || 1;
      const isPaused = audioEl ? audioEl.paused : false;

      if (actualTime != null) {
        if (Math.abs(actualTime - lastAudioTimeRef.current) > 0.015 || lastPerfRef.current === 0) {
          lastAudioTimeRef.current = actualTime;
          lastPerfRef.current = now;
        }
        lastRateRef.current = rate;
      }

      let predicted = lastAudioTimeRef.current + ((now - lastPerfRef.current) / 1000) * (lastRateRef.current || 1);
      if (actualTime != null && Math.abs(predicted - actualTime) > 0.06) {
        lastAudioTimeRef.current = actualTime;
        lastPerfRef.current = now;
        predicted = actualTime;
      }

      const nextTime = Number.isFinite(predicted) ? predicted : 0;
      setSmoothTime((prev) => {
        if (!isPaused && nextTime < prev && (prev - nextTime) < 0.05) {
          return prev;
        }
        return Math.abs(prev - nextTime) < 0.001 ? prev : nextTime;
      });
      lyricsRafRef.current = requestAnimationFrame(tick);
    };

    lyricsRafRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;
      if (lyricsRafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(lyricsRafRef.current);
      }
      lyricsRafRef.current = null;
    };
  }, [lyricsOpen, currentTime, audioRef]);

  // SIMPLE: actualizar sílaba activa cuando currentTime cambia (event listener del audio)
  React.useEffect(() => {
    if (!lyricsStructured) return;

    const leadTime = 0.03;
    const backSeekThreshold = 0.2;
    const advanceEps = 0.01;
    const currentT = smoothTime + leadTime;

    const foundLine = findActiveLine(currentT);
    const last = lastActiveRef.current;

    // Si hubo seek hacia atrás notable, recalcular libremente
    if (currentT < (last.time - backSeekThreshold)) {
      const resetLine = foundLine;
      let resetSyll = -1;
      const resetLineObj = lyricsStructured[resetLine];
      if (resetLineObj?.syllabus?.length) {
        const starts = getSyllableStarts(resetLineObj);
        for (let i = 0; i < starts.length; i++) {
          if (starts[i] <= currentT) resetSyll = i;
          else break;
        }
        if (resetSyll < 0) resetSyll = 0;
      }
      lastActiveRef.current = { line: resetLine, syll: resetSyll, time: currentT };
      setActiveLineIndex(resetLine);
      setActiveSyllableIndex(resetSyll);
      return;
    }

    let nextLine = foundLine;
    let nextSyll = last.syll;

    // Evitar retroceso de línea
    if (nextLine < last.line && last.line >= 0) {
      nextLine = last.line;
    }

    const lineObj = lyricsStructured[nextLine];
    if (lineObj?.syllabus?.length) {
      const starts = getSyllableStarts(lineObj);
      if (nextLine !== last.line || nextSyll < 0 || nextSyll >= starts.length) {
        nextSyll = -1;
        for (let i = 0; i < starts.length; i++) {
          if (starts[i] <= currentT) nextSyll = i;
          else break;
        }
        if (nextSyll < 0) nextSyll = 0;
      } else {
        // Avance monotónico según tiempos de sílaba
        while (nextSyll + 1 < starts.length) {
          const currentStart = starts[nextSyll];
          const nextStart = starts[nextSyll + 1];
          const minHold = Math.min(0.14, Math.max(0.06, getSyllableSpan(lineObj, nextSyll) * 0.55));
          const heldLongEnough = (currentT - currentStart) >= minHold;
          const nextReady = currentT >= (nextStart + advanceEps);
          if (heldLongEnough && nextReady) {
            nextSyll += 1;
            continue;
          }
          break;
        }
      }
    } else {
      nextSyll = -1;
    }

    if (nextLine !== last.line || nextSyll !== last.syll) {
      lastActiveRef.current = { line: nextLine, syll: nextSyll, time: currentT };
    } else {
      lastActiveRef.current.time = currentT;
    }

    setActiveLineIndex(nextLine);
    setActiveSyllableIndex(nextSyll);

    // Scroll al verso activo
    if (nextLine >= 0 && linesRef.current[nextLine]) {
      try {
        linesRef.current[nextLine].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
    }
  }, [smoothTime, lyricsStructured, findActiveLine, getSyllableStarts, getSyllableSpan]);

  const trackTitle = currentTrack?.title || '';
  const trackArtist = currentTrack ? getArtistName(currentTrack) : '';
  const trackKey = React.useMemo(() => getLyricsKey(), [getLyricsKey]);

  React.useEffect(() => {
    if (!trackKey) return;
    setLyricsSource('auto');
    setAvailableSources({});
    setCheckingSources(false);
    setLyricsStructured(null);
    setLyricsContent("Cargando...");
  }, [trackKey]);

  React.useEffect(() => {
    if (!lyricsOpen || !currentTrack) return;
    const cacheKey = trackKey;
    if (!cacheKey) return;

    const cached = lyricsSourcesCacheRef.current.get(cacheKey);
    if (cached) {
      setAvailableSources(cached);
      setCheckingSources(false);
      return;
    }

    let cancelled = false;
    setCheckingSources(true);

    const run = async () => {
      const results = {};
      for (const source of lyricsSources) {
        if (source.id === 'auto') continue;
        try {
          const payload = await api.track.getLyrics(trackTitle, trackArtist, { sourceOnly: source.id });
          const parsed = normalizeLyricsPayload(payload);
          results[source.id] = !isLyricsEmpty(parsed);
        } catch (e) {
          results[source.id] = false;
        }
        if (cancelled) return;
      }

      if (!cancelled) {
        lyricsSourcesCacheRef.current.set(cacheKey, results);
        setAvailableSources(results);
        setCheckingSources(false);
      }
    };

    run();

    return () => {
      cancelled = true;
      setCheckingSources(false);
    };
  }, [lyricsOpen, trackKey, trackTitle, trackArtist, lyricsSources]);

  React.useEffect(() => {
    if (!lyricsOpen || !currentTrack) return;
    let cancelled = false;

    const load = async () => {
      setLyricsContent("Cargando letras...");
      setLyricsStructured(null);

      try {
        let payload = null;
        let parsed = null;
        if (lyricsSource === 'auto') {
          payload = preloadedLyrics;
          parsed = normalizeLyricsPayload(payload);
          const sourceName = getLyricsSourceName(payload);
          const fromApple = sourceName.includes('apple');
          if (!payload || isLyricsEmpty(parsed) || !fromApple) {
            payload = await api.track.getLyrics(trackTitle, trackArtist, { sourceOnly: 'apple' });
            parsed = normalizeLyricsPayload(payload);
          }
        } else {
          payload = await api.track.getLyrics(trackTitle, trackArtist, { sourceOnly: lyricsSource });
          parsed = normalizeLyricsPayload(payload);
        }

        if (cancelled) return;
        setLyricsStructured(parsed.structured);
        setLyricsContent(parsed.text || '');
      } catch (err) {
        if (!cancelled) setLyricsContent("Error al obtener letras.");
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [lyricsOpen, lyricsSource, trackKey, trackTitle, trackArtist, preloadedLyrics]);

  // Click handler para seek a una sílaba
  const handleSyllableClick = React.useCallback((syllableTime) => {
    const audio = document.getElementById('yupify-audio-player');
    if (audio) {
      audio.currentTime = syllableTime;
      audio.play();
    }
  }, []);

  const openLyrics = () => {
    if (!currentTrack) return;
    setLyricsOpen(true);
    setLyricsContent("Cargando letras...");
    setLyricsStructured(null);
  };

  // ----------------------
  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  if (!currentTrack) return null;

  const fallbackCover = 'https://resources.tidal.com/images/ddd75a35/5b2d/409c/abe3/7368b34f02f0/1280x1280.jpg';
  const tidalCover = getCoverUrl(currentTrack, 1280) || fallbackCover;
  const displayTitle = getTrackDisplayTitle(currentTrack);
  const availableSourceLabels = lyricsSources
    .filter((source) => source.id !== 'auto' && availableSources[source.id])
    .map((source) => source.label);
  const sourcesStatusText = checkingSources
    ? 'Verificando fuentes...'
    : (Object.keys(availableSources).length === 0
        ? 'Fuentes sin verificar'
        : (availableSourceLabels.length > 0
            ? `Disponibles: ${availableSourceLabels.join(', ')}`
            : 'No hay fuentes disponibles'));

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

        .lyrics-modal {
          position: relative;
          width: min(1100px, 100%);
          height: min(86vh, 860px);
          border-radius: 26px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.08);
          background: #0b0b0b;
          box-shadow: 0 30px 80px rgba(0,0,0,0.55);
        }

        .lyrics-backdrop {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center;
          filter: blur(36px) saturate(1.2);
          opacity: 0.25;
          transform: scale(1.1);
        }

        .lyrics-scrim {
          position: absolute;
          inset: 0;
          background: linear-gradient(140deg, rgba(6,6,6,0.88), rgba(6,6,6,0.7) 45%, rgba(6,6,6,0.85));
          z-index: 1;
        }

        .lyrics-content {
          position: relative;
          z-index: 2;
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 28px;
          gap: 20px;
        }

        .lyrics-panel {
          flex: 1;
          display: grid;
          grid-template-columns: minmax(240px, 0.9fr) minmax(0, 1.4fr);
          gap: 28px;
          min-height: 0;
        }

        .lyrics-left {
          display: flex;
          flex-direction: column;
          gap: 18px;
          align-self: flex-start;
        }

        .lyrics-art {
          width: 100%;
          max-width: 360px;
          aspect-ratio: 1 / 1;
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 20px 50px rgba(0,0,0,0.4);
          border: 1px solid rgba(255,255,255,0.08);
        }

        .lyrics-art img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .lyrics-meta {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .lyrics-badge {
          font-size: 11px;
          letter-spacing: 0.32em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.6);
        }

        .lyrics-title {
          font-size: 28px;
          font-weight: 700;
          color: #fff;
          line-height: 1.2;
        }

        .lyrics-artist {
          font-size: 15px;
          color: rgba(255,255,255,0.68);
        }

        .lyrics-source {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .lyrics-source label {
          font-size: 10px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.5);
        }

        .lyrics-source select {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.18);
          color: #fff;
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 12px;
          outline: none;
          appearance: none;
          -webkit-appearance: none;
          color-scheme: dark;
        }

        .lyrics-source select:focus {
          border-color: rgba(29, 185, 84, 0.6);
          box-shadow: 0 0 0 3px rgba(29, 185, 84, 0.2);
        }

        .lyrics-source small {
          font-size: 11px;
          color: rgba(255,255,255,0.5);
        }

        .lyrics-source select option {
          background: #0b0b0b;
          color: #fff;
        }

        .lyrics-right {
          min-height: 0;
          display: flex;
          flex-direction: column;
        }

        .lyrics-scroll {
          flex: 1;
          overflow-y: auto;
          padding-right: 12px;
          min-height: 0;
        }

        .lyrics-lines {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .lyrics-line {
          font-size: 20px;
          line-height: 1.4;
          color: rgba(255,255,255,0.4);
          transition: color 0.2s ease, font-size 0.2s ease, transform 0.2s ease, text-shadow 0.2s ease;
          cursor: pointer;
          padding: 6px 10px;
          border-radius: 14px;
          position: relative;
        }

        .lyrics-line.is-active {
          color: #fff;
          font-size: 26px;
          background: linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
          text-shadow: 0 0 18px rgba(255,255,255,0.25);
          backdrop-filter: blur(10px);
          transform: translateY(-1px);
        }

        .lyrics-line.is-active::before {
          content: '';
          position: absolute;
          inset: -8px;
          background: radial-gradient(60% 70% at 15% 50%, rgba(255,255,255,0.12), transparent 70%);
          filter: blur(18px);
          opacity: 0.75;
          z-index: -1;
        }

        .lyrics-syllable {
          display: inline-block;
          margin-right: 4px;
          padding: 0 1px;
          transition: color 0.22s ease, text-shadow 0.26s ease;
          color: rgba(255,255,255,0.35);
          background-repeat: no-repeat;
          background-size: 100% 100%;
          background-position: 0 50%;
          -webkit-text-fill-color: currentColor;
          will-change: color, text-shadow;
        }

        .lyrics-syllable.is-sung {
          color: rgba(29, 185, 84, 0.85);
          text-shadow: 0 0 10px rgba(29, 185, 84, 0.35);
        }

        .lyrics-syllable.is-current {
          color: #1db954;
          text-shadow: 0 0 10px rgba(29, 185, 84, 0.45);
        }

        .lyrics-actions {
          position: absolute;
          top: 22px;
          right: 22px;
          z-index: 3;
          display: flex;
          justify-content: flex-end;
        }

        .lyrics-close {
          padding: 10px 16px;
          border-radius: 999px;
          font-weight: 600;
          background: rgba(18,18,18,0.72);
          border: 1px solid rgba(255,255,255,0.12);
          color: #fff;
          font-size: 12px;
          letter-spacing: 0.02em;
          box-shadow: 0 10px 24px rgba(0,0,0,0.35);
          transition: background 0.2s ease;
        }

        .lyrics-close:hover {
          background: rgba(255,255,255,0.18);
        }

        @media (max-width: 900px) {
          .lyrics-panel {
            grid-template-columns: 1fr;
          }

          .lyrics-left {
            flex-direction: row;
            align-items: center;
          }

          .lyrics-art {
            width: 90px;
            height: 90px;
            max-width: 90px;
          }

          .lyrics-title {
            font-size: 20px;
          }

          .lyrics-line {
            font-size: 18px;
          }

          .lyrics-line.is-active {
            font-size: 22px;
          }

          .lyrics-actions {
            top: 14px;
            right: 14px;
          }
        }
      `}</style>
      {/* 🎤 Modal de Letras */}
      {lyricsOpen && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex justify-center items-center p-4 backdrop-blur-sm"
          onClick={() => setLyricsOpen(false)}
        >
          <div
            className="lyrics-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lyrics-backdrop" style={{ backgroundImage: `url(${tidalCover})` }} />
            <div className="lyrics-scrim" />
            <div className="lyrics-content">
              <div className="lyrics-panel">
                <div className="lyrics-left">
                  <div className="lyrics-art">
                    <img src={tidalCover} alt={displayTitle} />
                  </div>
                  <div className="lyrics-meta">
                    <span className="lyrics-badge">Lyrics</span>
                    <h2 className="lyrics-title">{displayTitle}</h2>
                    <p className="lyrics-artist">{getArtistName(currentTrack)}</p>
                    <div className="lyrics-source">
                      <label>Fuente</label>
                      <select
                        value={lyricsSource}
                        onChange={(e) => setLyricsSource(e.target.value)}
                      >
                        {lyricsSources.map((source) => {
                          const isAvailable = source.id === 'auto' ? true : availableSources[source.id];
                          const isDisabled = source.id !== 'auto' && (checkingSources ? isAvailable !== true : isAvailable === false);
                          const statusLabel = source.id === 'auto'
                            ? source.label
                            : (isAvailable === true
                                ? source.label
                                : (checkingSources && isAvailable == null
                                    ? `${source.label} (verificando...)`
                                    : `${source.label} (no disponible)`));
                          return (
                            <option key={source.id} value={source.id} disabled={isDisabled}>
                              {statusLabel}
                            </option>
                          );
                        })}
                      </select>
                      <small>{sourcesStatusText}</small>
                    </div>
                  </div>
                </div>

                <div className="lyrics-right">
                  <div className="lyrics-scroll lyrics-container">
                    {lyricsStructured ? (
                      <div className="lyrics-lines">
                        {lyricsStructured.map((line, li) => {
                          const isActiveLine = li === activeLineIndex;
                          const hasSyllabus = line.syllabus && line.syllabus.length > 0;
                          const renderTime = smoothTime + 0.02;
                          return (
                            <div
                              key={line.id}
                              ref={(el) => (linesRef.current[li] = el)}
                              className={`lyrics-line ${isActiveLine ? 'is-active' : ''}`}
                              onClick={() => {
                                if (Number.isFinite(line.time)) handleSyllableClick(line.time);
                              }}
                            >
                              {hasSyllabus ? (
                                line.syllabus.map((s, si) => {
                                  const isActive = isActiveLine;
                                  const syllableTime = getAbsoluteSyllableTime(line, s);
                                  const syllableDuration = getSyllableSpan(line, si);
                                  const effectiveDuration = Math.max(syllableDuration, 0.08);
                                  const rawProgress = effectiveDuration > 0
                                    ? (renderTime - syllableTime) / effectiveDuration
                                    : 0;
                                  const progress = isActive ? Math.max(0, Math.min(1, rawProgress)) : 0;
                                  const eased = progress * progress * (3 - 2 * progress);
                                  const alpha = 0.4 + (0.35 * eased);
                                  const glow = 0.08 + (0.28 * eased);
                                  const percent = Math.round(eased * 100);
                                  const show = progress > 0.02;
                                  const activeStyle = show
                                    ? {
                                        backgroundImage: `linear-gradient(90deg, rgba(29, 185, 84, ${alpha}) ${percent}%, rgba(255,255,255,0.24) ${percent}%)`,
                                        WebkitBackgroundClip: 'text',
                                        backgroundClip: 'text',
                                        color: 'transparent',
                                        WebkitTextFillColor: 'transparent',
                                        textShadow: `0 0 ${Math.round(4 + 8 * eased)}px rgba(29, 185, 84, ${glow})`
                                      }
                                    : undefined;
                                  return (
                                    <span
                                      key={s.id}
                                      className="lyrics-syllable"
                                      style={activeStyle}
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
                                <span>{line.text}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap text-gray-300 leading-relaxed">
                        {lyricsContent}
                      </pre>
                    )}
                  </div>
                </div>
              </div>

              <div className="lyrics-actions">
                <button
                  onClick={() => setLyricsOpen(false)}
                  className="lyrics-close"
                >
                  Cerrar
                </button>
              </div>
            </div>
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
        <div className="flex items-center gap-3 px-3 sm:px-4 pt-3 flex-wrap">
          <img
            src={tidalCover}
            alt={displayTitle || currentTrack.title}
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg shadow-lg"
            onError={(e) => (e.target.src = fallbackCover)}
          />

          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate">{displayTitle}</h3>
            <p className="text-sm text-gray-400 truncate">
              {getArtistName(currentTrack)}
            </p>
            <span className="text-xs" style={{ color: accent }}>LOSSLESS</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 ml-auto w-full sm:w-auto justify-end">
            <button onClick={onToggleFavorite}>
              <Heart
                className={
                  isFavorite
                    ? "fill-red-500 text-red-500 w-5 h-5 sm:w-6 sm:h-6"
                    : "text-gray-400 hover:text-white w-5 h-5 sm:w-6 sm:h-6"
                }
              />
            </button>

            <button onClick={() => onDownload(currentTrack)}>
              <Download className="text-gray-400 hover:text-white w-5 h-5 sm:w-6 sm:h-6" />
            </button>

            <button onClick={openLyrics}>
              <FileText className="text-gray-400 hover:text-white w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
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
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 px-3 sm:px-4 pb-4">
          <div className="flex items-center justify-center gap-3 sm:gap-4 w-full sm:w-auto">
            <button onClick={onToggleShuffle}>
              <Shuffle className={isShuffle ? "text-green-500 w-5 h-5 sm:w-6 sm:h-6" : "text-gray-400 w-5 h-5 sm:w-6 sm:h-6"} />
            </button>

            <button onClick={onSkipPrevious}>
              <SkipBack className="text-gray-400 w-7 h-7 sm:w-8 sm:h-8" />
            </button>

            <button
              onClick={onTogglePlay}
              className="rounded-full p-3 sm:p-4 hover:opacity-90"
              style={{ backgroundColor: accent }}
            >
              {isPlaying ? <Pause className="w-6 h-6 sm:w-7 sm:h-7" /> : <Play className="w-6 h-6 sm:w-7 sm:h-7" />}
            </button>

            <button onClick={onSkipNext}>
              <SkipForward className="text-gray-400 w-7 h-7 sm:w-8 sm:h-8" />
            </button>

            <button onClick={onToggleRepeat}>
              <Repeat className={isRepeat ? "text-green-500 w-5 h-5 sm:w-6 sm:h-6" : "text-gray-400 w-5 h-5 sm:w-6 sm:h-6"} />
            </button>
          </div>

          <div className="flex items-center gap-2 sm:ml-4 w-full sm:w-auto justify-center sm:justify-start">
            <button onClick={onToggleMute}>
              {isMuted ? <VolumeX className="w-5 h-5 sm:w-6 sm:h-6" /> : <Volume2 className="w-5 h-5 sm:w-6 sm:h-6" />}
            </button>

            <input
              type="range"
              min="0"
              max="100"
              value={isMuted ? 0 : volume * 100}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="yupify-range w-24 sm:w-32"
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
