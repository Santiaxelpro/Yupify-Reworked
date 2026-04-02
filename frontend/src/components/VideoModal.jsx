import React, { useEffect, useRef, useState } from 'react';
import { X, Loader } from 'lucide-react';
import api from '../services/api';
import { getArtistName, getCoverUrl, getTrackDisplayTitle } from '../utils/helpers';

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

  const cover = getCoverUrl(video, 1280) || getCoverUrl(video, 640) || '';
  const title = getTrackDisplayTitle(video) || video.title || video.name || 'Video';
  const artist = getArtistName(video);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl rounded-3xl overflow-hidden border border-white/10 bg-[#090909] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-white text-xl font-semibold truncate">{title}</h2>
            <p className="text-sm text-gray-400 truncate">{artist}</p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          >
            <X size={20} />
          </button>
        </div>

        <div className="grid lg:grid-cols-[1.5fr_0.9fr] min-h-[60vh]">
          <div className="bg-black flex items-center justify-center">
            {loading ? (
              <div className="flex flex-col items-center gap-3 text-gray-300">
                <Loader className="animate-spin" size={32} />
                <span>Cargando video...</span>
              </div>
            ) : error ? (
              <div className="px-6 text-center text-red-300">{error}</div>
            ) : (
              <video
                ref={videoRef}
                controls
                playsInline
                poster={cover || undefined}
                className="w-full h-full max-h-[75vh] bg-black"
              />
            )}
          </div>

          <div className="p-5 border-t lg:border-t-0 lg:border-l border-white/10 bg-gradient-to-b from-neutral-950 to-black">
            {cover ? (
              <img
                src={cover}
                alt={title}
                className="w-full aspect-video object-cover rounded-2xl border border-white/10 mb-4"
              />
            ) : null}
            <div className="space-y-2">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-gray-500">Video</p>
                <p className="text-white text-lg font-semibold">{title}</p>
              </div>
              <p className="text-gray-400">{artist}</p>
              {videoData?.quality && (
                <p className="text-sm text-emerald-400">Calidad: {videoData.quality}</p>
              )}
              {videoData?.manifestMimeType && (
                <p className="text-xs text-gray-500 break-all">
                  Formato: {videoData.manifestMimeType}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoModal;
