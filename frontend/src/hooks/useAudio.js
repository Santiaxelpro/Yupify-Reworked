// src/hooks/useAudio.js
import { useState, useRef, useEffect, useCallback } from 'react';
import api from '../services/api';

let shakaPlayer = null;

// Crear elemento <audio> global que funcionará con o sin DOM
const getAudioElement = () => {
  if (typeof document === 'undefined') return null;
  
  let audio = document.getElementById('yupify-audio-player');
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'yupify-audio-player';
    audio.crossOrigin = 'anonymous';
    document.body.appendChild(audio);
  }
  return audio;
};

// Cargar Shaka Player si es necesario
const initShakaPlayer = async (audioElement) => {
  if (shakaPlayer) return shakaPlayer;
  
  return new Promise((resolve) => {
    if (!window.shaka) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.10/shaka-player.compiled.min.js';
      script.async = true;
      script.onload = async () => {
        if (window.shaka) {
          window.shaka.polyfill?.installAll?.();
          // Crear Player sin mediaElement (attach() es la forma recomendada)
          const player = new window.shaka.Player();
          if (audioElement && typeof player.attach === 'function') {
            try {
              await player.attach(audioElement);
            } catch (e) {
              console.warn('Shaka attach warning:', e);
            }
          }
          shakaPlayer = player;
          resolve(shakaPlayer);
        }
      };
      document.head.appendChild(script);
    } else {
      const player = new window.shaka.Player();
      if (audioElement && typeof player.attach === 'function') {
        player.attach(audioElement).catch(e => console.warn('Shaka attach warning:', e));
      }
      shakaPlayer = player;
      resolve(shakaPlayer);
    }
  });
};

export const useAudio = () => {
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const onEndedRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [streamUrl, setStreamUrl] = useState(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [volume, setVolume] = useState(0.7);
  const [isMuted, setIsMuted] = useState(false);

  const [isRepeat, setIsRepeat] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);

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
      setDuration(audio.duration || shakaDur || 0);
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
  const playTrack = async (track) => {
    try {
      console.log("📀 Loading track:", track.id, track.title);
      console.log("🎚 Using quality:", quality);

      // Obtener el audio element (global o del DOM)
      let audioElement = audioRef.current || getAudioElement();
      
      if (!audioElement) {
        console.error("❌ No se pudo obtener audio element");
        return;
      }

      console.log("✅ Audio element disponible");

      // Obtener track data con calidad seleccionada
      const trackData = await api.track.getTrack(track.id, quality);
      console.log("📡 Track data:", trackData);

      // Detectar si es DASH manifest (HI_RES)
      const isDash = trackData?.manifestMimeType === 'application/dash+xml';
      setIsDashPlayback(isDash);

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
          if (audioElement) {
            audioElement.pause();
            audioElement.removeAttribute('src');
            audioElement.load();
          }
          
          // Crear Data URL del manifest DASH (evita HEAD requests en blobs)
          const manifestBase64 = btoa(trackData.manifest);
          const manifestUrl = 'data:application/dash+xml;base64,' + manifestBase64;
          

          
          // Cargar manifest DASH con Shaka Player
          await player.load(manifestUrl);

          
          setCurrentTrack({ ...track, isDash: true, manifest: trackData.manifest });
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

          const fallbackData = await api.track.getTrack(track.id, 'LOSSLESS');
          if (fallbackData?.url) {
            const trackWithUrl = { ...track, streamUrl: fallbackData.url, isDash: false };
            setCurrentTrack(trackWithUrl);
            setStreamUrl(fallbackData.url);
            
            if (audioElement) {
              audioElement.src = fallbackData.url;
              await audioElement.load();
              audioElement.play().catch(console.error);
              setIsPlaying(true);
            }
          }
        }
      } else {
        // 🎵 Standard playback (JSON manifest)
        const realUrl = trackData?.url;

        if (!realUrl) {
          console.error("❌ No se encontró URL en track data");
          console.error("Track data structure:", trackData);
          return;
        }


        
        // Actualizar currentTrack CON la URL extraída
        const trackWithUrl = { ...track, streamUrl: realUrl, isDash: false };
        setCurrentTrack(trackWithUrl);
        setStreamUrl(realUrl);
        
        setIsPlaying(false);
        setCurrentTime(0);

        if (audioElement) {
          audioElement.src = realUrl;
          console.log("✅ Audio src set, loading...");
          audioElement.load();
          console.log("✅ Audio loaded, duration:", audioElement.duration);
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
  const togglePlay = () => {
    const audio = audioRef.current || getAudioElement();
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(console.error);
      setIsPlaying(true);
    }
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
