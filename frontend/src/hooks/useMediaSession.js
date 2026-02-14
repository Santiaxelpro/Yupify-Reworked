// src/hooks/useMediaSession.js
import { useEffect, useMemo, useRef } from 'react';
import { getArtistName, getCoverUrl } from '../utils/helpers';

const ART_SIZES = [96, 128, 192, 256, 384, 512, 1024];

const buildArtwork = (track) => {
  const baseUrl = getCoverUrl(track, 1024);
  if (!baseUrl) return [];

  return ART_SIZES.map((size) => {
    const url = getCoverUrl(track, size) || baseUrl;
    return {
      src: url,
      sizes: `${size}x${size}`,
      type: 'image/jpeg'
    };
  });
};

const useMediaSession = ({
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  audioRef,
  onPlay,
  onPause,
  onNext,
  onPrevious
}) => {
  const timeRef = useRef(currentTime);
  const durationRef = useRef(duration);

  useEffect(() => {
    timeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const metadata = useMemo(() => {
    if (!currentTrack) return null;
    if (typeof window === 'undefined') return null;
    if (!('MediaMetadata' in window)) return null;

    const artist = getArtistName(currentTrack);
    const album = currentTrack.album?.title || currentTrack.album?.name || '';
    const artwork = buildArtwork(currentTrack);

    return new window.MediaMetadata({
      title: currentTrack.title ?? '',
      artist,
      album,
      artwork
    });
  }, [currentTrack]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('mediaSession' in navigator)) return;

    if (metadata) {
      navigator.mediaSession.metadata = metadata;
    } else {
      navigator.mediaSession.metadata = null;
    }
  }, [metadata]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    if (!duration || duration <= 0) return;

    const playbackRate = audioRef?.current?.playbackRate ?? 1;

    navigator.mediaSession.setPositionState({
      duration,
      position: currentTime,
      playbackRate
    });
  }, [currentTime, duration, audioRef]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('mediaSession' in navigator)) return;

    const audio = audioRef?.current;
    const mediaSession = navigator.mediaSession;

    const safeSetHandler = (action, handler) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch (err) {
        console.warn(`MediaSession action "${action}" not supported`, err);
      }
    };

    safeSetHandler('play', async () => {
      try {
        if (typeof onPlay === 'function') {
          const result = onPlay();
          if (result && typeof result.then === 'function') {
            await result;
          }
          return;
        }
        await audio?.play();
      } catch (err) {
        console.warn('MediaSession play failed', err);
      }
    });

    safeSetHandler('pause', () => {
      try {
        if (typeof onPause === 'function') {
          onPause();
          return;
        }
        audio?.pause();
      } catch (err) {
        console.warn('MediaSession pause failed', err);
      }
    });

    safeSetHandler('stop', () => {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } catch (err) {
        console.warn('MediaSession stop failed', err);
      }
    });

    safeSetHandler('previoustrack', () => {
      try {
        if (typeof onPrevious === 'function') onPrevious();
      } catch (err) {
        console.warn('MediaSession previoustrack failed', err);
      }
    });

    safeSetHandler('nexttrack', () => {
      try {
        if (typeof onNext === 'function') onNext();
      } catch (err) {
        console.warn('MediaSession nexttrack failed', err);
      }
    });

    safeSetHandler('seekbackward', (details) => {
      try {
        if (!audio) return;
        const offset = details?.seekOffset ?? 10;
        const base = Number.isFinite(audio.currentTime) ? audio.currentTime : timeRef.current;
        audio.currentTime = Math.max(0, base - offset);
      } catch (err) {
        console.warn('MediaSession seekbackward failed', err);
      }
    });

    safeSetHandler('seekforward', (details) => {
      try {
        if (!audio) return;
        const offset = details?.seekOffset ?? 10;
        const base = Number.isFinite(audio.currentTime) ? audio.currentTime : timeRef.current;
        const max = Number.isFinite(audio.duration) ? audio.duration : durationRef.current;
        const next = base + offset;
        audio.currentTime = Number.isFinite(max) ? Math.min(max, next) : next;
      } catch (err) {
        console.warn('MediaSession seekforward failed', err);
      }
    });

    safeSetHandler('seekto', (details) => {
      try {
        if (!audio) return;
        if (!details || !Number.isFinite(details.seekTime)) return;
        if (details.fastSeek && typeof audio.fastSeek === 'function') {
          audio.fastSeek(details.seekTime);
        } else {
          audio.currentTime = details.seekTime;
        }
      } catch (err) {
        console.warn('MediaSession seekto failed', err);
      }
    });

    return () => {
      safeSetHandler('play', null);
      safeSetHandler('pause', null);
      safeSetHandler('stop', null);
      safeSetHandler('previoustrack', null);
      safeSetHandler('nexttrack', null);
      safeSetHandler('seekbackward', null);
      safeSetHandler('seekforward', null);
      safeSetHandler('seekto', null);
    };
  }, [audioRef, onNext, onPause, onPlay, onPrevious]);
};

export default useMediaSession;
