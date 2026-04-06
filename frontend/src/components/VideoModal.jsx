import React, { useEffect, useRef, useState } from 'react';
import Plyr from 'plyr';
import { X, Loader, Clapperboard, MonitorPlay, Sparkles } from 'lucide-react';
import api from '../services/api';
import { getArtistName, getCoverUrl, getTrackDisplayTitle } from '../utils/helpers';
import 'plyr/dist/plyr.css';

let hlsScriptPromise = null;
let shakaScriptPromise = null;

const loadScriptOnce = (src, check) => {
  if (check()) return Promise.resolve();
  if (src.includes('hls') && hlsScriptPromise) return hlsScriptPromise;
  if (src.includes('shaka') && shakaScriptPromise) return shakaScriptPromise;

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });

  if (src.includes('hls')) hlsScriptPromise = promise;
  if (src.includes('shaka')) shakaScriptPromise = promise;
  return promise;
};

const isDashMime = (mime) => typeof mime === 'string' && mime.toLowerCase().includes('dash');
const isHlsMime = (mime) => typeof mime === 'string' && mime.toLowerCase().includes('mpegurl');

const VideoModal = ({ isOpen, video, onClose }) => {
  const videoRef = useRef(null);
  const shakaRef = useRef(null);
  const hlsRef = useRef(null);
  const plyrRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [videoData, setVideoData] = useState(null);

  useEffect(() => {
    if (!isOpen || !video?.id) return undefined;

    let cancelled = false;
    setLoading(true);
    setError('');
    setVideoData(null);

    api.video.getVideo(video.id)
      .then((data) => {
        if (cancelled) return;
        setVideoData(data?.raw ?? data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'No se pudo cargar el video');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, video?.id]);

  useEffect(() => {
    if (!isOpen || !videoData || !videoRef.current) return undefined;

    const element = videoRef.current;
    const playbackUrl = videoData?.url || null;
    const mime = videoData?.manifestMimeType || '';
    const isDash = isDashMime(mime) || /\.mpd($|\?)/i.test(playbackUrl || '');
    const isHls = isHlsMime(mime) || /\.m3u8($|\?)/i.test(playbackUrl || '');

    let disposed = false;

    const cleanupPlayers = async () => {
      if (plyrRef.current) {
        try {
          plyrRef.current.destroy();
        } catch {}
        plyrRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (shakaRef.current) {
        try {
          await shakaRef.current.destroy();
        } catch {}
        shakaRef.current = null;
      }
      element.removeAttribute('src');
      element.load();
    };

    const start = async () => {
      await cleanupPlayers();
      if (!playbackUrl) {
        setError('No se encontró una URL reproducible para este video.');
        return;
      }

      try {
        if (isDash) {
          await loadScriptOnce(
            'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.10/shaka-player.compiled.min.js',
            () => Boolean(window.shaka)
          );
          if (disposed) return;
          window.shaka.polyfill?.installAll?.();
          const player = new window.shaka.Player(element);
          shakaRef.current = player;
          await player.load(playbackUrl);
        } else if (isHls) {
          const canPlayNativeHls = !!element.canPlayType('application/vnd.apple.mpegurl');
          if (canPlayNativeHls) {
            element.src = playbackUrl;
          } else {
            await loadScriptOnce(
              'https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js',
              () => Boolean(window.Hls)
            );
            if (disposed) return;
            if (window.Hls?.isSupported?.()) {
              const hls = new window.Hls();
              hls.loadSource(playbackUrl);
              hls.attachMedia(element);
              hlsRef.current = hls;
            } else {
              element.src = playbackUrl;
            }
          }
        } else {
          element.src = playbackUrl;
        }

        plyrRef.current = new Plyr(element, {
          controls: [
            'play-large',
            'rewind',
            'play',
            'fast-forward',
            'progress',
            'current-time',
            'duration',
            'mute',
            'volume',
            'captions',
            'settings',
            'pip',
            'airplay',
            'fullscreen'
          ],
          settings: ['speed', 'quality', 'loop'],
          seekTime: 10,
          keyboard: { focused: true, global: true },
          tooltips: { controls: true, seek: true },
          fullscreen: { enabled: true, fallback: true, iosNative: true },
          ratio: '16:9',
          iconUrl: undefined
        });

        const playPromise = element.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch(() => {});
        }
      } catch (err) {
        setError(err?.message || 'No se pudo reproducir el video');
      }
    };

    start();

    return () => {
      disposed = true;
      cleanupPlayers().catch(() => {});
    };
  }, [isOpen, videoData]);

  if (!isOpen || !video) return null;

  const cover = videoData?.coverUrl || getCoverUrl(video, 1280) || getCoverUrl(video, 640) || '';
  const title = getTrackDisplayTitle(video) || video.title || video.name || 'Video';
  const artist = getArtistName(video);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="yupify-video-modal w-full max-w-7xl overflow-hidden rounded-[32px] border border-white/10 bg-[#090909] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-emerald-300/90">
              <MonitorPlay size={14} />
              <span>Video Player</span>
            </div>
            <h2 className="truncate text-xl font-semibold text-white">{title}</h2>
            <p className="truncate text-sm text-gray-400">{artist}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X size={20} />
          </button>
        </div>

        <div className="grid min-h-[60vh] lg:grid-cols-[1.65fr_0.85fr]">
          <div className="relative flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.18),transparent_38%),linear-gradient(180deg,#050505_0%,#000_100%)] p-3 md:p-5">
            {loading ? (
              <div className="flex flex-col items-center gap-3 text-gray-300">
                <Loader className="animate-spin" size={32} />
                <span>Cargando video...</span>
              </div>
            ) : error ? (
              <div className="px-6 text-center text-red-300">{error}</div>
            ) : (
              <div className="relative w-full overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_30px_100px_rgba(0,0,0,0.55)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/75 via-black/30 to-transparent px-5 py-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.32em] text-white/55">Now Watching</p>
                    <p className="max-w-[70vw] truncate text-sm font-medium text-white md:text-base">{title}</p>
                  </div>
                  <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs text-white/70 md:flex">
                    <Sparkles size={14} className="text-emerald-300" />
                    Reproductor mejorado
                  </div>
                </div>
                <video
                  ref={videoRef}
                  playsInline
                  poster={cover || undefined}
                  className="yupify-plyr w-full bg-black"
                />
              </div>
            )}
          </div>

          <div className="border-t border-white/10 bg-gradient-to-b from-neutral-950 via-black to-black p-5 lg:border-l lg:border-t-0">
            {cover ? (
              <img
                src={cover}
                alt={title}
                className="mb-4 aspect-video w-full rounded-2xl border border-white/10 object-cover"
              />
            ) : null}
            <div className="space-y-4">
              <div>
                <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.26em] text-gray-300">
                  <Clapperboard size={14} className="text-amber-300" />
                  Video
                </div>
                <p className="text-lg font-semibold text-white">{title}</p>
              </div>
              <p className="text-gray-400">{artist}</p>
              <div className="grid grid-cols-1 gap-3">
                {videoData?.quality && (
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-emerald-200/70">Calidad</p>
                    <p className="mt-1 text-sm font-medium text-emerald-300">{videoData.quality}</p>
                  </div>
                )}
                {videoData?.manifestMimeType && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-gray-500">Formato</p>
                    <p className="mt-1 break-all text-xs text-gray-300">{videoData.manifestMimeType}</p>
                  </div>
                )}
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-gray-300">
                  Reproducción con controles avanzados, atajos de teclado, PiP, pantalla completa y mejor barra de progreso.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoModal;
