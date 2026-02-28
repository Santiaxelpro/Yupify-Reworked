// src/components/TrackCard.jsx
import React from 'react';
import { Play, Heart, Download } from 'lucide-react';
import { getArtistName, getCoverUrl, getTrackDisplayTitle, getTrackQualityValue, formatQualityLabel } from '../utils/helpers';

const TrackCard = ({ track, onPlay, onToggleFavorite, onDownload, isFavorite }) => {
  
  const getCover = () => {
    return getCoverUrl(track, 1280) || 'https://resources.tidal.com/images/5187b614/1c44/4694/9ab1/d675a3c41114/1280x1280.jpg';
  };

  return (
    <div className="bg-gray-900 hover:bg-gray-800 rounded-xl p-4 cursor-pointer transition-all transform hover:scale-105 group">
      <div className="relative mb-3">
        <img
          src={getCover()}
          alt={getTrackDisplayTitle(track) || track.title}
          className="w-full aspect-square object-cover rounded-lg"
          onError={(e) => e.target.src = 'https://resources.tidal.com/images/ddd75a35/5b2d/409c/abe3/7368b34f02f0/1280x1280.jpg'}
        />
        <button 
          onClick={(e) => { e.stopPropagation(); onPlay(track); }}
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
      <p className="text-sm text-gray-400 truncate">{getArtistName(track)}</p>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-green-400 font-semibold">
          {formatQualityLabel(getTrackQualityValue(track, '-'), '-')}
        </span>
        {track.plays && (
          <span className="text-xs text-gray-500">{track.plays} plays</span>
        )}
      </div>
    </div>
  );
};

export default TrackCard;

