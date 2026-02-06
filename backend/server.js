const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
// 🔥 Necesario para Render, Vercel, Cloudflare, Nginx, etc.
app.set("trust proxy", 1);

// Middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'https://yupify-reworked.vercel.app',
      'https://yupify-reworked.onrender.com'
    ];
    
    // Permitir si está en la lista, si no tiene origin (server-to-server), o si es wildcard
    if (!origin || allowedOrigins.includes(origin) || process.env.CORS_ORIGIN === '*' || process.env.CORS_ORIGIN === origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // límite de 100 requests por ventana
});
app.use('/api/', limiter);

// APIs de HiFi disponibles (del instances.json)
const HIFI_APIS = {
  monochrome: [
    'https://ohio.monochrome.tf',
    'https://virginia.monochrome.tf',
    'https://oregon.monochrome.tf',
    'https://california.monochrome.tf',
    'https://frankfurt.monochrome.tf',
    'https://london.monochrome.tf',
    'https://singapore.monochrome.tf',
    'https://jakarta.monochrome.tf'
  ],
  squid: [
    'https://triton.squid.wtf',
    'https://aether.squid.wtf',
    'https://zeus.squid.wtf',
    'https://kraken.squid.wtf',
    'https://phoenix.squid.wtf',
    'https://shiva.squid.wtf',
    'https://chaos.squid.wtf'
  ],
  lucida: [
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://katze.qqdl.site',
    'https://hund.qqdl.site'
  ],
  primary: [
    'https://hifi.401658.xyz'
  ],
  kinoplus: [
    'https://tidal.kinoplus.online/'
  ]
};

async function getRandomAPI() {
  const allAPIs = Object.values(HIFI_APIS).flat();
  const healthy = [];

  const checks = await Promise.allSettled(
    allAPIs.map(api => {
      const clean = api.replace(/\/+$/, "").trim();

      // Forzar https:// si no existe
      const fixed = clean.startsWith("http") ? clean : `https://${clean}`;

      return axios.get(`${fixed}/health`, { timeout: 3000 })
        .then(() => fixed)
        .catch(() => null);
    })
  );

  for (const c of checks) {
    if (c.status === "fulfilled" && c.value) healthy.push(c.value);
  }

  if (healthy.length === 0) {
    console.error("❌ No hay APIs HiFi disponibles");
    throw new Error("No hay APIs HiFi disponibles");
  }

  return healthy[Math.floor(Math.random() * healthy.length)];
}


// PROXY UNIVERSAL
async function forward(req, res, endpoint) {
  try {
    const API = await getRandomAPI();

    const cleanAPI = API.replace(/\/+$/, "");           // sin slash final
    const cleanEndpoint = endpoint.replace(/^\/+/, ""); // sin slash inicial

    const params = new URLSearchParams(req.query).toString();

    // Construir URL final correctamente
    const url =
      params
        ? `${cleanAPI}/${cleanEndpoint}?${params}`
        : `${cleanAPI}/${cleanEndpoint}`;

    console.log("→ Proxy:", url);

    const response = await axios.get(url, { timeout: 15000 });

    res.json(response.data);
  } catch (err) {
    console.error("Error en forward():", err.message);
    res.status(500).json({ error: "Error en el servidor proxy" });
  }
}

// Base de datos en memoria (en producción usar PostgreSQL/MongoDB)
const db = {
  users: new Map(),
  playlists: new Map(),
  favorites: new Map(),
  history: new Map(),
  sessions: new Map()
};

// Middleware de autenticación
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'yupify_secret_key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// ==================== RUTAS DE AUTENTICACIÓN ====================

// Registro
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    // Verificar si el usuario ya existe
    if (db.users.has(email)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }

    // Crear usuario (sin hash por desarrollo)
    const userId = `user_${Date.now()}`;
    const user = {
      id: userId,
      email,
      password, // Plain text for development
      name,
      createdAt: new Date().toISOString(),
      plan: 'free' // free, premium, family
    };

    db.users.set(email, user);
    db.playlists.set(userId, []);
    db.favorites.set(userId, []);
    db.history.set(userId, []);

    // Generar token
    const token = jwt.sign(
      { userId, email },
      process.env.JWT_SECRET || 'yupify_secret_key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: userId,
        email,
        name,
        plan: user.plan
      }
    });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const user = db.users.get(email);

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (password !== user.password) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'yupify_secret_key',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});


// ==================== PROXY A HIFI API ====================

// Búsqueda de tracks

// app.get('/api/song/:id', async (req, res) => {
//  try {
//    const { id } = req.params;
//    const q = req.query.quality || "LOSSLESS";
//
//    const api = await getRandomAPI();
//    const url = `${api}/song/?id=${id}&quality=${q}`;
//
//   console.log("→ Song v2:", url);
//
//    const response = await axios.get(url, { timeout: 15000 });
//
//    res.json(response.data); // manifest directo
//
//  } catch (err) {
//    console.error("Error /api/song:", err.message);
//    res.status(500).json({ error: "Error obteniendo canción" });
//  }
// });

app.get('/api/track/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Calidad solicitada
    const qRaw = (req.query.quality || "LOSSLESS").toUpperCase().trim();

    // Solo estas calidades
    const VALID_QUALITIES = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];

    // Si no existe, usar LOSSLESS
    const requestedQuality = VALID_QUALITIES.includes(qRaw) ? qRaw : "LOSSLESS";

    console.log(`\n>>> Calidad solicitada: ${qRaw} → intentando: ${requestedQuality}`);

    // Orden de fallback: si no encuentra la solicitada, intenta las siguientes
    const qualityFallback = {
      "HI_RES_LOSSLESS": ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"],
      "LOSSLESS": ["LOSSLESS", "HIGH", "LOW"],
      "HIGH": ["HIGH", "LOSSLESS", "LOW"],
      "LOW": ["LOW", "HIGH", "LOSSLESS"]
    };

    const qualitiesToTry = qualityFallback[requestedQuality] || [requestedQuality];

    // Todas las APIs
    const allAPIs = Object.values(HIFI_APIS).flat();

    // Intentar cada calidad en orden de fallback
    let success = null;
    let usedQuality = null;

    for (const quality of qualitiesToTry) {
      console.log(`   → Intentando calidad: ${quality}`);

      // Crear requests para esta calidad
      const requests = allAPIs.map(api => {
        const cleanApi = api.replace(/\/+$/, "");
        const url = `${cleanApi}/track/?id=${id}&quality=${quality}`;
        return axios.get(url, { timeout: 6000 })
          .then(r => ({ ok: true, url, data: r.data }))
          .catch(e => ({ ok: false, url, error: e.message }));
      });

      const results = await Promise.all(requests);

      // Buscar respuesta válida
      success = results.find(r =>
        r.ok &&
        r.data &&
        r.data.data &&
        r.data.data.manifestMimeType &&
        r.data.data.manifest
      );

      if (success) {
        usedQuality = quality;
        console.log(`✔️ Track encontrado en calidad: ${quality}`);
        break;
      }
    }

    if (!success) {
      return res.status(500).json({
        error: "No se pudo obtener el track en ninguna calidad",
        requestedQuality,
        attempedQualities: qualitiesToTry
      });
    }

    console.log(`✔️ Track OK desde: ${success.url} | Calidad: ${usedQuality}`);

    // Devolver la data real
      // Decodificar manifest si viene en base64
      const respData = { ...success.data.data };

      function tryDecodeManifest(m) {
        if (!m || typeof m !== 'string') return null;

        // Normalizar base64 URL-safe -> standard
        let b64 = m.replace(/\s+/g, '');
        b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
        // Añadir padding si es necesario
        const pad = b64.length % 4;
        if (pad === 2) b64 += '==';
        else if (pad === 3) b64 += '=';

        try {
          const decodedStr = Buffer.from(b64, 'base64').toString('utf8');
          try {
            return JSON.parse(decodedStr);
          } catch (e) {
            return decodedStr;
          }
        } catch (err) {
          return null;
        }
      }

      const decoded = tryDecodeManifest(respData.manifest);
      if (decoded !== null) {
        // Reemplazar manifest por el objeto/string decodificado (sin duplicar)
        respData.manifest = decoded;
        console.log('✔️ Manifest decodificado para track', respData.trackId || id);
      } else {
        console.log('ℹ️ No se pudo decodificar manifest para track', respData.trackId || id);
      }

      // Para FLAC/JSON: extraer URL simple del manifest
      let streamUrl = respData.url || null;
      
      if (!streamUrl && respData.manifest && typeof respData.manifest === 'object' && Array.isArray(respData.manifest.urls)) {
        // Si es JSON con urls array (FLAC/LOSSLESS/HIGH/LOW)
        streamUrl = respData.manifest.urls[0];
        respData.url = streamUrl;
        console.log('✔️ URL extraída del manifest JSON');
      }
      
      // Para HI_RES DASH: el manifest completo se envía tal cual
      // El frontend usará Shaka Player para reproducirlo
      if (respData.manifestMimeType === 'application/dash+xml') {
        console.log('✔️ HI_RES DASH manifest - será procesado por Shaka Player frontend');
        // No modificar: el frontend necesita el manifest completo
      }

      res.json({
        ...respData,
        requestedQuality: requestedQuality,
        usedQuality: usedQuality
      });

  } catch (error) {
    console.error("❌ Error en TRACK:", error.message);
    res.status(500).json({ error: "Error interno al obtener track" });
  }
});



// Obtener manifest DASH (Ya no usado, ahora /api/song/:id)

//app.get('/api/dash/:id', async (req, res) => {
//  try {
app.get('/api/search', async (req, res) => {
  try {
  const { q, s, a, al, type = 'tracks', limit = 20, offset = 0 } = req.query;

    // Construir parámetro de búsqueda (usa 's' como parámetro externo)
    let searchQuery = '';
    if (q) searchQuery = `s=${encodeURIComponent(q)}`;
    else if (s) searchQuery = `s=${encodeURIComponent(s)}`;
    else if (a) searchQuery = `a=${encodeURIComponent(a)}`;
    else if (al) searchQuery = `al=${encodeURIComponent(al)}`;

    if (!searchQuery) {
      return res.status(400).json({ error: 'Falta parámetro de búsqueda (q/s/a/al)' });
    }

    // Si se especifica SEARCH_API en env, usar solo esa URL
    const envSearch = process.env.SEARCH_API && process.env.SEARCH_API.trim()
      ? process.env.SEARCH_API.replace(/\/+$/, '')
      : null;

    if (envSearch) {
      const url = `${envSearch}/search/?${searchQuery}&li=${limit}&offset=${offset}`;
      console.log('→ Search via SEARCH_API:', url);
      const response = await axios.get(url, { timeout: 10000 });
      const remote = response.data || {};

      if (remote.data && Array.isArray(remote.data.items)) {
        return res.json({ version: remote.version || '2.4', data: { limit: remote.data.limit ?? Number(limit), offset: (remote.data.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.data.totalNumberOfItems ?? (remote.data.total ?? 0), items: remote.data.items } });
      }

      if (Array.isArray(remote.items)) {
        return res.json({ version: remote.version || '2.4', data: { limit: remote.limit ?? Number(limit), offset: (remote.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.total ?? remote.totalNumberOfItems ?? remote.items.length, items: remote.items } });
      }

      return res.json({ version: remote.version || '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] } });
    }

    // Por defecto: consultar todas las APIs listadas en HIFI_APIS en paralelo
    const allAPIs = Object.values(HIFI_APIS).flat().map(a => a.replace(/\/+$/, ''));

    const requests = allAPIs.map(api =>
      axios.get(`${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`, { timeout: 10000 })
        .then(r => ({ ok: true, api, data: r.data }))
        .catch(e => ({ ok: false, api, error: e.message }))
    );

    const responses = await Promise.all(requests);

    // Buscar la primera respuesta válida que contenga items en data
    const success = responses.find(r => r.ok && r.data && r.data.data && Array.isArray(r.data.data.items) && r.data.data.items.length > 0);

    if (success) {
      const remote = success.data;
      return res.json({ version: remote.version || '2.4', data: { limit: remote.data.limit ?? Number(limit), offset: (remote.data.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.data.totalNumberOfItems ?? ((remote.data.total ?? remote.data.items.length) || 0), items: remote.data.items } });
    }

    // Si no hay una respuesta clara, intentar combinar items desde todas las respuestas válidas
    const combinedItems = responses
      .filter(r => r.ok && r.data)
      .flatMap(r => r.data.data?.items ?? r.data.items ?? []);

    const uniqueItems = [];
    const seen = new Set();
    for (const item of combinedItems) {
      const idKey = item.id ?? item.trackId ?? JSON.stringify(item);
      if (!seen.has(idKey)) {
        seen.add(idKey);
        uniqueItems.push(item);
      }
    }

    return res.json({ version: '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: uniqueItems.length, items: uniqueItems } });
    } catch (error) {
      console.error('Error en búsqueda (combinada):', error?.message || error);
      return res.status(500).json({ error: 'Error al buscar', details: error?.message || String(error) });
    }
});

// Obtener álbum
app.get('/api/album/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const api = await getRandomAPI();


    const response = await axios.get(`${api}/album/?id=${id}`, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener álbum:', error.message);
    res.status(500).json({ error: 'Error al obtener álbum' });
  }
});

// Obtener artista
app.get('/api/artist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { f } = req.query; // full info
    const api = await getRandomAPI();


    const url = f ? `${api}/artist/?id=${id}&f=${f}` : `${api}/artist/?id=${id}`;
    const response = await axios.get(url, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener artista:', error.message);
    res.status(500).json({ error: 'Error al obtener artista' });
  }
});

// Obtener playlist
app.get('/api/playlist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const api = await getRandomAPI();


    const response = await axios.get(`${api}/playlist/?id=${id}`, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener playlist:', error.message);
    res.status(500).json({ error: 'Error al obtener playlist' });
  }
});

// ==================== LETRAS (LYRICSPLUS API) ====================
app.get('/api/lyrics', async (req, res) => {
  try {
    // Aceptar 'track' como alias para 'title'
    const { title, track, artist, album, duration, source } = req.query;
    const finalTitle = title || track;

    if (!finalTitle || !artist) {
      return res.status(400).json({
        error: "Faltan parámetros obligatorios: title (o track) y artist"
      });
    }

    const params = new URLSearchParams({
      title: finalTitle,
      artist,
      album: album || "",
      duration: duration || "",
      source: source || "apple,lyricsplus,musixmatch,spotify,musixmatch-word"
    });

    const url = `https://lyricsplus.prjktla.workers.dev/v2/lyrics/get?${params}`;

    console.log("→ Lyrics API:", url);

    const response = await axios.get(url, { timeout: 15000 });

    res.json(response.data);

  } catch (error) {
    console.error("Error en /api/lyrics:", error.message);
    res.status(500).json({ error: "Error obteniendo letras" });
  }
});


// Obtener portada
app.get('/api/cover', async (req, res) => {
  try {
    const { id, q } = req.query;
    const api = await getRandomAPI();


    const queryStr = id ? `id=${id}` : `q=${encodeURIComponent(q)}`;
    const response = await axios.get(`${api}/cover/?${queryStr}`, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener cover:', error.message);
    res.status(500).json({ error: 'Error al obtener cover' });
  }
});

// Obtener home/explorar
app.get('/api/home', async (req, res) => {
  try {
    const { country = 'US' } = req.query;
    const api = await getRandomAPI();


    const response = await axios.get(`${api}/home/?country=${country}`, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener home:', error.message);
    res.status(500).json({ error: 'Error al obtener home' });
  }
});

// Obtener mix personalizado
app.get('/api/mix/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { country = 'US' } = req.query;
    const api = await getRandomAPI();


    const response = await axios.get(`${api}/mix/?id=${id}&country=${country}`, {
      timeout: 10000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error al obtener mix:', error.message);
    res.status(500).json({ error: 'Error al obtener mix' });
  }
});

// ==================== PLAYLISTS (Requiere autenticación) ====================

// Obtener playlists del usuario
app.get('/api/user/playlists', authMiddleware, (req, res) => {
  try {
    const playlists = db.playlists.get(req.userId) || [];
    res.json({ playlists });
  } catch (error) {
    console.error('Error al obtener playlists:', error);
    res.status(500).json({ error: 'Error al obtener playlists' });
  }
});

// Crear playlist
app.post('/api/user/playlists', authMiddleware, (req, res) => {
  try {
    const { name, description, isPublic = true } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    const playlistId = `playlist_${Date.now()}`;
    const playlist = {
      id: playlistId,
      name,
      description: description || '',
      isPublic,
      tracks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const userPlaylists = db.playlists.get(req.userId) || [];
    userPlaylists.push(playlist);
    db.playlists.set(req.userId, userPlaylists);

    res.status(201).json({ playlist });
  } catch (error) {
    console.error('Error al crear playlist:', error);
    res.status(500).json({ error: 'Error al crear playlist' });
  }
});

// Agregar track a playlist
app.post('/api/user/playlists/:playlistId/tracks', authMiddleware, (req, res) => {
  try {
    const { playlistId } = req.params;
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    const userPlaylists = db.playlists.get(req.userId) || [];
    const playlist = userPlaylists.find(p => p.id === playlistId);

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    // Verificar si el track ya está en la playlist
    if (!playlist.tracks.some(t => t.id === trackId)) {
      playlist.tracks.push({
        id: trackId,
        ...trackData,
        addedAt: new Date().toISOString()
      });
      playlist.updatedAt = new Date().toISOString();
      db.playlists.set(req.userId, userPlaylists);
    }

    res.json({ playlist });
  } catch (error) {
    console.error('Error al agregar track:', error);
    res.status(500).json({ error: 'Error al agregar track' });
  }
});

// Eliminar track de playlist
app.delete('/api/user/playlists/:playlistId/tracks/:trackId', authMiddleware, (req, res) => {
  try {
    const { playlistId, trackId } = req.params;

    const userPlaylists = db.playlists.get(req.userId) || [];
    const playlist = userPlaylists.find(p => p.id === playlistId);

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    playlist.tracks = playlist.tracks.filter(t => t.id !== parseInt(trackId));
    playlist.updatedAt = new Date().toISOString();
    db.playlists.set(req.userId, userPlaylists);

    res.json({ playlist });
  } catch (error) {
    console.error('Error al eliminar track:', error);
    res.status(500).json({ error: 'Error al eliminar track' });
  }
});

// Eliminar playlist
app.delete('/api/user/playlists/:playlistId', authMiddleware, (req, res) => {
  try {
    const { playlistId } = req.params;

    const userPlaylists = db.playlists.get(req.userId) || [];
    const filteredPlaylists = userPlaylists.filter(p => p.id !== playlistId);

    if (userPlaylists.length === filteredPlaylists.length) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    db.playlists.set(req.userId, filteredPlaylists);
    res.json({ message: 'Playlist eliminada' });
  } catch (error) {
    console.error('Error al eliminar playlist:', error);
    res.status(500).json({ error: 'Error al eliminar playlist' });
  }
});

// ==================== FAVORITOS ====================

// Obtener favoritos
app.get('/api/user/favorites', authMiddleware, (req, res) => {
  try {
    const favorites = db.favorites.get(req.userId) || [];
    res.json({ favorites });
  } catch (error) {
    console.error('Error al obtener favoritos:', error);
    res.status(500).json({ error: 'Error al obtener favoritos' });
  }
});

// Agregar a favoritos
app.post('/api/user/favorites', authMiddleware, (req, res) => {
  try {
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    const favorites = db.favorites.get(req.userId) || [];
    
    // Verificar si ya está en favoritos
    if (!favorites.some(f => f.id === trackId)) {
      favorites.push({
        id: trackId,
        ...trackData,
        addedAt: new Date().toISOString()
      });
      db.favorites.set(req.userId, favorites);
    }

    res.json({ favorites });
  } catch (error) {
    console.error('Error al agregar favorito:', error);
    res.status(500).json({ error: 'Error al agregar favorito' });
  }
});

// Eliminar de favoritos
app.delete('/api/user/favorites/:trackId', authMiddleware, (req, res) => {
  try {
    const { trackId } = req.params;

    const favorites = db.favorites.get(req.userId) || [];
    const filtered = favorites.filter(f => f.id !== parseInt(trackId));
    db.favorites.set(req.userId, filtered);

    res.json({ favorites: filtered });
  } catch (error) {
    console.error('Error al eliminar favorito:', error);
    res.status(500).json({ error: 'Error al eliminar favorito' });
  }
});

// ==================== HISTORIAL ====================

// Obtener historial
app.get('/api/user/history', authMiddleware, (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const history = (db.history.get(req.userId) || []).slice(0, parseInt(limit));
    res.json({ history });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// Agregar al historial
app.post('/api/user/history', authMiddleware, (req, res) => {
  try {
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    const history = db.history.get(req.userId) || [];
    
    // Agregar al inicio del historial
    history.unshift({
      id: trackId,
      ...trackData,
      playedAt: new Date().toISOString()
    });

    // Mantener solo los últimos 100
    if (history.length > 100) {
      history.pop();
    }

    db.history.set(req.userId, history);
    res.json({ message: 'Agregado al historial' });
  } catch (error) {
    console.error('Error al agregar al historial:', error);
    res.status(500).json({ error: 'Error al agregar al historial' });
  }
});

// Limpiar historial
app.delete('/api/user/history', authMiddleware, (req, res) => {
  try {
    db.history.set(req.userId, []);
    res.json({ message: 'Historial limpiado' });
  } catch (error) {
    console.error('Error al limpiar historial:', error);
    res.status(500).json({ error: 'Error al limpiar historial' });
  }
});

// ==================== ESTADÍSTICAS ====================

// Obtener estadísticas del usuario
app.get('/api/user/stats', authMiddleware, (req, res) => {
  try {
    const playlists = db.playlists.get(req.userId) || [];
    const favorites = db.favorites.get(req.userId) || [];
    const history = db.history.get(req.userId) || [];

    // Calcular artistas más escuchados
    const artistCounts = {};
    history.forEach(track => {
      const artist = track.artist || 'Unknown';
      artistCounts[artist] = (artistCounts[artist] || 0) + 1;
    });

    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, count]) => ({ artist, plays: count }));

    // Calcular tiempo total de escucha
    const totalMinutes = Math.floor(history.reduce((sum, track) => sum + (track.duration || 0), 0) / 60);

    const stats = {
      totalPlaylists: playlists.length,
      totalFavorites: favorites.length,
      totalPlays: history.length,
      totalMinutes,
      topArtists,
      recentlyPlayed: history.slice(0, 10)
    };

    res.json(stats);
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    apis: Object.keys(HIFI_APIS),
    users: db.users.size
  });
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    app: 'Yupify API',
    version: '1.0.0',
    description: 'Backend proxy para Yupify - Streaming de música de alta calidad',
    endpoints: {
      auth: ['/api/auth/register', '/api/auth/login'],
      music: ['/api/search', '/api/track/:id', '/api/album/:id', '/api/artist/:id'],
      user: ['/api/user/playlists', '/api/user/favorites', '/api/user/history', '/api/user/stats'],
      proxy: ['/api/dash/:id', '/api/lyrics/:id', '/api/cover', '/api/home', '/api/mix/:id']
    }
  });
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🎵 Yupify Backend iniciado en http://localhost:${PORT}`);
  console.log(`📡 APIs disponibles: ${Object.keys(HIFI_APIS).join(', ')}`);
  console.log(`🔒 Autenticación: JWT`);
  console.log(`💾 Base de datos: En memoria (usar PostgreSQL/MongoDB en producción)`);
});

module.exports = app;