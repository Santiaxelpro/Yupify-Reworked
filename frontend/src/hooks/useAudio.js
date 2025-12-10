// src/hooks/useAudio.js
import { useState, useRef, useEffect } from 'react';
import api from '../services/api';

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
  // 🔥 NUEVO: Calidad de audio global
  // ============================
  const [quality, setQuality] = useState("LOSSLESS");


  // ============================
  // 🔥 Cargar track + URL de audio real
  // ============================
  const playTrack = async (track) => {
    try {
      setCurrentTrack(track);
      setIsPlaying(false);
      setCurrentTime(0);

      console.log("📀 Loading track:", track.id, track.title);
      console.log("🎚 Using quality:", quality);

      // Obtener stream real con calidad seleccionada
      const trackData = await api.track.getTrack(track.id, quality);
      console.log("📡 Track data:", trackData);

      const realUrl = trackData?.url;

      if (!realUrl) {
        console.error("❌ No se encontró URL en track data");
        console.error("Track data structure:", trackData);
        return;
      }

      console.log("🎵 Stream URL:", realUrl.substring(0, 80) + "...");
      setStreamUrl(realUrl);

      if (audioRef.current) {
        audioRef.current.src = realUrl;
        console.log("✅ Audio src set, loading...");
        await audioRef.current.load();
        console.log("✅ Audio loaded, duration:", audioRef.current.duration);
      }

      const playPromise = audioRef.current?.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log("▶️ Playing...");
            setIsPlaying(true);
          })
          .catch(error => {
            console.error("❌ Play error:", error);
          });
      }

    } catch (error) {
      console.error("❌ Error cargando track:", error);
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
    quality,        // ⬅ NUEVO
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
    setIsShuffle,
    setQuality       // ⬅ NUEVO
  };
};

export default useAudio;
