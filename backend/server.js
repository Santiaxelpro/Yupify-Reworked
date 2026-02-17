const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: '/etc/secrets/.env' });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
// 🔥 Necesario para Render, Vercel, Cloudflare, Nginx, etc.
app.set("trust proxy", 1);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const axiosFast = axios.create({ httpAgent, httpsAgent });

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
let pool = null;

if (USE_POSTGRES) {
  const pgConfig = {
    connectionString: process.env.DATABASE_URL
  };

  const needsSSL = process.env.PGSSL === 'true'
    || process.env.NODE_ENV === 'production'
    || (process.env.DATABASE_URL || '').includes('render.com');

  if (needsSSL) {
    pgConfig.ssl = { rejectUnauthorized: false };
  }

  pool = new Pool(pgConfig);
}

// Cache simple en memoria para search/track
const CACHE_TTL = {
  search: 60 * 1000,
  track: 5 * 60 * 1000,
  lyrics: 10 * 60 * 1000
};
const cacheStore = new Map();

const getCache = (key) => {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
};

const setCache = (key, value, ttlMs) => {
  cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
};
const FAST_SEARCH_POOL = 4;
const FAST_TRACK_POOL = 4;
const SEARCH_TIMEOUT_MS = 4500;
const TRACK_TIMEOUT_MS = 4500;


// Cache simple en memoria para trending
const TRENDING_TTL_MS = 15 * 60 * 1000;
const TRENDING_TARGET = 600;
const TRENDING_BATCH = 8;
// LatAm + hispanohablantes (incluye EspaÃ±a)
const TRENDING_COUNTRIES = [
  'ar', 'bo', 'br', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'es', 'gt', 'hn',
  'mx', 'ni', 'pa', 'pe', 'pr', 'py', 'sv', 'uy', 've'
];
let trendingState = { ts: 0, seeds: [], seedCursor: 0, items: [], seenIds: new Set() };

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
    'https://eu-central.monochrome.tf',
    'https://us-west.monochrome.tf',
    'https://arran.monochrome.tf',
    'https://api.monochrome.tf',
    'https://monochrome-api.samidy.com',
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
  community: [
    'https://tidal-api.binimum.org',
    'https://hifi-one.spotisaver.net',
    'https://hifi-two.spotisaver.net'
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

      return axios.get(`${fixed}`, { timeout: 3000 })
        .then(resp => {
          const data = resp?.data;
          const version = data?.version;
          const repo = data?.Repo || data?.repo || data?.repository;
          if ((version === "2.4" || version === "2.2") && repo === "https://github.com/uimaxbai/hifi-api") {
            return fixed;
          }
          return null;
        })
        .catch(() => null);
    })
  );

  for (const c of checks) {
    if (c.status === "fulfilled" && c.value) healthy.push(c.value);
  }

  if (healthy.length === 0) {
    console.error("No hay APIs HiFi disponibles");
    throw new Error("No hay APIs HiFi disponibles");
  }

  return healthy[Math.floor(Math.random() * healthy.length)];
}

async function searchInAPI(apiBase, query, limit = 1) {
  if (!apiBase || !query) return null;
  const url = `${apiBase.replace(/\/+$/, '')}/search/?s=${encodeURIComponent(query)}&li=${limit}&offset=0`;
  const response = await axios.get(url, { timeout: 10000 });
  const data = response.data || {};
  const items = data?.data?.items ?? data?.items ?? [];
  return items[0] || null;
}

async function searchAnyAPI(query, limit = 1) {
  if (!query) return [];

  const envSearch = process.env.SEARCH_API && process.env.SEARCH_API.trim()
    ? process.env.SEARCH_API.replace(/\/+$/, '')
    : null;

  if (envSearch) {
    const url = `${envSearch}/search/?s=${encodeURIComponent(query)}&li=${limit}&offset=0`;
    const response = await axios.get(url, { timeout: 10000 });
    const remote = response.data || {};
    const items = remote?.data?.items ?? remote?.items ?? [];
    return Array.isArray(items) ? items : [];
  }

  const allAPIs = Object.values(HIFI_APIS).flat().map(a => a.replace(/\/+$/, ''));
  const requests = allAPIs.map(api =>
    axios.get(`${api}/search/?s=${encodeURIComponent(query)}&li=${limit}&offset=0`, { timeout: 10000 })
      .then(r => ({ ok: true, data: r.data }))
      .catch(() => ({ ok: false }))
  );

  const responses = await Promise.all(requests);
  const success = responses.find(r => r.ok && r.data && r.data.data && Array.isArray(r.data.data.items) && r.data.data.items.length > 0);
  if (success) {
    return success.data.data.items;
  }

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

  return uniqueItems;
}

async function fetchRecommendationsFromAPIs(params) {
  const allAPIs = Object.values(HIFI_APIS).flat().map(a => a.replace(/\/+$/, ''));
  const requests = allAPIs.map(api =>
    axios.get(`${api}/recommendations/?${params}`, { timeout: 10000 })
      .then(r => ({ ok: true, api, data: r.data }))
      .catch(e => ({ ok: false, api, error: e.message }))
  );

  const responses = await Promise.all(requests);
  const success = responses.find(r => {
    if (!r.ok || !r.data) return false;
    const items = r.data?.data?.items ?? r.data?.items ?? r.data?.data;
    return Array.isArray(items) && items.length > 0;
  });
  if (success) return success.data;

  const fallback = responses.find(r => r.ok && r.data);
  return fallback ? fallback.data : null;
}

function normalizeSeedKey(title, artist) {
  const t = (title || '').toString().toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = (artist || '').toString().toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${t}|${a}`;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function fetchFirstSearchResult({ apis, searchQuery, limit, offset, timeoutMs = 4500 }) {
  const requests = apis.map(api => (
    axiosFast.get(`${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`, { timeout: timeoutMs })
      .then(r => {
        const data = r.data || {};
        const items = data?.data?.items ?? data?.items ?? [];
        if (Array.isArray(items) && items.length > 0) {
          return data;
        }
        return Promise.reject(new Error('No items'));
      })
  ));

  try {
    return await Promise.any(requests);
  } catch {
    return null;
  }
}

async function fetchFirstTrackData({ apis, id, quality, timeoutMs = 4500 }) {
  const requests = apis.map(api => {
    const cleanApi = api.replace(/\/+$/, "");
    const url = `${cleanApi}/track/?id=${id}&quality=${quality}`;
    return axiosFast.get(url, { timeout: timeoutMs })
      .then(r => {
        const data = r.data;
        if (data && data.data && data.data.manifestMimeType && data.data.manifest) {
          return { ok: true, url, data: data.data };
        }
        return Promise.reject(new Error('Invalid track'));
      });
  });

  try {
    return await Promise.any(requests);
  } catch {
    return null;
  }
}


async function fetchDeezerSeeds() {
  try {
    const url = 'https://api.deezer.com/chart/0/tracks?limit=100&index=0';
    const resp = await axios.get(url, { timeout: 10000 });
    const tracks = resp.data?.data ?? [];
    return tracks.map(t => ({
      title: t?.title,
      artist: t?.artist?.name
    })).filter(t => t.title && t.artist);
  } catch (e) {
    console.error('Error Deezer seeds:', e.message);
    return [];
  }
}

async function fetchITunesSeeds(country, limit = 100) {
  try {
    const url = `https://itunes.apple.com/${country}/rss/topsongs/limit=${limit}/json`;
    const resp = await axios.get(url, { timeout: 10000 });
    const entries = resp.data?.feed?.entry ?? [];
    return entries.map(e => ({
      title: e?.['im:name']?.label || e?.title?.label,
      artist: e?.['im:artist']?.label
    })).filter(t => t.title && t.artist);
  } catch (e) {
    return [];
  }
}

async function buildTrendingSeeds() {
  const deezer = await fetchDeezerSeeds();
  const itunesLists = await Promise.all(TRENDING_COUNTRIES.map(c => fetchITunesSeeds(c, 100)));
  const itunes = itunesLists.flat();

  const seen = new Set();
  const merged = [];
  for (const seed of [...deezer, ...itunes]) {
    const key = normalizeSeedKey(seed.title, seed.artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(seed);
  }

  return shuffleArray(merged);
}

async function ensureTrendingItems(targetCount) {
  while (trendingState.items.length < targetCount && trendingState.seedCursor < trendingState.seeds.length) {
    const batch = trendingState.seeds.slice(trendingState.seedCursor, trendingState.seedCursor + TRENDING_BATCH);
    trendingState.seedCursor += batch.length;

    const results = await Promise.all(batch.map(seed => {
      const query = [seed.title, seed.artist].filter(Boolean).join(' ');
      return searchAnyAPI(query, 1)
        .then(items => (items && items.length > 0 ? items[0] : null))
        .catch(() => null);
    }));

    results.forEach(item => {
      if (!item || item.id == null) return;
      if (trendingState.seenIds.has(item.id)) return;
      trendingState.seenIds.add(item.id);
      trendingState.items.push(item);
    });

    if (trendingState.items.length >= TRENDING_TARGET) break;
  }
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

// Base de datos en memoria (fallback si no hay PostgreSQL)
const db = {
  users: new Map(),
  playlists: new Map(),
  favorites: new Map(),
  history: new Map(),
  sessions: new Map()
};

const toIso = (value) => {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
};

const parseJsonValue = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_public BOOLEAN NOT NULL DEFAULT TRUE,
      tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      track_data JSONB NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, track_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      track_data JSONB NOT NULL,
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);');
}

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

if (pool) {
  initDb()
    .then(() => {
      console.log('PostgreSQL listo');
    })
    .catch(err => {
      console.error('Error inicializando PostgreSQL:', err.message);
    });
}

// ==================== RUTAS DE AUTENTICACIÓN ====================

// Registro
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (pool) {
      const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rowCount > 0) {
        return res.status(409).json({ error: 'El usuario ya existe' });
      }

      const userId = `user_${Date.now()}`;
      const user = {
        id: userId,
        email,
        password,
        name,
        createdAt: new Date().toISOString(),
        plan: 'free'
      };

      await pool.query(
        'INSERT INTO users (id, email, password, name, plan, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, user.email, user.password, user.name, user.plan, user.createdAt]
      );

      res.status(201).json({
        token: jwt.sign(
          { userId: user.id, email: user.email },
          process.env.JWT_SECRET || 'yupify_secret_key',
          { expiresIn: '7d' }
        ),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan
        }
      });

      return;
    }

    // Verificar si el usuario ya existe (memoria)
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

    if (pool) {
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (result.rowCount === 0) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      const user = result.rows[0];

      if (password !== user.password) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET || 'yupify_secret_key',
        { expiresIn: '7d' }
      );

      return res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan || 'free'
        }
      });
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
    const cacheKey = `track:${id}|q:${requestedQuality}`;

    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

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
    const shuffledAPIs = shuffleArray(allAPIs);
    const fastAPIs = shuffledAPIs.slice(0, FAST_TRACK_POOL);

    // Intentar cada calidad en orden de fallback
    let success = null;
    let usedQuality = null;

    for (const quality of qualitiesToTry) {
      console.log(`   -> Intentando calidad: ${quality}`);

      success = await fetchFirstTrackData({ apis: fastAPIs, id, quality, timeoutMs: TRACK_TIMEOUT_MS });
      if (!success) {
        success = await fetchFirstTrackData({ apis: allAPIs, id, quality, timeoutMs: TRACK_TIMEOUT_MS });
      }

      if (success) {
        usedQuality = quality;
        console.log(`OK Track encontrado en calidad: ${quality}`);
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
      const respData = { ...success.data };

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

      const payload = {
        ...respData,
        requestedQuality: requestedQuality,
        usedQuality: usedQuality
      };
      setCache(cacheKey, payload, CACHE_TTL.track);
      return res.json(payload);

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

    const cacheKey = `search:${searchQuery}|li:${limit}|offset:${offset}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    if (envSearch) {
      const url = `${envSearch}/search/?${searchQuery}&li=${limit}&offset=${offset}`;
      console.log('-> Search via SEARCH_API:', url);
      const response = await axiosFast.get(url, { timeout: SEARCH_TIMEOUT_MS });
      const remote = response.data || {};

      let payload = null;
      if (remote.data && Array.isArray(remote.data.items)) {
        payload = { version: remote.version || '2.4', data: { limit: remote.data.limit ?? Number(limit), offset: (remote.data.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.data.totalNumberOfItems ?? (remote.data.total ?? 0), items: remote.data.items } };
      } else if (Array.isArray(remote.items)) {
        payload = { version: remote.version || '2.4', data: { limit: remote.limit ?? Number(limit), offset: (remote.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.total ?? remote.totalNumberOfItems ?? remote.items.length, items: remote.items } };
      } else {
        payload = { version: remote.version || '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] } };
      }

      setCache(cacheKey, payload, CACHE_TTL.search);
      return res.json(payload);
    }

    // Por defecto: consultar todas las APIs listadas en HIFI_APIS en paralelo
    const allAPIs = Object.values(HIFI_APIS).flat().map(a => a.replace(/\/+$/, ''));

    const shuffledAPIs = shuffleArray(allAPIs);
    const fastAPIs = shuffledAPIs.slice(0, FAST_SEARCH_POOL);
    const fastRemote = await fetchFirstSearchResult({ apis: fastAPIs, searchQuery, limit, offset, timeoutMs: SEARCH_TIMEOUT_MS });
    if (fastRemote) {
      const items = fastRemote?.data?.items ?? fastRemote?.items ?? [];
      const payload = { version: fastRemote.version || '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: items.length, items } };
      setCache(cacheKey, payload, CACHE_TTL.search);
      return res.json(payload);
    }

    const requests = allAPIs.map(api =>
      axiosFast.get(`${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`, { timeout: SEARCH_TIMEOUT_MS })
        .then(r => ({ ok: true, api, data: r.data }))
        .catch(e => ({ ok: false, api, error: e.message }))
    );

    const responses = await Promise.all(requests);

    // Buscar la primera respuesta válida que contenga items en data
    const success = responses.find(r => r.ok && r.data && r.data.data && Array.isArray(r.data.data.items) && r.data.data.items.length > 0);

    if (success) {
      const remote = success.data;
      const payload = { version: remote.version || '2.4', data: { limit: remote.data.limit ?? Number(limit), offset: (remote.data.offset ?? Number(offset)) || 0, totalNumberOfItems: remote.data.totalNumberOfItems ?? ((remote.data.total ?? remote.data.items.length) || 0), items: remote.data.items } };
      setCache(cacheKey, payload, CACHE_TTL.search);
      return res.json(payload);
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

    const payload = { version: '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: uniqueItems.length, items: uniqueItems } };
    setCache(cacheKey, payload, CACHE_TTL.search);
    return res.json(payload);
    } catch (error) {
      console.error('Error en búsqueda (combinada):', error?.message || error);
      return res.status(500).json({ error: 'Error al buscar', details: error?.message || String(error) });
    }
});

// Recomendaciones por track
app.get('/api/recommendations', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Falta parÃ¡metro id' });
    }

    const params = new URLSearchParams(req.query);
    if (req.query.limit && !req.query.li) {
      params.set('li', req.query.limit);
    }
    if (req.query.li && !req.query.limit) {
      params.set('limit', req.query.li);
    }

    const remote = await fetchRecommendationsFromAPIs(params.toString());
    if (!remote) {
      return res.json({ version: '2.4', data: { limit: 0, offset: 0, totalNumberOfItems: 0, items: [] } });
    }

    const items = remote?.data?.items ?? remote?.items ?? remote?.data ?? [];
    if (Array.isArray(items)) {
      const normalizedItems = items.map(item => {
        if (item && item.id == null && item.trackId != null) {
          return { ...item, id: item.trackId };
        }
        return item;
      });

      return res.json({
        version: remote?.version || '2.4',
        data: {
          limit: Number(req.query.limit ?? req.query.li) || items.length,
          offset: Number(req.query.offset) || 0,
          totalNumberOfItems: normalizedItems.length,
          items: normalizedItems
        }
      });
    }

    return res.json(remote);
  } catch (error) {
    console.error('Error en recomendaciones:', error?.message || error);
    return res.status(500).json({ error: 'Error al obtener recomendaciones' });
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

    const cacheKey = `lyrics:${finalTitle}|${artist}|${album || ""}|${duration || ""}|${source || ""}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const buildArtistVariants = (raw) => {
      const base = (raw || '').toString().trim();
      if (!base) return [];
      const variants = [base];
      if (base.includes(',') && !base.includes('&')) {
        const parts = base.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1];
          const head = parts.slice(0, -1).join(', ');
          variants.push(`${head} & ${last}`);
          variants.push(parts.join(' & '));
        }
      }
      return Array.from(new Set(variants));
    };

    let artistVariants = buildArtistVariants(artist);
    artistVariants = artistVariants.sort((a, b) => {
      const aScore = a.includes('&') ? 0 : 1;
      const bScore = b.includes('&') ? 0 : 1;
      return aScore - bScore;
    });
    const albumVariants = album ? [album] : ["", finalTitle];
    const durationVariants = duration ? [duration] : [""];
    const baseSource = source || "apple,lyricsplus,musixmatch,spotify,musixmatch-word";

    const paramsVariants = [];
    const seenParams = new Set();
    for (const art of artistVariants) {
      for (const alb of albumVariants) {
        for (const dur of durationVariants) {
          const paramsObj = {
            title: finalTitle,
            artist: art,
            album: alb || "",
            duration: dur || "",
            source: baseSource
          };
          const key = JSON.stringify(paramsObj);
          if (seenParams.has(key)) continue;
          seenParams.add(key);
          paramsVariants.push(paramsObj);
        }
      }
    }

    const MAX_VARIANTS = 4;
    const paramsToTry = paramsVariants.slice(0, MAX_VARIANTS);

    const lyricsSources = [
      'https://lyricsplus.binimum.org/v2/lyrics/get',
      'https://lyricsplus.prjktla.workers.dev/v2/lyrics/get'
    ];

    let lastError = null;
    let sawRateLimit = false;
    for (const baseUrl of lyricsSources) {
      for (const paramsObj of paramsToTry) {
        const url = `${baseUrl}?${new URLSearchParams(paramsObj)}`;
        console.log("-> Lyrics API:", url);
        try {
          const response = await axios.get(url, { timeout: 15000 });
          let payload = response.data;
          if (typeof payload === 'string') {
            const trimmed = payload.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
              try {
                payload = JSON.parse(trimmed);
              } catch (e) {
                // keep as string if parse fails
              }
            }
          }
          const hasLyricsPayload = (obj) => {
            if (!obj) return false;
            if (typeof obj === 'string') return obj.trim().length > 0;
            if (Array.isArray(obj)) return obj.length > 0;
            if (typeof obj === 'object') {
              if (typeof obj.lyrics === 'string' && obj.lyrics.trim().length > 0) return true;
              if (Array.isArray(obj.lyrics) && obj.lyrics.length > 0) return true;
              if (Array.isArray(obj.lines) && obj.lines.length > 0) return true;
              if (typeof obj.result === 'string' && obj.result.trim().length > 0) return true;
            }
            return false;
          };
          const hasLyrics =
            hasLyricsPayload(payload)
            || hasLyricsPayload(payload?.data)
            || hasLyricsPayload(payload?.result)
            || hasLyricsPayload(payload?.data?.result);

          if (hasLyrics) {
            setCache(cacheKey, payload, CACHE_TTL.lyrics);
            return res.json(payload);
          }

          lastError = new Error('Lyrics empty');
        } catch (err) {
          lastError = err;
          const status = err?.response?.status;
          if (status === 429) {
            sawRateLimit = true;
            break; // no insistir con este proveedor
          }
        }
      }
    }

    if (sawRateLimit) {
      return res.status(429).json({ error: "Rate limit en proveedor de letras" });
    }

    throw lastError || new Error('Lyrics API failed');

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

// Obtener trending (top tracks) usando Deezer + mapeo a HiFi
app.get('/api/trending', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    if (Date.now() - trendingState.ts > TRENDING_TTL_MS || trendingState.seeds.length === 0) {
      const seeds = await buildTrendingSeeds();
      trendingState = {
        ts: Date.now(),
        seeds,
        seedCursor: 0,
        items: [],
        seenIds: new Set()
      };
    }

    const target = offset + limit;
    await ensureTrendingItems(target);

    const items = trendingState.items.slice(offset, offset + limit);
    const hasMore = trendingState.seedCursor < trendingState.seeds.length && trendingState.items.length < TRENDING_TARGET;

    return res.json({
      items,
      total: trendingState.items.length,
      limit,
      offset,
      hasMore,
      source: 'deezer+itunes'
    });
  } catch (error) {
    console.error('Error al obtener trending:', error.message);
    res.status(500).json({ error: 'Error al obtener trending' });
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
    if (pool) {
      pool.query(
        'SELECT id, name, description, is_public, tracks, created_at, updated_at FROM playlists WHERE user_id = $1 ORDER BY created_at DESC',
        [req.userId]
      )
        .then(result => {
          const playlists = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            description: row.description || '',
            isPublic: row.is_public,
            tracks: parseJsonValue(row.tracks, []),
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at)
          }));
          res.json({ playlists });
        })
        .catch(err => {
          console.error('Error al obtener playlists:', err);
          res.status(500).json({ error: 'Error al obtener playlists' });
        });
      return;
    }

    const playlists = db.playlists.get(req.userId) || [];
    res.json({ playlists });
  } catch (error) {
    console.error('Error al obtener playlists:', error);
    res.status(500).json({ error: 'Error al obtener playlists' });
  }
});

// Crear playlist
app.post('/api/user/playlists', authMiddleware, async (req, res) => {
  try {
    const { name, description, isPublic = true } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    const playlistId = `playlist_${Date.now()}`;
    const now = new Date().toISOString();
    const playlist = {
      id: playlistId,
      name,
      description: description || '',
      isPublic,
      tracks: [],
      createdAt: now,
      updatedAt: now
    };

    if (pool) {
      await pool.query(
        'INSERT INTO playlists (id, user_id, name, description, is_public, tracks, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
        [playlist.id, req.userId, playlist.name, playlist.description, playlist.isPublic, JSON.stringify(playlist.tracks), playlist.createdAt, playlist.updatedAt]
      );
      return res.status(201).json({ playlist });
    }

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
app.post('/api/user/playlists/:playlistId/tracks', authMiddleware, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    if (pool) {
      const result = await pool.query(
        'SELECT id, name, description, is_public, tracks, created_at, updated_at FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, req.userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Playlist no encontrada' });
      }
      const row = result.rows[0];
      const tracks = parseJsonValue(row.tracks, []);
      const trackKey = String(trackId);

      if (!tracks.some(t => String(t.id) === trackKey)) {
        tracks.push({
          id: trackId,
          ...trackData,
          addedAt: new Date().toISOString()
        });
      }

      const updatedAt = new Date().toISOString();
      await pool.query(
        'UPDATE playlists SET tracks = $1::jsonb, updated_at = $2 WHERE id = $3 AND user_id = $4',
        [JSON.stringify(tracks), updatedAt, playlistId, req.userId]
      );

      return res.json({
        playlist: {
          id: row.id,
          name: row.name,
          description: row.description || '',
          isPublic: row.is_public,
          tracks,
          createdAt: toIso(row.created_at),
          updatedAt
        }
      });
    }

    const userPlaylists = db.playlists.get(req.userId) || [];
    const playlist = userPlaylists.find(p => p.id === playlistId);

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    // Verificar si el track ya está en la playlist
    if (!playlist.tracks.some(t => String(t.id) === String(trackId))) {
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
app.delete('/api/user/playlists/:playlistId/tracks/:trackId', authMiddleware, async (req, res) => {
  try {
    const { playlistId, trackId } = req.params;

    if (pool) {
      const result = await pool.query(
        'SELECT id, name, description, is_public, tracks, created_at, updated_at FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, req.userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Playlist no encontrada' });
      }
      const row = result.rows[0];
      const tracks = parseJsonValue(row.tracks, []).filter(t => String(t.id) !== String(trackId));
      const updatedAt = new Date().toISOString();

      await pool.query(
        'UPDATE playlists SET tracks = $1::jsonb, updated_at = $2 WHERE id = $3 AND user_id = $4',
        [JSON.stringify(tracks), updatedAt, playlistId, req.userId]
      );

      return res.json({
        playlist: {
          id: row.id,
          name: row.name,
          description: row.description || '',
          isPublic: row.is_public,
          tracks,
          createdAt: toIso(row.created_at),
          updatedAt
        }
      });
    }

    const userPlaylists = db.playlists.get(req.userId) || [];
    const playlist = userPlaylists.find(p => p.id === playlistId);

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    playlist.tracks = playlist.tracks.filter(t => String(t.id) !== String(trackId));
    playlist.updatedAt = new Date().toISOString();
    db.playlists.set(req.userId, userPlaylists);

    res.json({ playlist });
  } catch (error) {
    console.error('Error al eliminar track:', error);
    res.status(500).json({ error: 'Error al eliminar track' });
  }
});

// Eliminar playlist
app.delete('/api/user/playlists/:playlistId', authMiddleware, async (req, res) => {
  try {
    const { playlistId } = req.params;

    if (pool) {
      const result = await pool.query(
        'DELETE FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, req.userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Playlist no encontrada' });
      }
      return res.json({ message: 'Playlist eliminada' });
    }

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
    if (pool) {
      pool.query(
        'SELECT track_id, track_data, added_at FROM favorites WHERE user_id = $1 ORDER BY added_at DESC',
        [req.userId]
      )
        .then(result => {
          const favorites = result.rows.map(row => ({
            id: row.track_id,
            ...parseJsonValue(row.track_data, {}),
            addedAt: toIso(row.added_at)
          }));
          res.json({ favorites });
        })
        .catch(err => {
          console.error('Error al obtener favoritos:', err);
          res.status(500).json({ error: 'Error al obtener favoritos' });
        });
      return;
    }

    const favorites = db.favorites.get(req.userId) || [];
    res.json({ favorites });
  } catch (error) {
    console.error('Error al obtener favoritos:', error);
    res.status(500).json({ error: 'Error al obtener favoritos' });
  }
});

// Agregar a favoritos
app.post('/api/user/favorites', authMiddleware, async (req, res) => {
  try {
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    if (pool) {
      const now = new Date().toISOString();
      await pool.query(
        'INSERT INTO favorites (user_id, track_id, track_data, added_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (user_id, track_id) DO NOTHING',
        [req.userId, String(trackId), JSON.stringify(trackData), now]
      );

      const result = await pool.query(
        'SELECT track_id, track_data, added_at FROM favorites WHERE user_id = $1 ORDER BY added_at DESC',
        [req.userId]
      );
      const favorites = result.rows.map(row => ({
        id: row.track_id,
        ...parseJsonValue(row.track_data, {}),
        addedAt: toIso(row.added_at)
      }));
      return res.json({ favorites });
    }

    const favorites = db.favorites.get(req.userId) || [];
    
    // Verificar si ya está en favoritos
    if (!favorites.some(f => String(f.id) === String(trackId))) {
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
app.delete('/api/user/favorites/:trackId', authMiddleware, async (req, res) => {
  try {
    const { trackId } = req.params;

    if (pool) {
      await pool.query(
        'DELETE FROM favorites WHERE user_id = $1 AND track_id = $2',
        [req.userId, String(trackId)]
      );

      const result = await pool.query(
        'SELECT track_id, track_data, added_at FROM favorites WHERE user_id = $1 ORDER BY added_at DESC',
        [req.userId]
      );
      const favorites = result.rows.map(row => ({
        id: row.track_id,
        ...parseJsonValue(row.track_data, {}),
        addedAt: toIso(row.added_at)
      }));

      return res.json({ favorites });
    }

    const favorites = db.favorites.get(req.userId) || [];
    const filtered = favorites.filter(f => String(f.id) !== String(trackId));
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
    const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);

    if (pool) {
      pool.query(
        'SELECT track_id, track_data, played_at FROM history WHERE user_id = $1 ORDER BY played_at DESC LIMIT $2',
        [req.userId, safeLimit]
      )
        .then(result => {
          const history = result.rows.map(row => ({
            id: row.track_id,
            ...parseJsonValue(row.track_data, {}),
            playedAt: toIso(row.played_at)
          }));
          res.json({ history });
        })
        .catch(err => {
          console.error('Error al obtener historial:', err);
          res.status(500).json({ error: 'Error al obtener historial' });
        });
      return;
    }

    const history = (db.history.get(req.userId) || []).slice(0, safeLimit);
    res.json({ history });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// Agregar al historial
app.post('/api/user/history', authMiddleware, async (req, res) => {
  try {
    const { trackId, trackData } = req.body;

    if (!trackId || !trackData) {
      return res.status(400).json({ error: 'trackId y trackData requeridos' });
    }

    if (pool) {
      const playedAt = trackData.playedAt ? new Date(trackData.playedAt).toISOString() : new Date().toISOString();
      await pool.query(
        'INSERT INTO history (user_id, track_id, track_data, played_at) VALUES ($1, $2, $3::jsonb, $4)',
        [req.userId, String(trackId), JSON.stringify(trackData), playedAt]
      );

      await pool.query(
        `
        DELETE FROM history
        WHERE id IN (
          SELECT id FROM history
          WHERE user_id = $1
          ORDER BY played_at DESC
          OFFSET 100
        )
        `,
        [req.userId]
      );

      return res.json({ message: 'Agregado al historial' });
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
app.delete('/api/user/history', authMiddleware, async (req, res) => {
  try {
    if (pool) {
      await pool.query('DELETE FROM history WHERE user_id = $1', [req.userId]);
      return res.json({ message: 'Historial limpiado' });
    }

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
    if (pool) {
      Promise.all([
        pool.query('SELECT COUNT(*) FROM playlists WHERE user_id = $1', [req.userId]),
        pool.query('SELECT COUNT(*) FROM favorites WHERE user_id = $1', [req.userId]),
        pool.query('SELECT COUNT(*) FROM history WHERE user_id = $1', [req.userId]),
        pool.query('SELECT track_id, track_data, played_at FROM history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 100', [req.userId])
      ])
        .then(([playlistsCount, favoritesCount, historyCount, historyResult]) => {
          const history = historyResult.rows.map(row => ({
            id: row.track_id,
            ...parseJsonValue(row.track_data, {}),
            playedAt: toIso(row.played_at)
          }));

          const artistCounts = {};
          history.forEach(track => {
            const artist = track.artist || 'Unknown';
            artistCounts[artist] = (artistCounts[artist] || 0) + 1;
          });

          const topArtists = Object.entries(artistCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([artist, count]) => ({ artist, plays: count }));

          const totalSeconds = history.reduce((sum, track) => {
            const seconds = Number.isFinite(track?.listenSeconds)
              ? track.listenSeconds
              : (track?.duration || 0);
            return sum + (seconds || 0);
          }, 0);
          const totalMinutes = Math.floor(totalSeconds / 60);

          const stats = {
            totalPlaylists: Number(playlistsCount.rows[0]?.count || 0),
            totalFavorites: Number(favoritesCount.rows[0]?.count || 0),
            totalPlays: Number(historyCount.rows[0]?.count || 0),
            totalMinutes,
            topArtists,
            recentlyPlayed: history.slice(0, 10)
          };

          res.json(stats);
        })
        .catch(err => {
          console.error('Error al obtener estadísticas:', err);
          res.status(500).json({ error: 'Error al obtener estadísticas' });
        });
      return;
    }

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

    // Calcular tiempo total de escucha (preferir listenSeconds si existe)
    const totalSeconds = history.reduce((sum, track) => {
      const seconds = Number.isFinite(track?.listenSeconds)
        ? track.listenSeconds
        : (track?.duration || 0);
      return sum + (seconds || 0);
    }, 0);
    const totalMinutes = Math.floor(totalSeconds / 60);

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

app.get('/health', async (req, res) => {
  try {
    let usersCount = db.users.size;
    if (pool) {
      const result = await pool.query('SELECT COUNT(*) FROM users');
      usersCount = Number(result.rows[0]?.count || 0);
    }

    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      apis: Object.keys(HIFI_APIS),
      users: usersCount
    });
  } catch (error) {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      apis: Object.keys(HIFI_APIS),
      users: db.users.size
    });
  }
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    app: 'Yupify API',
    version: '1.0.0',
    description: 'Backend proxy para Yupify - Streaming de música de alta calidad',
    endpoints: {
      auth: ['/api/auth/register', '/api/auth/login'],
      music: ['/api/search', '/api/recommendations', '/api/track/:id', '/api/album/:id', '/api/artist/:id'],
      user: ['/api/user/playlists', '/api/user/favorites', '/api/user/history', '/api/user/stats'],
      proxy: ['/api/dash/:id', '/api/lyrics', '/api/cover', '/api/home', '/api/mix/:id']
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
  console.log(`💾 Base de datos: ${pool ? 'PostgreSQL' : 'En memoria (usar PostgreSQL/MongoDB en producción)'}`);
  console.log(`🧩 DATABASE_URL presente: ${Boolean(process.env.DATABASE_URL)}`);
});

module.exports = app;
