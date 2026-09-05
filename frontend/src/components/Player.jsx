import React, { useState } from "react";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  Heart,
  Repeat,
  Shuffle,
  FileText,
  Download,
  Minus,
  Plus,
  RotateCcw
} from "lucide-react";
import { getArtistName, getTrackDisplayTitle, getCoverUrl, getTrackQualityValue, formatQualityLabel } from '../utils/helpers';
import api from '../services/api';

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const Player = ({
  currentTrack = null,
  streamUrl: _streamUrl = "",
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
  onTimeUpdate: _onTimeUpdate = () => {},
  onEnded: _onEnded = () => {},

  // 🔥 AGREGAR ESTO
  quality = "LOSSLESS",
  onChangeQuality = () => {},
  preloadedLyrics = null
}) => {
  const accent = '#1db954';
  const getStoredPlaybackRate = () => {
    if (typeof window === 'undefined') return 1;
    const raw = window.localStorage.getItem('playbackRate');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  };
  const [playbackRate, setPlaybackRate] = useState(getStoredPlaybackRate);
  const playbackRateLabel = Number.isFinite(playbackRate)
    ? String(playbackRate).replace(/\.0$/, '')
    : '1';
  const cyclePlaybackRate = React.useCallback(() => {
    setPlaybackRate((prev) => {
      const index = PLAYBACK_RATES.indexOf(prev);
      const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
      return Number.isFinite(next) ? next : 1;
    });
  }, []);
  // ----------------------
  // 🔥 LYRICS MODAL
  // ----------------------
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("Cargando...");
  const [lyricsError, setLyricsError] = useState('');
  const [lyricsReload, setLyricsReload] = useState(0);
  const [lyricsStructured, setLyricsStructured] = useState(null);
  const [lyricsSource, setLyricsSource] = useState('auto');
  const [lyricsOffset, setLyricsOffset] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const saved = Number(window.localStorage.getItem('lyricsOffset'));
    return Number.isFinite(saved) ? Math.max(-10, Math.min(10, saved)) : 0;
  });
  const [availableSources, setAvailableSources] = useState({});
  const [checkingSources, setCheckingSources] = useState(false);
  const linesRef = React.useRef([]);
  const combinedLyricsCacheRef = React.useRef(new Map());
  const [, setActiveLineIndex] = React.useState(-1);
  const lyricsRafRef = React.useRef(null);
  const lastAudioTimeRef = React.useRef(0);
  const lastPerfRef = React.useRef(0);
  const lastRateRef = React.useRef(1);
  const lastActiveRef = React.useRef({ line: -1, syll: -1, time: 0 });
  const smoothTimeRef = React.useRef(0);
  const syllabiRef = React.useRef([]);
  const activeLineElRef = React.useRef(null);
  const activeSyllElRef = React.useRef(null);
  const lyricScrollRef = React.useRef(null);
  const lyricsSourcesCacheRef = React.useRef(new Map());
  const lyricsSources = React.useMemo(() => ([
    { id: 'auto', label: 'Automático' },
    { id: 'apple', label: 'Apple' },
    { id: 'musixmatch', label: 'Musixmatch' },
    { id: 'lyricsplus', label: 'LyricsPlus' },
    { id: 'spotify', label: 'Spotify' },
    { id: 'musixmatch-word', label: 'Musixmatch Word' },
    { id: 'binimum-isrc', label: 'Binimum' }
  ]), []);

  const getCombinedSources = React.useCallback((payload) => {
    const raw = payload?.raw ?? payload;
    if (raw && typeof raw === 'object' && raw._sources && typeof raw._sources === 'object') {
      return raw._sources;
    }
    return null;
  }, []);

  const getSourcePayload = React.useCallback((sources, sourceId) => {
    if (!sources || typeof sources !== 'object') return null;
    if (sources[sourceId]) return sources[sourceId];
    const aliases = {
      'musixmatch-word': ['musixmatch_word', 'musixmatch-word', 'musixmatch'],
      'binimum-isrc': ['binimum', 'binimum_isrc', 'binimum-isrc'],
      lyricsplus: ['lyrics', 'lyrics-plus', 'lyricsplus']
    };
    const match = (aliases[sourceId] || []).find((key) => sources[key]);
    return match ? sources[match] : null;
  }, []);

  const buildAvailability = React.useCallback((payload) => {
    const results = {};
    const sources = getCombinedSources(payload);
    lyricsSources.forEach((source) => {
      if (source.id === 'auto') return;
      if (sources) {
        results[source.id] = Boolean(getSourcePayload(sources, source.id));
        return;
      }
      const sourceName = getLyricsSourceName(payload);
      results[source.id] = sourceName === source.id;
    });
    return results;
  }, [getCombinedSources, getSourcePayload, lyricsSources]);

  const toNumber = (t) => {
    if (t == null) return null;
    const num = Number(t);
    if (!Number.isFinite(num)) return null;
    return num;
  };

  const normalizeLyricsPayload = (payload) => {
    const raw = payload?.raw ?? payload;
    if (!raw) return { structured: null, text: "No se encontraron letras." };
    const data = raw?.data ?? raw;

    const pickTimeRaw = (obj) => toNumber(obj?.time ?? obj?.startTime ?? obj?.begin);
    const pickDurationRaw = (obj) => toNumber(obj?.duration ?? obj?.dur ?? obj?.length);

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
      const inferUnit = (lines) => {
        const values = [];
        lines.forEach((line) => {
          const t = pickTimeRaw(line);
          if (Number.isFinite(t)) values.push(t);
          const d = pickDurationRaw(line);
          if (Number.isFinite(t) && Number.isFinite(d)) values.push(t + d);
          const syllables = Array.isArray(line?.syllabus)
            ? line.syllabus
            : (Array.isArray(line?.syllables) ? line.syllables : []);
          syllables.forEach((s) => {
            const st = pickTimeRaw(s);
            if (Number.isFinite(st)) values.push(st);
            const sd = pickDurationRaw(s);
            if (Number.isFinite(st) && Number.isFinite(sd)) values.push(st + sd);
          });
        });

        const max = values.length > 0 ? Math.max(...values) : 0;
        if (!Number.isFinite(max) || max <= 0) return 'ms';
        if (max > 10000) return 'ms';
        if (Number.isFinite(duration) && duration > 0) {
          if (max <= duration * 3) return 's';
          if (max >= duration * 100) return 'ms';
        }
        return max < 1000 ? 's' : 'ms';
      };

      const timeUnit = inferUnit(lyricsArray);
      const toMs = (value) => {
        const num = toNumber(value);
        if (!Number.isFinite(num)) return 0;
        return timeUnit === 's' ? num * 1000 : num;
      };
      const toSeconds = (value) => toMs(value) / 1000;
      const pickTime = (obj) => toMs(pickTimeRaw(obj));
      const pickDuration = (obj) => toMs(pickDurationRaw(obj));

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

        let syllabus = validSyllableTimes.length > 0
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

        if (syllabus.length === 0 && typeof line.text === 'string') {
          const words = line.text.trim().split(/\s+/).filter(Boolean);
          const lineDurationSeconds = toSeconds(lineDurationMs);
          const totalWeight = words.reduce((sum, word) => sum + Math.max(1, word.length), 0);
          let elapsed = 0;
          syllabus = words.map((word, wordIndex) => {
            const wordDuration = totalWeight > 0
              ? lineDurationSeconds * (Math.max(1, word.length) / totalWeight)
              : 0;
            const wordTime = toSeconds(finalTimesMs[idx]) + elapsed;
            elapsed += wordDuration;
            return {
              id: wordIndex,
              time: wordTime,
              duration: wordDuration,
              text: word
            };
          });
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
    const version = typeof currentTrack.version === 'string' ? currentTrack.version.trim().toLowerCase() : '';
    const artist = (getArtistName(currentTrack) || '').toLowerCase();
    return `${baseId}|${title}|${version}|${artist}`;
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

  // Índice plano de sílabas (ordenado por tiempo) + refs DOM, precalculado una vez por canción.
  // Permite encontrar la sílaba activa con búsqueda binaria y animar solo UN nodo por frame.
  React.useEffect(() => {
    const list = [];
    const struct = lyricsStructured;
    if (Array.isArray(struct)) {
      for (let li = 0; li < struct.length; li++) {
        const line = struct[li];
        if (!line) continue;
        if (Array.isArray(line.syllabus) && line.syllabus.length > 0) {
          const starts = getSyllableStarts(line);
          for (let si = 0; si < line.syllabus.length; si++) {
            list.push({
              li,
              si,
              start: starts[si],
              dur: Math.max(getSyllableSpan(line, si), 0.08)
            });
          }
        } else if (Number.isFinite(line.time)) {
          const dur = Number.isFinite(line.duration) && line.duration > 0 ? line.duration : 2.5;
          list.push({ li, si: -1, start: line.time, dur });
        }
      }
      list.sort((a, b) => a.start - b.start);
    }
    syllabiRef.current = list;
    lastActiveRef.current = { line: -1, syll: -1, time: 0 };
    if (activeSyllElRef.current) {
      activeSyllElRef.current.classList.remove('is-current');
    }
    if (activeLineElRef.current) {
      activeLineElRef.current.classList.remove('is-active');
    }
    activeSyllElRef.current = null;
    activeLineElRef.current = null;
    if (linesRef.current) linesRef.current.length = struct?.length || 0;
  }, [lyricsStructured, getSyllableStarts, getSyllableSpan]);

  // Actualización visual en un único rAF: SOLO escribe en el DOM (nada de setState por frame).
  // El line/word accesible se publica en React únicamente cuando cambia.
  React.useEffect(() => {
    if (!lyricsOpen) {
      if (lyricsRafRef.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(lyricsRafRef.current);
      }
      lyricsRafRef.current = null;
      lastPerfRef.current = 0;
      lastAudioTimeRef.current = 0;
      return;
    }

    let active = true;
    const initNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const initAudio = audioRef?.current || document.getElementById('yupify-audio-player');
    const initTime = initAudio && Number.isFinite(initAudio.currentTime) ? initAudio.currentTime : (currentTime || 0);
    lastAudioTimeRef.current = Number.isFinite(initTime) ? initTime : 0;
    lastPerfRef.current = initNow;
    lastRateRef.current = initAudio?.playbackRate || 1;

    const findIdx = (t) => {
      const arr = syllabiRef.current;
      let lo = 0;
      let hi = arr.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].start <= t) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    };

    const scrollToLine = (lineEl) => {
      const container = lyricScrollRef.current;
      if (!container || !lineEl) return;
      try {
        const rect = lineEl.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const target = container.scrollTop + (rect.top - cRect.top) - container.clientHeight / 2 + rect.height / 2;
        container.scrollTop = Math.max(0, Math.round(target));
      } catch (e) { /* ignorar */ }
    };

    const clearLineWords = (lineEl) => {
      if (!lineEl?.children) return;
      Array.from(lineEl.children).forEach((wordEl) => {
        wordEl.classList.remove('is-current', 'is-sung');
      });
    };

    const tick = () => {
      if (!active) {
        return;
      }
      const audioEl = audioRef?.current || document.getElementById('yupify-audio-player');
      const actualTime = audioEl && Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : null;
      const t = actualTime != null
        ? actualTime
        : (Number.isFinite(currentTime) ? currentTime : 0);
      const syncedTime = Math.max(0, t + lyricsOffset);
      lastAudioTimeRef.current = syncedTime;
      smoothTimeRef.current = syncedTime;

      const arr = syllabiRef.current;
      const idx = arr.length > 0 ? findIdx(syncedTime) : -1;

      const entry = idx >= 0 ? arr[idx] : null;
      const last = lastActiveRef.current;

      if (syncedTime < last.time - 0.05 && activeLineElRef.current) {
        clearLineWords(activeLineElRef.current);
        activeSyllElRef.current = null;
      }

      if (entry) {
        const lineEl = Array.isArray(linesRef.current) ? (linesRef.current[entry.li] || null) : null;
        const syllEl = (entry.si >= 0 && lineEl && lineEl.children)
          ? (lineEl.children[entry.si] || null)
          : null;

        const lineChanged = lineEl !== activeLineElRef.current;
        if (lineChanged && activeLineElRef.current) {
          clearLineWords(activeLineElRef.current);
        }

        if (lineChanged) {
          if (activeLineElRef.current && activeLineElRef.current.classList) {
            activeLineElRef.current.classList.remove('is-active');
          }
          if (lineEl && lineEl.classList) {
            lineEl.classList.add('is-active');
          }
          activeLineElRef.current = lineEl || null;
        }

        if (entry.li !== last.line) {
          setActiveLineIndex(entry.li);
          if (lineEl) scrollToLine(lineEl);
        }

        if (syllEl !== activeSyllElRef.current) {
          if (activeSyllElRef.current && activeSyllElRef.current !== syllEl && activeSyllElRef.current.classList) {
            activeSyllElRef.current.classList.remove('is-current');
            if (!lineChanged) activeSyllElRef.current.classList.add('is-sung');
          }
          if (syllEl && syllEl.classList) {
            syllEl.classList.remove('is-sung');
            syllEl.classList.add('is-current');
          }
          activeSyllElRef.current = syllEl || null;
        }

      } else if (last.line !== -1) {
        if (activeLineElRef.current && activeLineElRef.current.classList) {
          activeLineElRef.current.classList.remove('is-active');
        }
        activeLineElRef.current = null;
        if (activeSyllElRef.current && activeSyllElRef.current.classList) {
          activeSyllElRef.current.classList.remove('is-current');
          activeSyllElRef.current.classList.remove('is-sung');
        }
        activeSyllElRef.current = null;
      }

      lastActiveRef.current = {
        line: entry ? entry.li : -1,
        syll: entry && entry.si !== null ? entry.si : -1,
        time: syncedTime
      };

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
  }, [lyricsOpen, audioRef, lyricsOffset]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem('lyricsOffset', String(lyricsOffset));
    } catch {}
  }, [lyricsOffset]);

  const trackTitle = currentTrack?.title || '';
  const trackArtist = currentTrack ? getArtistName(currentTrack) : '';
  const trackVersion = typeof currentTrack?.version === 'string' ? currentTrack.version.trim() : '';
  const trackKey = React.useMemo(() => getLyricsKey(), [getLyricsKey]);
  const playbackQuality = formatQualityLabel(getTrackQualityValue(currentTrack, quality), quality);

  React.useEffect(() => {
    if (!trackKey) return;
    setLyricsSource('auto');
    setAvailableSources({});
    setCheckingSources(false);
    setLyricsStructured(null);
    setLyricsError('');
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
      try {
        const preloaded = preloadedLyrics;
        const preloadedRaw = preloaded?.raw ?? preloaded;
        let payload = preloadedRaw;
        if (!payload) {
          payload = await api.track.getLyrics(trackTitle, trackArtist, {
            id: currentTrack?.id ?? currentTrack?.trackId,
            isrc: currentTrack?.isrc || currentTrack?.externalIds?.isrc,
            version: trackVersion,
            album: currentTrack?.album?.title || currentTrack?.albumTitle,
            duration: currentTrack?.duration
          });
        }

        if (cancelled) return;
        const results = buildAvailability(payload);
        lyricsSourcesCacheRef.current.set(cacheKey, results);
        combinedLyricsCacheRef.current.set(cacheKey, payload?.raw ?? payload);
        setAvailableSources(results);
        setCheckingSources(false);
      } catch (e) {
        if (cancelled) return;
        const fallback = {};
        lyricsSources.forEach((source) => {
          if (source.id !== 'auto') fallback[source.id] = false;
        });
        lyricsSourcesCacheRef.current.set(cacheKey, fallback);
        setAvailableSources(fallback);
        setCheckingSources(false);
      }
    };

    run();

    return () => {
      cancelled = true;
      setCheckingSources(false);
    };
  }, [lyricsOpen, trackKey, trackTitle, trackArtist, lyricsSources, preloadedLyrics, buildAvailability]);

  React.useEffect(() => {
    if (!lyricsOpen || !currentTrack) return;
    let cancelled = false;

    const load = async () => {
      setLyricsContent("Cargando letras...");
      setLyricsStructured(null);

      try {
        let payload = null;
        let parsed = null;

        const cachedCombined = combinedLyricsCacheRef.current.get(trackKey);
        const combinedSources = getCombinedSources(cachedCombined || preloadedLyrics);

        if (lyricsSource === 'auto') {
          if (combinedSources) {
            const preferredCombinedSource = lyricsSources.find((source) => {
              if (source.id === 'auto') return false;
              if (source.id === 'musixmatch-word') {
                return Boolean(combinedSources[source.id] || combinedSources.musixmatch);
              }
              return Boolean(combinedSources[source.id]);
            });
            if (preferredCombinedSource) payload = getSourcePayload(combinedSources, preferredCombinedSource.id);
          }
          if (!payload) payload = cachedCombined || preloadedLyrics;
          parsed = normalizeLyricsPayload(payload);
          if (!payload || isLyricsEmpty(parsed)) {
            payload = await api.track.getLyrics(trackTitle, trackArtist, {
              id: currentTrack?.id ?? currentTrack?.trackId,
              isrc: currentTrack?.isrc || currentTrack?.externalIds?.isrc,
              version: trackVersion,
              album: currentTrack?.album?.title || currentTrack?.albumTitle,
              duration: currentTrack?.duration
            });
            combinedLyricsCacheRef.current.set(trackKey, payload?.raw ?? payload);
            parsed = normalizeLyricsPayload(payload);
          }
        } else if (combinedSources) {
          const selected = getSourcePayload(combinedSources, lyricsSource);
          if (selected) {
            payload = selected;
            parsed = normalizeLyricsPayload(payload);
          } else {
            payload = await api.track.getLyrics(trackTitle, trackArtist, {
              id: currentTrack?.id ?? currentTrack?.trackId,
              isrc: currentTrack?.isrc || currentTrack?.externalIds?.isrc,
              sourceOnly: lyricsSource,
              version: trackVersion,
              album: currentTrack?.album?.title || currentTrack?.albumTitle,
              duration: currentTrack?.duration
            });
            parsed = normalizeLyricsPayload(payload);
          }
        } else {
          payload = await api.track.getLyrics(trackTitle, trackArtist, {
            id: currentTrack?.id ?? currentTrack?.trackId,
            isrc: currentTrack?.isrc || currentTrack?.externalIds?.isrc,
            sourceOnly: lyricsSource,
            version: trackVersion,
            album: currentTrack?.album?.title || currentTrack?.albumTitle,
            duration: currentTrack?.duration
          });
          parsed = normalizeLyricsPayload(payload);
        }

        if (cancelled) return;
        if (isLyricsEmpty(parsed)) {
          setLyricsError('No encontramos letras para esta canción.');
          setLyricsContent('');
        } else {
          setLyricsError('');
        }
        setLyricsStructured(parsed.structured);
        setLyricsContent(parsed.text || '');
      } catch (err) {
        if (!cancelled) {
          setLyricsError('No se pudieron cargar las letras.');
          setLyricsContent('');
          setLyricsStructured(null);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [lyricsOpen, lyricsSource, lyricsReload, trackKey, trackTitle, trackArtist, preloadedLyrics, getSourcePayload]);

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
    setLyricsError('');
    setLyricsContent("Cargando letras...");
    setLyricsStructured(null);
  };

  const retryLyrics = () => {
    if (trackKey) {
      combinedLyricsCacheRef.current.delete(trackKey);
      lyricsSourcesCacheRef.current.delete(trackKey);
    }
    setLyricsError('');
    setLyricsContent('Cargando letras...');
    setLyricsStructured(null);
    setLyricsSource('auto');
    setLyricsReload((value) => value + 1);
  };

  // ----------------------
  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  React.useEffect(() => {
    if (!Number.isFinite(playbackRate)) return;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('playbackRate', String(playbackRate));
      }
    } catch {}
    const audio = audioRef?.current || document.getElementById('yupify-audio-player');
    if (audio && Math.abs((audio.playbackRate || 1) - playbackRate) > 0.001) {
      audio.playbackRate = playbackRate;
    }
  }, [playbackRate, audioRef]);

  if (!currentTrack) return null;

  const tidalCover = getCoverUrl(currentTrack, 640);
  const displayTitle = getTrackDisplayTitle(currentTrack);
  const titleText = displayTitle || currentTrack.title || 'Reproduciendo';
  const artistText = getArtistName(currentTrack);
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
          background:
            radial-gradient(circle at 12% 18%, rgba(29,185,84,0.2), transparent 34%),
            radial-gradient(circle at 88% 82%, rgba(38,132,255,0.16), transparent 38%),
            linear-gradient(135deg, #101a17 0%, #0c1014 48%, #11100d 100%);
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
          background:
            linear-gradient(140deg, rgba(4,8,7,0.78), rgba(7,9,12,0.66) 46%, rgba(10,8,6,0.82)),
            linear-gradient(180deg, rgba(255,255,255,0.04), transparent 28%, rgba(0,0,0,0.22));
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
          background: linear-gradient(115deg, rgba(255,255,255,0.035), transparent 42%, rgba(29,185,84,0.035));
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

        .lyrics-sync {
          margin-top: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 9px 10px;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px;
          background: linear-gradient(100deg, rgba(29,185,84,0.1), rgba(255,255,255,0.04));
        }

        .lyrics-sync-label {
          display: flex;
          flex-direction: column;
          gap: 2px;
          color: rgba(255,255,255,0.55);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .lyrics-sync-value {
          color: #fff;
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0;
        }

        .lyrics-sync-controls {
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .lyrics-sync-button {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          color: #fff;
          background: rgba(255,255,255,0.08);
          transition: background 0.2s ease, border-color 0.2s ease;
        }

        .lyrics-sync-button:hover:not(:disabled) {
          border-color: rgba(29,185,84,0.65);
          background: rgba(29,185,84,0.2);
        }

        .lyrics-sync-button:disabled {
          cursor: not-allowed;
          opacity: 0.35;
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
          scroll-behavior: smooth;
        }

        .lyrics-lines {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .lyrics-line {
          font-size: 22px;
          line-height: 1.4;
          color: rgba(255,255,255,0.4);
          transform-origin: left center;
          transition: color 0.28s ease, transform 0.28s ease, text-shadow 0.28s ease, background-color 0.28s ease;
          cursor: pointer;
          padding: 6px 10px;
          border-radius: 14px;
          position: relative;
        }

        .lyrics-line.is-active {
          color: #fff;
          background: linear-gradient(90deg, rgba(29,185,84,0.14), rgba(255,255,255,0.06) 55%, rgba(255,255,255,0.015));
          text-shadow: 0 0 18px rgba(255,255,255,0.25);
          backdrop-filter: blur(10px);
          transform: translate3d(4px, -1px, 0) scale(1.025);
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

        .lyrics-line.is-active.is-timed {
          color: rgba(255,255,255,0.82);
          background: linear-gradient(90deg, rgba(29,185,84,0.1), rgba(255,255,255,0.035) 55%, transparent);
          text-shadow: 0 0 14px rgba(29,185,84,0.18);
          backdrop-filter: blur(8px);
        }

        .lyrics-line.is-active.is-timed::before {
          opacity: 0.5;
        }

        .lyrics-syllable {
          display: inline-block;
          margin-right: 4px;
          padding: 0 1px;
          transition: color 0.24s ease, text-shadow 0.26s ease;
          color: rgba(255,255,255,0.35);
        }

        .lyrics-syllable.is-sung {
          color: #1db954;
          text-shadow: 0 0 10px rgba(29,185,84,0.35);
        }

        .lyrics-syllable.is-current {
          color: #1db954;
          text-shadow: 0 0 12px rgba(29,185,84,0.5);
        }

        .lyrics-empty-state {
          min-height: 220px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding: 32px;
          color: rgba(255,255,255,0.62);
          text-align: center;
        }

        .lyrics-retry {
          padding: 9px 16px;
          border: 1px solid rgba(29,185,84,0.55);
          border-radius: 999px;
          color: #fff;
          background: rgba(29,185,84,0.16);
          font-size: 12px;
          font-weight: 600;
          transition: background 0.2s ease, border-color 0.2s ease;
        }

        .lyrics-retry:hover {
          background: rgba(29,185,84,0.28);
          border-color: rgba(29,185,84,0.8);
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
            font-size: 18px;
          }

          .lyrics-actions {
            top: 14px;
            right: 14px;
          }
        }

        .yupify-player-pro {
          position: relative;
          overflow: hidden;
          border-top: 1px solid rgba(255,255,255,0.08);
          background: #080808;
          box-shadow: 0 -28px 80px rgba(0,0,0,0.6);
          font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
        }
        .yupify-player-pro .player-backdrop {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center;
          filter: blur(36px) saturate(1.15);
          opacity: 0.28;
          transform: scale(1.12);
        }
        .yupify-player-pro .player-scrim {
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(8,8,8,0.82), rgba(8,8,8,0.98));
        }
        .yupify-player-pro .player-content {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px 18px 16px;
        }
        .yupify-player-pro .player-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
        }
        .yupify-player-pro .player-info {
          display: flex;
          align-items: center;
          gap: 14px;
          min-width: 0;
          flex: 1;
        }
        .yupify-player-pro .player-cover {
          width: 64px;
          height: 64px;
          border-radius: 16px;
          object-fit: cover;
          box-shadow: 0 12px 30px rgba(0,0,0,0.45);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .yupify-player-pro .player-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .yupify-player-pro .player-title-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .yupify-player-pro .player-title {
          font-size: 16px;
          font-weight: 600;
          color: #f8fafc;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 48vw;
        }
        .yupify-player-pro .player-artist {
          font-size: 13px;
          color: rgba(226,232,240,0.72);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 48vw;
        }
        .yupify-player-pro .player-badges {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .yupify-player-pro .player-badge {
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(16,185,129,0.15);
          color: #34d399;
          border: 1px solid rgba(16,185,129,0.35);
        }
        .yupify-player-pro .player-chip {
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(255,255,255,0.08);
          color: #e2e8f0;
          border: 1px solid rgba(255,255,255,0.12);
          transition: all 0.2s ease;
        }
        .yupify-player-pro .player-chip:hover {
          background: rgba(255,255,255,0.16);
        }
        .yupify-player-pro .player-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .yupify-player-pro .player-progress {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 12px;
          color: rgba(226,232,240,0.6);
        }
        .yupify-player-pro .player-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }
        .yupify-player-pro .player-transport {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          flex: 1;
        }
        .yupify-player-pro .player-volume {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .yupify-player-pro .player-quality {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .yupify-player-pro .player-quality label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: rgba(226,232,240,0.55);
        }
        .yupify-player-pro .player-quality select {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.18);
          color: #e2e8f0;
          padding: 6px 12px;
          border-radius: 999px;
          font-size: 12px;
          outline: none;
        }
        .yupify-player-pro .player-quality select:focus {
          border-color: rgba(16,185,129,0.6);
          box-shadow: 0 0 0 3px rgba(16,185,129,0.2);
        }
        .yupify-player-pro .player-eq {
          display: flex;
          align-items: flex-end;
          gap: 3px;
          height: 16px;
        }
        .yupify-player-pro .player-eq span {
          width: 3px;
          height: 6px;
          border-radius: 999px;
          background: rgba(52,211,153,0.4);
          animation: playerBars 1.1s ease-in-out infinite;
          animation-play-state: paused;
        }
        .yupify-player-pro .player-eq span:nth-child(2) {
          animation-delay: 0.2s;
        }
        .yupify-player-pro .player-eq span:nth-child(3) {
          animation-delay: 0.4s;
        }
        .yupify-player-pro .player-eq.is-playing span {
          animation-play-state: running;
        }
        @keyframes playerBars {
          0% { height: 6px; }
          50% { height: 16px; }
          100% { height: 6px; }
        }
        @media (max-width: 720px) {
          .yupify-player-pro .player-cover {
            width: 52px;
            height: 52px;
            border-radius: 14px;
          }
          .yupify-player-pro .player-title {
            max-width: 60vw;
          }
          .yupify-player-pro .player-artist {
            max-width: 60vw;
          }
          .yupify-player-pro .player-controls {
            justify-content: center;
          }
          .yupify-player-pro .player-transport {
            width: 100%;
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
                    <div className="lyrics-sync">
                      <div className="lyrics-sync-label">
                        <span>Sincronización</span>
                        <strong className="lyrics-sync-value">
                          {lyricsOffset > 0 ? '+' : ''}{lyricsOffset.toFixed(1)} s
                        </strong>
                      </div>
                      <div className="lyrics-sync-controls">
                        <button
                          type="button"
                          className="lyrics-sync-button"
                          title="Atrasar letras 0.1 segundos"
                          aria-label="Atrasar letras 0.1 segundos"
                          disabled={lyricsOffset <= -10}
                          onClick={() => setLyricsOffset((value) => Math.max(-10, Number((value - 0.1).toFixed(1))))}
                        >
                          <Minus size={14} />
                        </button>
                        <button
                          type="button"
                          className="lyrics-sync-button"
                          title="Restablecer sincronización"
                          aria-label="Restablecer sincronización"
                          disabled={lyricsOffset === 0}
                          onClick={() => setLyricsOffset(0)}
                        >
                          <RotateCcw size={13} />
                        </button>
                        <button
                          type="button"
                          className="lyrics-sync-button"
                          title="Adelantar letras 0.1 segundos"
                          aria-label="Adelantar letras 0.1 segundos"
                          disabled={lyricsOffset >= 10}
                          onClick={() => setLyricsOffset((value) => Math.min(10, Number((value + 0.1).toFixed(1))))}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lyrics-right">
                  <div ref={lyricScrollRef} className="lyrics-scroll lyrics-container">
                    {lyricsStructured ? (
                      <div className="lyrics-lines">
                        {lyricsStructured.map((line, li) => {
                          const hasSyllabus = line.syllabus && line.syllabus.length > 0;
                          const timedClass = hasSyllabus ? 'is-timed' : 'is-plain';
                          const lineClickTime = Number.isFinite(line.time) ? line.time : null;
                          return (
                            <div
                              key={line.id}
                              ref={(el) => (linesRef.current[li] = el)}
                              className={`lyrics-line ${timedClass}`}
                              onClick={() => {
                                if (lineClickTime != null) handleSyllableClick(lineClickTime);
                              }}
                            >
                              {hasSyllabus ? (
                                line.syllabus.map((s) => {
                                  const syllableTime = getAbsoluteSyllableTime(line, s);
                                  return (
                                    <span
                                      key={s.id}
                                      className="lyrics-syllable"
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
                      <div className="lyrics-empty-state">
                        <p>{lyricsError || lyricsContent}</p>
                        {lyricsError && (
                          <button type="button" className="lyrics-retry" onClick={retryLyrics}>
                            Reintentar
                          </button>
                        )}
                      </div>
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

      {/* 🎧 PLAYER */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 lg:pl-64">
        <div className="yupify-player-pro">
          <div
            className="player-backdrop"
            style={tidalCover ? { backgroundImage: `url(${tidalCover})` } : undefined}
          />
          <div className="player-scrim" />

          <div className="player-content">
            <div className="player-top">
              <div className="player-info">
                <img
                  src={tidalCover}
                  alt={titleText}
                  className="player-cover"
                />
                <div className="player-meta">
                  <div className="player-title-row">
                    <h3 className="player-title">{titleText}</h3>
                    <div className={`player-eq ${isPlaying ? 'is-playing' : ''}`}>
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                  <p className="player-artist">{artistText}</p>
                  <div className="player-badges">
                    <span className="player-badge">{playbackQuality}</span>
                    <button
                      type="button"
                      onClick={cyclePlaybackRate}
                      className="player-chip"
                      title="Cambiar velocidad de reproducción"
                    >
                      {playbackRateLabel}x
                    </button>
                  </div>
                </div>
              </div>

              <div className="player-actions">
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

            <div className="player-progress">
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

            <div className="player-controls">
              <div className="player-transport">
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

              <div className="player-volume">
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

              <div className="player-quality">
                <label>Calidad</label>
                <select
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
            </div>
          </div>
        </div>

        {/* 🎵 El elemento <audio> ahora es global, creado en useAudio.js */}
        {/* No renderizar aquí para evitar duplicados */}
      </div>
    </>
  );
};

export default Player;
