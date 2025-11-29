// src/components/TrackCard.jsx
import React from 'react';
import { Play, Heart, MoreVertical } from 'lucide-react';

const TrackCard = ({ track, onPlay, onToggleFavorite, isFavorite }) => {
  
  const getCover = () => {
    if (track.cover) return track.cover;
    if (track.album?.cover) return track.album.cover;
    return 'https://resources.tidal.com/images/5187b614/1c44/4694/9ab1/d675a3c41114/1280x1280.jpg';
  };

  const getArtist = () => {
    if (track.artist?.name) return track.artist.name;
    if (typeof track.artist === 'string') return track.artist;
    return 'Unknown Artist';
  };

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl p-4 hover:from-gray-800 hover:to-gray-700 cursor-pointer transition-all transform hover:scale-105 hover:shadow-xl group">
      <div className="relative mb-3">
        <img
          src={getCover()}
          alt={track.title}
          className="w-full aspect-square object-cover rounded-lg"
          onError={(e) => e.target.src = 'https://resources.tidal.com/images/ddd75a35/5b2d/409c/abe3/7368b34f02f0/1280x1280.jpg'}
        />
        <button 
          onClick={(e) => { e.stopPropagation(); onPlay(track); }}
          className="absolute bottom-2 right-2 bg-gradient-to-r from-purple-600 to-pink-600 rounded-full p-3 opacity-0 group-hover:opacity-100 transition-all transform translate-y-2 group-hover:translate-y-0 shadow-lg"
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
      </div>
      <h3 className="font-semibold truncate text-white">{track.title}</h3>
      <p className="text-sm text-gray-400 truncate">{getArtist()}</p>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-purple-400 font-semibold">
          {track.audioQuality || track.quality || 'HI_RES'}
        </span>
        {track.plays && (
          <span className="text-xs text-gray-500">{track.plays} plays</span>
        )}
      </div>
    </div>
  );
};

export default TrackCard;