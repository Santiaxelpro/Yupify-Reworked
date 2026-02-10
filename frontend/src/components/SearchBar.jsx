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

  return (
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
  );
};

export default SearchBar;
