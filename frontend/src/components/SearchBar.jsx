// src/components/SearchBar.jsx
import React, { useState } from 'react';
import { Search } from 'lucide-react';

const SearchBar = ({ onSearch, loading }) => {
  const [query, setQuery] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSubmit(e);
    }
  };

  return (
    <div className="flex gap-2">
      <div className="flex-1 relative">
        <Search className="absolute left-3 top-3 text-gray-400" size={20} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Buscar canciones, artistas, álbumes..."
          disabled={loading}
          className="w-full bg-gray-900 rounded-full py-3 pl-12 pr-4 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-600 border border-gray-800 disabled:opacity-50"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={loading || !query.trim()}
        className="bg-green-600 hover:bg-green-700 rounded-full px-8 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
      >
        {loading ? 'Buscando...' : 'Buscar'}
      </button>
    </div>
  );
};

export default SearchBar;