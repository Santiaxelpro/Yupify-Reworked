// src/services/api.js - Servicio de API para Yupify

// Base URL de la API
// En desarrollo por defecto apunta al backend local en http://localhost:3000
// Puedes sobrescribir con VITE_API_URL en .env
const API_URL = import.meta.env.VITE_API_URL || (
  import.meta.env.DEV 
    ? 'http://localhost:3000' // En local (npm run dev)
    : 'https://yupify-reworked.vercel.app'   // En producción (Vercel) usa la máscara
);

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
  // Buscar música (query general)
  search: async (query, limit = 20) => {
    const url = `${API_URL}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    const response = await fetch(url, {
      headers: getHeaders(),
    });

    return handleResponse(response); // <-- ahora devuelve items, total, offset, raw
  },

  // Buscar por artista
  searchArtist: async (artist, limit = 20) => {
    const url = `${API_URL}/api/search?a=${encodeURIComponent(artist)}&limit=${limit}`;

    const response = await fetch(url, {
      headers: getHeaders(),
    });

    return handleResponse(response);
  },

  // Buscar por álbum
  searchAlbum: async (album, limit = 20) => {
    const url = `${API_URL}/api/search?al=${encodeURIComponent(album)}&limit=${limit}`;

    const response = await fetch(url, {
      headers: getHeaders(),
    });

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

    // El backend devuelve un objeto con manifest (decodificado) y URLs
    // Extraer la URL de streaming del manifest
    let streamUrl = null;
    
    // Primero revisar si ya viene url en respData
    if (data.raw && data.raw.url) {
      streamUrl = data.raw.url;
    } 
    // Si no, extraer de manifest
    else if (data.raw && data.raw.manifest) {
      const manifest = data.raw.manifest;
      // Si manifest es objeto con urls array
      if (manifest && typeof manifest === 'object' && Array.isArray(manifest.urls)) {
        streamUrl = manifest.urls[0];
      }
      // Si manifest es string JSON (decodificado)
      else if (typeof manifest === 'string' && manifest.startsWith('{')) {
        try {
          const parsed = JSON.parse(manifest);
          if (Array.isArray(parsed.urls)) streamUrl = parsed.urls[0];
        } catch (e) {
          console.warn('No se pudo parsear manifest JSON:', e);
        }
      }
      // Si es string XML DASH, ya debería venir la URL extraída en data.raw.url
    }

    return {
      ...data.raw,
      url: streamUrl || data.raw?.url || null
    };
  },

  getLyrics: async (title, artist) => {
    const params = new URLSearchParams({ track: title, artist: artist });
    const response = await fetch(
      `${API_URL}/api/lyrics?${params.toString()}`,
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

  // Obtener trending
  getTrending: async (limit = 20, offset = 0) => {
    const response = await fetch(
      `${API_URL}/api/trending?limit=${limit}&offset=${offset}`,
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

// ==================== RECOMENDACIONES ====================

export const recommendationsService = {
  getRecommendations: async (trackId, limit = 20, offset = 0) => {
    const params = new URLSearchParams({
      id: trackId,
      limit: String(limit),
      offset: String(offset)
    });
    const response = await fetch(
      `${API_URL}/api/recommendations?${params.toString()}`,
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
      const { items } = await favoriteService.getFavorites();
      return items.some(f => f.id === trackId);
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

// ==================== MANEJO UNIFICADO DE RESPUESTAS ====================

async function handleResponse(response) {
  if (!response.ok) {
    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.error || errorMessage;
    } catch (e) {
      // Si no se puede parsear el JSON, mantenemos el error genérico
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();

  // Normalizar estructura de Yupify API -> Frontend
  const normalized = {
    items: data?.data?.items ?? data?.items ?? [],
    total: data?.data?.totalNumberOfItems ?? data?.total ?? 0,
    limit: data?.data?.limit ?? data?.limit ?? 0,
    offset: data?.data?.offset ?? data?.offset ?? 0,
    raw: data
  };

  return normalized;
}


// ==================== EXPORTAR TODO ====================

export default {
  auth: authService,
  search: searchService,
  track: trackService,
  album: albumService,
  artist: artistService,
  explore: exploreService,
  recommendations: recommendationsService,
  playlist: playlistService,
  favorite: favoriteService,
  history: historyService,
  stats: statsService,
  cache: cacheService
};
