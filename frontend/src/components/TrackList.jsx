// src/components/TrackList.jsx
import React from 'react';
import { Play, Heart, Download } from 'lucide-react';
import { getCoverUrl, getArtistName, getTrackDisplayTitle, getTrackQualityValue, formatQualityLabel } from '../utils/helpers';

const TrackList = ({ tracks, onPlay, onToggleFavorite, onDownload, onSelectArtist, favorites = [], currentTrackId }) => {
  const formatTime = (seconds) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isFavorite = (trackId) => {
    return favorites.some(f => f.id === trackId);
  };

  return (
    <div className="space-y-2">
      {tracks.map((track, index) => {
        const coverUrl = getCoverUrl(track, 1280);
        const itemType = String(track?.type || 'track').toLowerCase();
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

        return (
          <div
            key={track.id || index}
            onClick={() => onPlay(track)}
            className={`flex items-center gap-4 bg-gray-900 hover:bg-gray-800 rounded-xl p-3 cursor-pointer transition-all group ${
              currentTrackId === track.id ? 'ring-2 ring-green-600 bg-gray-800' : ''
            }`}
          >
            <div className="relative w-16 h-16 flex-shrink-0">
              <img
                src={coverUrl || ''}
                alt={track.title}
                className="w-full h-full rounded-lg object-cover bg-gray-800"
                onError={(e) => e.target.style.display = 'none'}
              />
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-lg">
                <Play size={24} fill="white" />
              </div>
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="font-semibold truncate">{getTrackDisplayTitle(track)}</h3>
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
              {metaLabel ? (
                <span className={`text-xs ${qualityLabel ? 'text-[#1db954]' : 'text-gray-500'}`}>
                  {metaLabel}
                </span>
              ) : null}
            </div>

            <span className="text-sm text-gray-500 hidden md:block">
              {formatTime(track.duration)}
            </span>

            {onToggleFavorite && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(track); }}
                className="opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Heart
                  size={20}
                  className={isFavorite(track.id) ? 'fill-red-500 text-red-500' : 'text-gray-400 hover:text-red-500'}
                />
              </button>
            )}

            {onDownload && (
              <button
                onClick={(e) => { e.stopPropagation(); onDownload(track); }}
                className="text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Download size={20} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default TrackList;
