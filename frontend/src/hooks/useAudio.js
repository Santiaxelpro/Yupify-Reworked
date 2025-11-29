// src/hooks/useAudio.js
import { useState, useRef, useEffect } from 'react';
import { trackService } from '../services/api';

export const useAudio = () => {
  const audioRef = useRef(null);

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
  // 🔥 Cargar track + URL de audio real
  // ============================
  const playTrack = async (track) => {
    try {
      setCurrentTrack(track);
      setIsPlaying(false);
      setCurrentTime(0);

      // Obtener stream real
      const backendData = await trackService.getTrack(track.id, "LOSSLESS");

      const realUrl = backendData[2]?.OriginalTrackUrl;

      if (!realUrl) {
        console.error("No se encontró OriginalTrackUrl en backend");
        return;
      }

      setStreamUrl(realUrl);

      // Cargar audio
      if (audioRef.current) {
        audioRef.current.src = realUrl;
        await audioRef.current.load();
      }

      // Reproducir
      audioRef.current?.play().catch(console.error);
      setIsPlaying(true);

    } catch (error) {
      console.error("Error cargando track:", error);
    }
  };

  // ============================
  // 🔥 Actualizar volumen
  // ============================
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // ============================
  // 🔥 Play/Pause
  // ============================
  const togglePlay = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(console.error);
      setIsPlaying(true);
    }
  };

  // ============================
  // 🔥 Actualizar tiempo
  // ============================
  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    setCurrentTime(audioRef.current.currentTime);
    setDuration(audioRef.current.duration || 0);
  };

  // ============================
  // 🔥 Seek
  // ============================
  const handleSeek = (value) => {
    if (!audioRef.current) return;
    const newTime = (value / 100) * duration;
    audioRef.current.currentTime = newTime;
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

  // ============================
  // 🔥 Canción terminada
  // ============================
  const handleEnded = () => {
    if (isRepeat && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    setIsPlaying(false);
  };

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

    audioRef,

    // Funciones
    playTrack,
    togglePlay,
    handleTimeUpdate,
    handleSeek,
    handleVolumeChange,
    toggleMute,
    handleEnded,

    setIsRepeat,
    setIsShuffle
  };
};

export default useAudio;
