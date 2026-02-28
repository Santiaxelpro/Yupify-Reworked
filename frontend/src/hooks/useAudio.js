// src/hooks/useAudio.js
import { useState, useRef, useEffect, useCallback } from 'react';
import api from '../services/api';

let shakaPlayer = null;
const inlineManifestStore = new Map();
let inlineSchemeRegistered = false;

const registerInlineScheme = () => {
  if (inlineSchemeRegistered || !window?.shaka?.net?.NetworkingEngine) return;
  const shaka = window.shaka;
  const plugin = (uri, request) => {
    const data = inlineManifestStore.get(uri);
    if (!data) {
      return Promise.reject(new Error('Inline manifest not found'));
    }
    let buffer;
    if (typeof TextEncoder !== 'undefined') {
      buffer = new TextEncoder().encode(data).buffer;
    } else {
      const arr = new Uint8Array(Array.from(data).map((c) => c.charCodeAt(0)));
      buffer = arr.buffer;
    }
    const isHead = (request?.method || '').toUpperCase() === 'HEAD';
    return Promise.resolve({
      uri,
      originalUri: uri,
      data: isHead ? new ArrayBuffer(0) : buffer,
      headers: { 'content-type': 'application/dash+xml' }
    });
  };
  shaka.net.NetworkingEngine.registerScheme(
    'inline',
    plugin,
    shaka.net.NetworkingEngine.PluginPriority.APPLICATION
  );
  inlineSchemeRegistered = true;
};

// Crear elemento <audio> global que funcionará con o sin DOM
const getAudioElement = () => {
  if (typeof document === 'undefined') return null;
  
  let audio = document.getElementById('yupify-audio-player');
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'yupify-audio-player';
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    document.body.appendChild(audio);
  }
  return audio;
};

// Cargar Shaka Player si es necesario
const initShakaPlayer = async (audioElement) => {
  const ensureAttach = async (player) => {
    if (!audioElement || typeof player.attach !== 'function') return;
    try {
      const currentEl = typeof player.getMediaElement === 'function' ? player.getMediaElement() : null;
      if (currentEl && currentEl !== audioElement && typeof player.detach === 'function') {
        await player.detach();
      }
      if (currentEl !== audioElement) {
        await player.attach(audioElement);
      }
    } catch (e) {
      console.warn('Shaka attach warning:', e);
    }
  };

  if (shakaPlayer) {
    await ensureAttach(shakaPlayer);
    return shakaPlayer;
  }
  
  return new Promise((resolve) => {
    if (!window.shaka) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.10/shaka-player.compiled.min.js';
      script.async = true;
      script.onload = async () => {
        if (window.shaka) {
          window.shaka.polyfill?.installAll?.();
          registerInlineScheme();
          // Crear Player sin mediaElement (attach() es la forma recomendada)
          const player = new window.shaka.Player();
          player.addEventListener?.('error', (event) => {
            console.error('Shaka player error:', event?.detail || event);
          });
          await ensureAttach(player);
          shakaPlayer = player;
          resolve(shakaPlayer);
        }
      };
      document.head.appendChild(script);
    } else {
      registerInlineScheme();
      const player = new window.shaka.Player();
      player.addEventListener?.('error', (event) => {
        console.error('Shaka player error:', event?.detail || event);
      });
      ensureAttach(player)
        .then(() => {
          shakaPlayer = player;
          resolve(shakaPlayer);
        })
        .catch(() => {
          shakaPlayer = player;
          resolve(shakaPlayer);
        });
    }
  });
};

export const useAudio = () => {
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const onEndedRef = useRef(null);
  const fadeRafRef = useRef(null);
  const fadeActiveRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [streamUrl, setStreamUrl] = useState(null);
  const currentTrackRef = useRef(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [volume, setVolume] = useState(0.7);
  const [isMuted, setIsMuted] = useState(false);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);

  const [isRepeat, setIsRepeat] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  // ============================
  // 🔥 NUEVO: Calidad de audio global
  // ============================
  const [quality, setQuality] = useState(localStorage.getItem('audioQuality') || 'LOSSLESS');
  const [isDashPlayback, setIsDashPlayback] = useState(false);

  // Usar refs para acceder al estado actual sin causar re-renders
  const isRepeatRef = useRef(isRepeat);
  useEffect(() => {
    isRepeatRef.current = isRepeat;
  }, [isRepeat]);

  const getTargetVolume = useCallback(() => (
    isMutedRef.current ? 0 : volumeRef.current
  ), []);

  const cancelFade = useCallback(() => {
    if (fadeRafRef.current && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(fadeRafRef.current);
    }
    fadeRafRef.current = null;
    fadeActiveRef.current = false;
  }, []);

  const fadeOutAndPause = useCallback((audio, durationMs = 320) => {
    if (!audio) return;

    if (typeof requestAnimationFrame !== 'function') {
      audio.pause();
      audio.volume = getTargetVolume();
      return;
    }

    cancelFade();

    const from = Number.isFinite(audio.volume) ? audio.volume : getTargetVolume();
    if (audio.paused || from <= 0.01) {
      audio.pause();
      audio.volume = getTargetVolume();
      return;
    }

    const duration = Math.max(120, durationMs);
    const start = performance.now();
    fadeActiveRef.current = true;

    const step = (now) => {
      if (!fadeActiveRef.current) return;
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      const nextVolume = from * (1 - t);
      audio.volume = Math.max(0, Math.min(1, nextVolume));

      if (t < 1) {
        fadeRafRef.current = requestAnimationFrame(step);
        return;
      }

      fadeActiveRef.current = false;
      fadeRafRef.current = null;
      audio.pause();
      audio.volume = getTargetVolume();
    };

    fadeRafRef.current = requestAnimationFrame(step);
  }, [cancelFade, getTargetVolume]);

  // Asignar el audio global al ref cuando esté disponible (SOLO UNA VEZ)
  useEffect(() => {
    const globalAudio = getAudioElement();
    if (globalAudio && !audioRef.current) {
      audioRef.current = globalAudio;
    }
  }, []);

  // Ref para mantener currentTime actualizado sin causar re-renders del RAF loop
  const currentTimeRef = useRef(0);

  // Event listeners para actualizar estado desde los eventos del audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      const newTime = audio.currentTime || 0;
      currentTimeRef.current = newTime;
      setCurrentTime(newTime);
    };

    const handleLoadedMeta = () => {
      const shakaDur = shakaPlayer && typeof shakaPlayer.getDuration === 'function' ? shakaPlayer.getDuration() : null;
      const audioDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
      const track = currentTrackRef.current;
      const trackDurationMs = track?.durationMs ?? track?.duration_ms ?? null;
      const trackDuration = track?.duration ?? track?.length ?? null;
      const fallbackDur = trackDurationMs
        ? Number(trackDurationMs) / 1000
        : (Number.isFinite(Number(trackDuration)) ? Number(trackDuration) : null);
      const nextDuration = audioDur || shakaDur || fallbackDur || 0;
      setDuration(nextDuration);
      if (Number.isFinite(nextDuration) && nextDuration > 0) {
        console.log("✅ Audio metadata loaded, duration:", nextDuration);
      }
    };

    const handleEnded = () => {
      const audio = audioRef.current;
      if (isRepeatRef.current && audio) {
        audio.currentTime = 0;
        audio.play();
        return;
      }
      setIsPlaying(false);
      if (onEndedRef.current) {
        try {
          onEndedRef.current();
        } catch (e) {
          console.error('Error en autoplay:', e);
        }
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMeta);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMeta);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, []);


  // ============================
  // 🔥 Cargar track + URL de audio real
  // ============================
  const mergeTrackMeta = (base, extra) => {
    if (!extra) return base || null;
    if (!base) return extra;
    const merged = { ...extra, ...base };
    if (!merged.cover && extra.cover) merged.cover = extra.cover;
    if (!merged.coverUrl && extra.coverUrl) merged.coverUrl = extra.coverUrl;
    if (!merged.albumArtUrl && extra.albumArtUrl) merged.albumArtUrl = extra.albumArtUrl;
    if (!merged.album && extra.album) merged.album = extra.album;
    if (merged.album && extra.album) {
      if (!merged.album.cover && extra.album.cover) {
        merged.album = { ...merged.album, cover: extra.album.cover };
      }
      if (!merged.album.coverUrl && extra.album.coverUrl) {
        merged.album = { ...merged.album, coverUrl: extra.album.coverUrl };
      }
    }
    if (!merged.artists && extra.artists) merged.artists = extra.artists;
    if (!merged.artist && extra.artist) merged.artist = extra.artist;
    return merged;
  };

  const playTrack = async (track) => {
    try {
      cancelFade();
      console.log("📀 Loading track:", track.id, track.title);
      console.log("🎚 Using quality:", quality);

      // Obtener el audio element (global o del DOM)
      let audioElement = audioRef.current || getAudioElement();
      
      if (!audioElement) {
        console.error("❌ No se pudo obtener audio element");
        return;
      }

      console.log("✅ Audio element disponible");

      // Helper: fallback a calidades estándar (no DASH)
      const tryFallback = async () => {
        const fallbackQualities = ['LOSSLESS', 'HIGH', 'LOW'];
        for (const q of fallbackQualities) {
          try {
            const fallbackData = await api.track.getTrack(track.id, q, track);
            const presentation = String(fallbackData?.assetPresentation || '').toUpperCase();
            if (presentation === 'PREVIEW') continue;
            if (fallbackData?.manifestMimeType === 'application/dash+xml') continue;
            if (audioElement?.canPlayType && fallbackData?.manifestMimeType) {
              const canPlay = audioElement.canPlayType(fallbackData.manifestMimeType);
              if (!canPlay) continue;
            }
            if (fallbackData?.url) {
              if (shakaPlayer && typeof shakaPlayer.detach === 'function') {
                try {
                  await shakaPlayer.detach();
                } catch (e) {
                  console.warn('Shaka detach warning:', e);
                }
              }
              const mergedTrack = mergeTrackMeta(track, fallbackData);
              const trackWithUrl = { ...mergedTrack, streamUrl: fallbackData.url, isDash: false };
              setCurrentTrack(trackWithUrl);
              setStreamUrl(fallbackData.url);
              if (audioElement) {
                audioElement.src = fallbackData.url;
                audioElement.load();
                audioElement.play().catch(console.error);
                setIsPlaying(true);
              }
              return true;
            }
          } catch (e) {
            // probar siguiente calidad
          }
        }
        return false;
      };

      // Obtener track data con calidad seleccionada
      const trackData = await api.track.getTrack(track.id, quality, track);
      console.log("📡 Track data:", trackData);
      const presentation = String(trackData?.assetPresentation || '').toUpperCase();

      // Detectar si es DASH manifest (HI_RES)
      const isDash = trackData?.manifestMimeType === 'application/dash+xml';
      setIsDashPlayback(isDash);

      if (presentation === 'PREVIEW') {
        console.warn('🚫 Track en PREVIEW, intentando fallback...');
        const ok = await tryFallback();
        if (!ok) {
          console.error('❌ No se pudo obtener stream FULL');
        }
        return;
      }

      const mergedTrack = mergeTrackMeta(track, trackData);

      if (isDash) {
        // 🎬 DASH playback con Shaka Player
        console.log("🎬 Reproduciendo HI_RES DASH manifest");
        console.log("Manifest type:", typeof trackData.manifest);
        console.log("Manifest preview:", trackData.manifest?.substring(0, 100));
        
        try {
          const player = await initShakaPlayer(audioElement);
          if (player && typeof player.unload === 'function') {
            try {
              await player.unload();
            } catch (e) {
              console.warn('Shaka unload warning:', e);
            }
          }
          if (typeof trackData.manifest !== 'string') {
            throw new Error('Manifest DASH inv?lido');
          }

          const inlineKey = `inline://manifest/${Date.now()}-${Math.random().toString(36).slice(2)}`;
          inlineManifestStore.set(inlineKey, trackData.manifest);
          try {
            // Cargar manifest DASH con Shaka Player (inline)
            await player.load(inlineKey, null, 'application/dash+xml');
          } finally {
            inlineManifestStore.delete(inlineKey);
          }

          
          setCurrentTrack({ ...mergedTrack, isDash: true, manifest: trackData.manifest });
          // Intentar obtener la duración desde Shaka Player
          try {
            const shakaDur = typeof player.getDuration === 'function' ? player.getDuration() : null;
            if (shakaDur && !Number.isNaN(shakaDur) && shakaDur !== Infinity) {
              setDuration(shakaDur);
            }
          } catch (e) {
            console.warn('No se pudo obtener duración desde Shaka:', e);
          }
          setStreamUrl(null); // No hay URL simple para DASH
          
          setIsPlaying(false);
          setCurrentTime(0);

          const playPromise = audioElement.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => {

                setIsPlaying(true);
              })
              .catch(error => {
                console.error("❌ DASH Play error:", error);
              });
          }
        } catch (error) {
          console.error("❌ Error en DASH playback:", error);
          // Fallback a LOSSLESS
          await tryFallback();
        }
      } else {
        // 🎵 Standard playback (JSON manifest)
        const realUrl = trackData?.url;

        if (!realUrl) {
          console.error("❌ No se encontró URL en track data");
          console.error("Track data structure:", trackData);
          const ok = await tryFallback();
          if (!ok) return;
        }

        if (audioElement?.canPlayType && trackData?.manifestMimeType) {
          const canPlay = audioElement.canPlayType(trackData.manifestMimeType);
          if (!canPlay) {
            console.warn("⚠️ MIME no soportado:", trackData.manifestMimeType, "→ intentando fallback");
            const ok = await tryFallback();
            if (!ok) return;
          }
        }


        
        // Detach Shaka before standard playback
        if (shakaPlayer && typeof shakaPlayer.detach === 'function') {
          try {
            await shakaPlayer.detach();
          } catch (e) {
            console.warn('Shaka detach warning:', e);
          }
        }

        // Actualizar currentTrack CON la URL extraída
        const trackWithUrl = { ...mergedTrack, streamUrl: realUrl, isDash: false };
        setCurrentTrack(trackWithUrl);
        setStreamUrl(realUrl);
        
        setIsPlaying(false);
        setCurrentTime(0);

        if (audioElement) {
          audioElement.src = realUrl;
          console.log("✅ Audio src set, loading...");
          audioElement.load();
        }

        const playPromise = audioElement?.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {

              setIsPlaying(true);
            })
            .catch(error => {
              console.error("❌ Play error:", error);
            });
        }
      }

    } catch (error) {
      console.error("❌ Error cargando track:", error);
    }
  };



  // ============================
  // 🔥 Actualizar volumen
  // ============================
  useEffect(() => {
    const audio = audioRef.current || getAudioElement();
    if (audio) {
      if (fadeActiveRef.current) return;
      audio.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);


  // ============================
  // 🔥 Cambiar calidad de audio
  // ============================
  useEffect(() => {
    localStorage.setItem('audioQuality', quality);
    if (currentTrack && (isPlaying || duration > 0)) {

      playTrack(currentTrack);
    }
  }, [quality]);


  // ============================
  // 🔥 Play/Pause
  // ============================
  const playCurrent = useCallback(() => {
    const audio = audioRef.current || getAudioElement();
    if (!audio) return;

    cancelFade();
    audio.volume = isMuted ? 0 : volume;
    audio.play().catch(console.error);
    setIsPlaying(true);
  }, [cancelFade, isMuted, volume]);

  const pauseWithFade = useCallback(() => {
    const audio = audioRef.current || getAudioElement();
    if (!audio) return;

    fadeOutAndPause(audio);
    setIsPlaying(false);
  }, [fadeOutAndPause]);

  const togglePlay = () => {
    if (isPlaying) {
      pauseWithFade();
      return;
    }
    playCurrent();
  };


  // ============================
  // 🔥 Seek
  // ============================
  const handleSeek = (value) => {
    const audio = audioRef.current || getAudioElement();
    if (!audio) return;
    const newTime = (value / 100) * duration;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };


  // ============================
  // 🔥 Volumen
  // ============================
  const handleVolumeChange = (value) => {
    const vol = value / 100;
    setVolume(vol);
    setIsMuted(false);
  };

  const toggleMute = () => setIsMuted(!isMuted);

  const setOnEndedCallback = useCallback((fn) => {
    onEndedRef.current = typeof fn === 'function' ? fn : null;
  }, []);

  // Funciones dummy - los event listeners ya están en el useEffect global



  return {
    // Estado
    isPlaying,
    currentTrack,
    streamUrl,
    currentTime,
    duration,

    volume,
    isMuted,
    isRepeat,
    isShuffle,
    quality,        // ⬅ NUEVO
    audioRef,

    // Funciones
    playTrack,
    playCurrent,
    pauseWithFade,
    togglePlay,
    handleSeek,
    handleVolumeChange,
    toggleMute,
    setIsRepeat,
    setIsShuffle,
    setQuality,      // ⬅ NUEVO
    setOnEndedCallback
  };
};

export default useAudio;
