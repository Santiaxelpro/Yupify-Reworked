// src/components/TrackCard.jsx
import React from 'react';
import { Play, Heart, Download, Disc3, Mic2, Clapperboard, ListMusic } from 'lucide-react';
import { getArtistName, getCoverUrl, getTrackDisplayTitle, getTrackQualityValue, formatQualityLabel } from '../utils/helpers';

const TrackCard = ({ track, onPlay, onToggleFavorite, onDownload, onSelectArtist, isFavorite }) => {
  const itemType = String(track?.type || 'track').toLowerCase();
  const cover = getCoverUrl(track, 1280);
  const qualityLabel = formatQualityLabel(getTrackQualityValue(track, ''), '');
  const releaseYear = typeof track?.releaseDate === 'string' ? track.releaseDate.slice(0, 4) : '';
  const metaLabel = qualityLabel || (
    itemType === 'artist'
      ? (track?.popularity != null ? `Popularidad ${track.popularity}` : 'Artista')
      : itemType === 'album'
        ? (releaseYear || 'Album')
        : itemType === 'playlist'
          ? (track?.numberOfTracks ? `${track.numberOfTracks} tracks` : 'Playlist')
          : ''
  );
  const PlaceholderIcon = itemType === 'artist'
    ? Mic2
    : itemType === 'album'
      ? Disc3
      : itemType === 'video'
        ? Clapperboard
        : itemType === 'playlist'
          ? ListMusic
          : Disc3;

  return (
    <div
      onClick={() => onPlay?.(track)}
      className="bg-gray-900 hover:bg-gray-800 rounded-xl p-4 cursor-pointer transition-all transform hover:scale-105 group"
    >
      <div className="relative mb-3">
        {cover ? (
          <img
            src={cover}
            alt={getTrackDisplayTitle(track) || track.title}
            className="w-full aspect-square object-cover rounded-lg"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              const placeholder = e.currentTarget.nextElementSibling;
              if (placeholder) placeholder.style.display = 'flex';
            }}
          />
        ) : null}
        <div
          className="w-full aspect-square rounded-lg bg-gradient-to-br from-gray-800 to-gray-950 border border-white/5 items-center justify-center"
          style={{ display: cover ? 'none' : 'flex' }}
        >
          <PlaceholderIcon size={42} className="text-gray-500" />
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onPlay?.(track); }}
          className="absolute bottom-2 right-2 bg-green-600 hover:bg-green-700 rounded-full p-3 opacity-0 group-hover:opacity-100 transition-all transform translate-y-2 group-hover:translate-y-0 shadow-lg"
        >
          <Play size={20} fill="white" />
        </button>
        {onToggleFavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(track); }}
            className="absolute top-2 right-2 bg-black/50 backdrop-blur-sm rounded-full p-2 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Heart
              size={18}
              className={isFavorite ? 'fill-red-500 text-red-500' : 'text-white'}
            />
          </button>
        )}
        {onDownload && (
          <button
            onClick={(e) => { e.stopPropagation(); onDownload(track); }}
            className="absolute top-2 left-2 bg-black/50 backdrop-blur-sm rounded-full p-2 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Download size={18} className="text-white" />
          </button>
        )}
      </div>
      <h3 className="font-semibold truncate text-white">{getTrackDisplayTitle(track)}</h3>
      <p
        onClick={(e) => {
          if (!onSelectArtist) return;
          e.stopPropagation();
          onSelectArtist(track);
        }}
        className={`text-sm truncate ${onSelectArtist ? 'text-gray-300 hover:text-white hover:underline cursor-pointer' : 'text-gray-400'}`}
      >
        {getArtistName(track)}
      </p>
      <div className="flex items-center justify-between mt-2 min-h-[20px]">
        <span className={`text-xs font-semibold ${qualityLabel ? 'text-green-400' : 'text-gray-500'}`}>
          {metaLabel || ''}
        </span>
        {track.plays && (
          <span className="text-xs text-gray-500">{track.plays} plays</span>
        )}
      </div>
    </div>
  );
};

export default TrackCard;
