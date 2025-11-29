// src/services/api.js - Servicio de API para Yupify

// Usar rutas relativas que van a través del proxy en producción
// En desarrollo: localhost:5173 -> localhost:3000 (vite proxy)
// En producción: vercel.app -> vercel (mismo dominio)
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

// ==================== UTILIDADES ====================

const getToken = () => {
  return localStorage.getItem('yupify_token');
};

const getHeaders = (includeAuth = false) => {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (includeAuth) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  return headers;
};

const handleResponse = async (response) => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Error desconocido' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
};

// ==================== AUTENTICACIÓN ====================

export const authService = {
  // Registrar usuario
  register: async (email, password, name) => {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email, password, name })
    });

    const data = await handleResponse(response);
    localStorage.setItem('yupify_token', data.token);
    localStorage.setItem('yupify_user', JSON.stringify(data.user));
    return data;
  },

  // Iniciar sesión
  login: async (email, password) => {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email, password })
    });

    const data = await handleResponse(response);
    localStorage.setItem('yupify_token', data.token);
    localStorage.setItem('yupify_user', JSON.stringify(data.user));
    return data;
  },

  // Cerrar sesión
  logout: () => {
    localStorage.removeItem('yupify_token');
    localStorage.removeItem('yupify_user');
  },

  // Obtener usuario actual
  getCurrentUser: () => {
    const user = localStorage.getItem('yupify_user');
    return user ? JSON.parse(user) : null;
  },

  // Verificar si está autenticado
  isAuthenticated: () => {
    return !!getToken();
  }
};

// ==================== BÚSQUEDA ====================

export const searchService = {
  // Buscar música
  search: async (query, limit = 20) => {
    const response = await fetch(
      `${API_URL}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  },

  // Buscar por artista
  searchArtist: async (artist, limit = 20) => {
    const response = await fetch(
      `${API_URL}/api/search?a=${encodeURIComponent(artist)}&limit=${limit}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  },

  // Buscar por álbum
  searchAlbum: async (album, limit = 20) => {
    const response = await fetch(
      `${API_URL}/api/search?al=${encodeURIComponent(album)}&limit=${limit}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  }
};

// ==================== TRACKS ====================

export const trackService = {
  // Obtener información de track
  getTrack: async (trackId, quality = 'LOSSLESS') => {
    const response = await fetch(
      `${API_URL}/api/track/${trackId}?quality=${quality}`,
      { headers: getHeaders() }
    );

    const data = await handleResponse(response);

    // 🔥 El backend devuelve un ARRAY con:
    // [0] -> metadata del track
    // [1] -> manifest info
    // [2] -> { OriginalTrackUrl }
    
    return {
      info: data[0],
      manifest: data[1],
      url: data[2]?.OriginalTrackUrl || null
    };
  },

  getLyrics: async (trackId) => {
    const response = await fetch(
      `${API_URL}/api/lyrics/${trackId}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  }
};

// ==================== ÁLBUMES Y ARTISTAS ====================

export const albumService = {
  // Obtener álbum
  getAlbum: async (albumId) => {
    const response = await fetch(
      `${API_URL}/api/album/${albumId}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  }
};

export const artistService = {
  // Obtener artista
  getArtist: async (artistId, full = false) => {
    const url = full 
      ? `${API_URL}/api/artist/${artistId}?f=1`
      : `${API_URL}/api/artist/${artistId}`;
    
    const response = await fetch(url, { headers: getHeaders() });
    return handleResponse(response);
  }
};

// ==================== EXPLORAR ====================

export const exploreService = {
  // Obtener home
  getHome: async (country = 'US') => {
    const response = await fetch(
      `${API_URL}/api/home?country=${country}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  },

  // Obtener mix
  getMix: async (mixId, country = 'US') => {
    const response = await fetch(
      `${API_URL}/api/mix/${mixId}?country=${country}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  },

  // Obtener portada
  getCover: async (id = null, query = null) => {
    const param = id ? `id=${id}` : `q=${encodeURIComponent(query)}`;
    const response = await fetch(
      `${API_URL}/api/cover?${param}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  }
};

// ==================== PLAYLISTS ====================

export const playlistService = {
  // Obtener playlists del usuario
  getMyPlaylists: async () => {
    const response = await fetch(
      `${API_URL}/api/user/playlists`,
      { headers: getHeaders(true) }
    );
    return handleResponse(response);
  },

  // Crear playlist
  createPlaylist: async (name, description = '', isPublic = true) => {
    const response = await fetch(`${API_URL}/api/user/playlists`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ name, description, isPublic })
    });
    return handleResponse(response);
  },

  // Agregar track a playlist
  addTrackToPlaylist: async (playlistId, trackId, trackData) => {
    const response = await fetch(
      `${API_URL}/api/user/playlists/${playlistId}/tracks`,
      {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ trackId, trackData })
      }
    );
    return handleResponse(response);
  },

  // Eliminar track de playlist
  removeTrackFromPlaylist: async (playlistId, trackId) => {
    const response = await fetch(
      `${API_URL}/api/user/playlists/${playlistId}/tracks/${trackId}`,
      {
        method: 'DELETE',
        headers: getHeaders(true)
      }
    );
    return handleResponse(response);
  },

  // Eliminar playlist
  deletePlaylist: async (playlistId) => {
    const response = await fetch(
      `${API_URL}/api/user/playlists/${playlistId}`,
      {
        method: 'DELETE',
        headers: getHeaders(true)
      }
    );
    return handleResponse(response);
  },

  // Obtener playlist pública de Tidal
  getTidalPlaylist: async (playlistId) => {
    const response = await fetch(
      `${API_URL}/api/playlist/${playlistId}`,
      { headers: getHeaders() }
    );
    return handleResponse(response);
  }
};

// ==================== FAVORITOS ====================

export const favoriteService = {
  // Obtener favoritos
  getFavorites: async () => {
    const response = await fetch(
      `${API_URL}/api/user/favorites`,
      { headers: getHeaders(true) }
    );
    return handleResponse(response);
  },

  // Agregar a favoritos
  addFavorite: async (trackId, trackData) => {
    const response = await fetch(`${API_URL}/api/user/favorites`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ trackId, trackData })
    });
    return handleResponse(response);
  },

  // Eliminar de favoritos
  removeFavorite: async (trackId) => {
    const response = await fetch(
      `${API_URL}/api/user/favorites/${trackId}`,
      {
        method: 'DELETE',
        headers: getHeaders(true)
      }
    );
    return handleResponse(response);
  },

  // Verificar si es favorito
  isFavorite: async (trackId) => {
    try {
      const { favorites } = await favoriteService.getFavorites();
      return favorites.some(f => f.id === trackId);
    } catch {
      return false;
    }
  }
};

// ==================== HISTORIAL ====================

export const historyService = {
  // Obtener historial
  getHistory: async (limit = 50) => {
    const response = await fetch(
      `${API_URL}/api/user/history?limit=${limit}`,
      { headers: getHeaders(true) }
    );
    return handleResponse(response);
  },

  // Agregar al historial
  addToHistory: async (trackId, trackData) => {
    const response = await fetch(`${API_URL}/api/user/history`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ trackId, trackData })
    });
    return handleResponse(response);
  },

  // Limpiar historial
  clearHistory: async () => {
    const response = await fetch(`${API_URL}/api/user/history`, {
      method: 'DELETE',
      headers: getHeaders(true)
    });
    return handleResponse(response);
  }
};

// ==================== ESTADÍSTICAS ====================

export const statsService = {
  // Obtener estadísticas del usuario
  getUserStats: async () => {
    const response = await fetch(
      `${API_URL}/api/user/stats`,
      { headers: getHeaders(true) }
    );
    return handleResponse(response);
  }
};

// ==================== UTILIDADES DE CACHÉ LOCAL ====================

export const cacheService = {
  // Guardar en caché
  set: (key, data, ttl = 3600000) => { // TTL por defecto: 1 hora
    const item = {
      data,
      expiry: Date.now() + ttl
    };
    localStorage.setItem(`yupify_cache_${key}`, JSON.stringify(item));
  },

  // Obtener de caché
  get: (key) => {
    const itemStr = localStorage.getItem(`yupify_cache_${key}`);
    if (!itemStr) return null;

    const item = JSON.parse(itemStr);
    
    // Verificar si expiró
    if (Date.now() > item.expiry) {
      localStorage.removeItem(`yupify_cache_${key}`);
      return null;
    }

    return item.data;
  },

  // Limpiar caché
  clear: () => {
    Object.keys(localStorage)
      .filter(key => key.startsWith('yupify_cache_'))
      .forEach(key => localStorage.removeItem(key));
  }
};

// ==================== EXPORTAR TODO ====================

export default {
  auth: authService,
  search: searchService,
  track: trackService,
  album: albumService,
  artist: artistService,
  explore: exploreService,
  playlist: playlistService,
  favorite: favoriteService,
  history: historyService,
  stats: statsService,
  cache: cacheService
};