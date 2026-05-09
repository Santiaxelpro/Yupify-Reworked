// src/services/api.js - Servicio de API para Yupify

// Base URL de la API
// En desarrollo por defecto apunta al backend local en http://localhost:3000
// Puedes sobrescribir con VITE_API_URL en .env
const DEFAULT_PROD_APIS = [
  'https://api-one.yupify.qzz.io',
  'https://api-two.yupify.qzz.io',
  'https://yupify-reworked.vercel.app',
  'https://yupify-reworked.onrender.com',
]

const DEFAULT_PROD_API = DEFAULT_PROD_APIS[0];

const normalizeApiUrl = (value) => {
  if (!value) return '';
  let url = String(value).trim();
  if (!url) return '';
  if (url.startsWith('VITE_API_URL=')) {
    url = url.slice('VITE_API_URL='.length).trim();
  }
  return url;
};

const isAbsoluteUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const joinUrl = (base, path) => {
  if (!base) return String(path || '');
  const baseTrim = String(base).replace(/\/+$/, '');
  const pathTrim = String(path || '').replace(/^\/+/, '');
  return `${baseTrim}/${pathTrim}`;
};

const resolveApiUrl = (value) => {
  if (!value) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  if (isAbsoluteUrl(raw)) return raw;
  return joinUrl(API_URL, raw);
};

export const buildApiUrl = (value) => resolveApiUrl(value);

const isLocalhostUrl = (value) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(value || '').trim());

const envApiUrl = normalizeApiUrl(import.meta.env.VITE_API_URL);
let API_URL = envApiUrl || (
  import.meta.env.DEV
    ? 'http://localhost:3000' // En local (npm run dev) usa el backend local
    : DEFAULT_PROD_API // En producci?n (Vercel) usa la m?scara
);

if (import.meta.env.PROD && isLocalhostUrl(API_URL)) {
  API_URL = DEFAULT_PROD_API;
}

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

const API_MEMORY_MAX = 120;
const apiMemoryCache = new Map();
const apiInFlight = new Map();

const trimMemoryMap = (map, maxEntries = API_MEMORY_MAX) => {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
};

const getMemoryCached = (key) => {
  const entry = apiMemoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    apiMemoryCache.delete(key);
    return null;
  }
  return entry.data;
};

const setMemoryCached = (key, data, ttl) => {
  apiMemoryCache.set(key, { data, expiresAt: Date.now() + ttl });
  trimMemoryMap(apiMemoryCache);
};

const requestJson = async (url, options = {}, settings = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  const ttl = Number(settings.ttl || 0);
  const dedupe = settings.dedupe !== false;
  const cacheable = method === 'GET' && ttl > 0;
  const key = `${method}:${url}`;

  if (cacheable) {
    const cached = getMemoryCached(key);
    if (cached) return cached;
  }

  if (dedupe && apiInFlight.has(key)) {
    return apiInFlight.get(key);
  }

  const promise = fetch(url, options)
    .then(handleResponse)
    .then(data => {
      if (cacheable) setMemoryCached(key, data, ttl);
      return data;
    })
    .finally(() => apiInFlight.delete(key));

  if (dedupe) {
    apiInFlight.set(key, promise);
    trimMemoryMap(apiInFlight);
  }

  return promise;
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
    const raw = data?.raw ?? data;
    if (raw?.token) {
      localStorage.setItem('yupify_token', raw.token);
    }
    if (raw?.user) {
      localStorage.setItem('yupify_user', JSON.stringify(raw.user));
    }
    return raw;
  },

  // Iniciar sesión
  login: async (email, password) => {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ email, password })
    });

    const data = await handleResponse(response);
    const raw = data?.raw ?? data;
    if (raw?.token) {
      localStorage.setItem('yupify_token', raw.token);
    }
    if (raw?.user) {
      localStorage.setItem('yupify_user', JSON.stringify(raw.user));
    }
    return raw;
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
    return requestJson(url, { headers: getHeaders() }, { ttl: 30_000 });
  },

  // Buscar por artista
  searchArtist: async (artist, limit = 20) => {
    const url = `${API_URL}/api/search?a=${encodeURIComponent(artist)}&limit=${limit}`;
    return requestJson(url, { headers: getHeaders() }, { ttl: 30_000 });
  },

  // Buscar por álbum
  searchAlbum: async (album, limit = 20) => {
    const url = `${API_URL}/api/search?al=${encodeURIComponent(album)}&limit=${limit}`;
    return requestJson(url, { headers: getHeaders() }, { ttl: 30_000 });
  },

  searchVideo: async (video, limit = 20) => {
    const url = `${API_URL}/api/search?v=${encodeURIComponent(video)}&limit=${limit}`;
    return requestJson(url, { headers: getHeaders() }, { ttl: 30_000 });
  },

  searchPlaylist: async (playlist, limit = 20) => {
    const url = `${API_URL}/api/search?p=${encodeURIComponent(playlist)}&limit=${limit}`;
    return requestJson(url, { headers: getHeaders() }, { ttl: 30_000 });
  }
};


// ==================== TRACKS ====================

export const trackService = {
  // Obtener información de track
  getTrack: async (trackId, quality = 'LOSSLESS', meta = null) => {
    const params = new URLSearchParams({ quality });
    if (meta) {
      const title = meta.title || meta.track || meta.name;
      const artist = Array.isArray(meta.artists) && meta.artists.length > 0
        ? meta.artists.map(a => a?.name || a).filter(Boolean).join(', ')
        : (meta.artist?.name || meta.artist);
      const album = meta.album?.title || meta.album?.name || meta.albumTitle;
      const cover = meta.album?.cover || meta.cover || meta.coverId;
      const coverUrl = meta.coverUrl || meta.albumArtUrl;
      if (title) params.set('title', title);
      if (artist) params.set('artist', artist);
      if (album) params.set('album', album);
      if (cover) params.set('cover', cover);
      if (coverUrl) params.set('coverUrl', coverUrl);
    }

    const data = await requestJson(
      `${API_URL}/api/track/${trackId}?${params.toString()}`,
      { headers: getHeaders() },
      { ttl: 90_000 }
    );

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

    const rawUrl = streamUrl || data.raw?.url || null;
    return {
      ...data.raw,
      url: resolveApiUrl(rawUrl)
    };
  },

  getLyrics: async (title, artist, options = {}) => {
    const params = new URLSearchParams({ track: title, artist: artist });
    if (options.id != null && options.id !== '') {
      params.set('id', String(options.id));
    }
    if (options.album) params.set('album', options.album);
    if (options.duration != null && options.duration !== '') {
      const durationValue = Number(options.duration);
      if (Number.isFinite(durationValue)) {
        params.set('duration', String(Math.round(durationValue)));
      }
    }
    if (options.source) params.set('source', options.source);
    if (options.sourcePrefer) params.set('sourcePrefer', options.sourcePrefer);
    if (options.sourceOnly) params.set('sourceOnly', options.sourceOnly);
    if (options.version) params.set('version', options.version);
    return requestJson(
      `${API_URL}/api/lyrics?${params.toString()}`,
      { headers: getHeaders() },
      { ttl: 5 * 60_000 }
    );
  },

  downloadTrack: async (track, quality = 'LOSSLESS') => {
    const trackId = track?.id ?? track?.trackId;
    if (!trackId) {
      throw new Error('Track inválido');
    }
    const response = await fetch(`${API_URL}/api/download/${trackId}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        quality,
        track
      })
    });

    if (!response.ok) {
      let errorMessage = `API error: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (e) {}
      throw new Error(errorMessage);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    let filename = null;
    const match = disposition.match(/filename="([^"]+)"/i) || disposition.match(/filename=([^;]+)/i);
    if (match) {
      filename = match[1].trim();
    }

    return { blob, filename };
  }
};

export const videoService = {
  getVideo: async (videoId, quality = 'HIGH', options = {}) => {
    const params = new URLSearchParams({
      quality,
      mode: String(options.mode || 'STREAM'),
      presentation: String(options.presentation || 'FULL')
    });

    return requestJson(
      `${API_URL}/api/video/${videoId}?${params.toString()}`,
      { headers: getHeaders() },
      { ttl: 60_000 }
    );
  }
};

// ==================== ÁLBUMES Y ARTISTAS ====================

export const albumService = {
  // Obtener álbum
  getAlbum: async (albumId) => {
    return requestJson(
      `${API_URL}/api/album/${albumId}`,
      { headers: getHeaders() },
      { ttl: 5 * 60_000 }
    );
  }
};

export const artistService = {
  // Obtener artista
  getArtist: async (artistId, full = false) => {
    const url = full 
      ? `${API_URL}/api/artist/${artistId}?f=1`
      : `${API_URL}/api/artist/${artistId}`;

    return requestJson(url, { headers: getHeaders() }, { ttl: 5 * 60_000 });
  }
};

// ==================== EXPLORAR ====================

export const exploreService = {
  // Obtener trending
  getTrending: async (limit = 20, offset = 0) => {
    return requestJson(
      `${API_URL}/api/trending?limit=${limit}&offset=${offset}`,
      { headers: getHeaders() },
      { ttl: 2 * 60_000 }
    );
  },

  // Obtener mix
  getMix: async (mixId, country = 'US') => {
    return requestJson(
      `${API_URL}/api/mix/${mixId}?country=${country}`,
      { headers: getHeaders() },
      { ttl: 5 * 60_000 }
    );
  },

  // Obtener top videos
  getTopVideos: async (limit = 12, offset = 0, options = {}) => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      countryCode: String(options.countryCode || 'US'),
      locale: String(options.locale || 'en_US'),
      deviceType: String(options.deviceType || 'BROWSER')
    });
    return requestJson(
      `${API_URL}/api/topvideos?${params.toString()}`,
      { headers: getHeaders() },
      { ttl: 2 * 60_000 }
    );
  },

  // Obtener portada
  getCover: async (id = null, query = null) => {
    const param = id ? `id=${id}` : `q=${encodeURIComponent(query)}`;
    return requestJson(
      `${API_URL}/api/cover?${param}`,
      { headers: getHeaders() },
      { ttl: 10 * 60_000 }
    );
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
    return requestJson(
      `${API_URL}/api/recommendations?${params.toString()}`,
      { headers: getHeaders() },
      { ttl: 60_000 }
    );
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
    if (response.status === 401) {
      localStorage.removeItem('yupify_token');
      localStorage.removeItem('yupify_user');
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
  video: videoService,
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
