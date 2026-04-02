// src/components/SearchBar.jsx
import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';

const SEARCH_TABS = [
  { id: 'tracks', label: 'Canciones' },
  { id: 'artists', label: 'Artistas' },
  { id: 'albums', label: 'Álbumes' },
  { id: 'videos', label: 'Videos' },
  { id: 'playlists', label: 'Playlists' }
];

const SearchBar = ({ onSearch, loading, activeCategory = 'tracks', onCategoryChange = () => {}, query: controlledQuery = '', counts = {} }) => {
  const [query, setQuery] = useState('');

  useEffect(() => {
    setQuery(controlledQuery || '');
  }, [controlledQuery]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query);
    }
  };

  const handleCategoryClick = (category) => {
    onCategoryChange(category);
  };

  return (
    <div className="w-full space-y-3">
      <form onSubmit={handleSubmit} className="flex gap-3 items-center w-full">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar canciones, artistas, álbumes..."
            disabled={loading}
            className="w-full h-12 bg-gray-900 rounded-full pl-12 pr-4 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-600 border border-gray-800 disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="h-12 bg-green-600 hover:bg-green-700 rounded-full px-8 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
        >
          {loading ? 'Buscando...' : 'Buscar'}
        </button>
      </form>
      <div className="flex flex-wrap gap-2">
        {SEARCH_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleCategoryClick(tab.id)}
            className={`px-4 py-2 rounded-full text-sm border transition-all ${
              activeCategory === tab.id
                ? 'bg-green-600 border-green-500 text-white'
                : 'bg-gray-900 border-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'
            }`}
          >
            {tab.label}
            {Number.isFinite(counts?.[tab.id]) ? ` · ${counts[tab.id]}` : ''}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SearchBar;
