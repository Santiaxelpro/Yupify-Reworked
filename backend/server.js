const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (err) {
  ffmpegPath = null;
}
if (!ffmpegPath && process.env.FFMPEG_PATH) {
  ffmpegPath = process.env.FFMPEG_PATH;
}
if (!ffmpegPath) {
  ffmpegPath = 'ffmpeg';
}
const dotenv = require('dotenv');

const secretsEnvPath = '/etc/secrets/.env';
const localEnvPath = path.resolve(__dirname, '.env');
const secretsExists = fs.existsSync(secretsEnvPath);
const localEnvExists = fs.existsSync(localEnvPath);

const secretsResult = secretsExists ? dotenv.config({ path: secretsEnvPath }) : null;
const localResult = localEnvExists ? dotenv.config({ path: localEnvPath }) : null;

if (process.env.FFMPEG_PATH) {
  ffmpegPath = process.env.FFMPEG_PATH;
}
if (!ffmpegPath) {
  ffmpegPath = 'ffmpeg';
}

try {
  const ffmpegExists = ffmpegPath && fs.existsSync(ffmpegPath);
  console.log(`🎬 FFMPEG: ${ffmpegPath} (${ffmpegExists ? 'exists' : 'missing'})`);
} catch (e) {
  console.log(`🎬 FFMPEG: ${ffmpegPath} (check failed)`);
}

if ((process.env.FFMPEG_PROBE || '').toString().toLowerCase() === 'true') {
  try {
    const probe = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    probe.stdout.on('data', (chunk) => { out += chunk.toString(); });
    probe.stderr.on('data', (chunk) => { err += chunk.toString(); });
    probe.on('close', (code) => {
      const firstLine = (out || err).split('\n')[0]?.trim();
      console.log(`🎬 FFMPEG probe exit ${code}: ${firstLine || 'no output'}`);
    });
  } catch (e) {
    console.log(`🎬 FFMPEG probe failed: ${e.message}`);
  }
}

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

// ==== Google Drive cache (lyrics) ====
const isNonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const GDRIVE_CACHE_FOLDERS = {
  apple: process.env.GDRIVE_CACHED_TTML || '',
  musixmatch: process.env.GDRIVE_CACHED_MUSIXMATCH || '',
  spotify: process.env.GDRIVE_CACHED_SPOTIFY || '',
  lyricsplus: process.env.GDRIVE_USERTML_JSON || '',
  default: process.env.GDRIVE_CACHED_LYRICS || process.env.GDRIVE_CACHED_MUSIXMATCH || ''
};
const gdriveState = { accessToken: null, expiresAt: 0 };
const GDRIVE_SONGS_FILE_ID = process.env.GDRIVE_SONGS_FILE_ID || '';
const GDRIVE_AUDIO_FOLDER = process.env.GDRIVE_CACHED_AUDIO || '';
const GDRIVE_SEARCH_FOLDER = process.env.GDRIVE_CACHED_SEARCH || '';
const LYRICS_CACHE_FOLDER_MODE = (process.env.LYRICS_CACHE_FOLDER_MODE || 'per-source').toLowerCase();
const AUDIO_CACHE_MODE = (process.env.AUDIO_CACHE_MODE || 'async').toLowerCase(); // async | sync
const AUDIO_CACHE_FALLBACK_LOSSLESS = process.env.AUDIO_CACHE_FALLBACK_LOSSLESS === 'true';
const AUDIO_CACHE_WITH_METADATA = process.env.AUDIO_CACHE_WITH_METADATA !== 'false';
const AUDIO_CACHE_DASH = process.env.AUDIO_CACHE_DASH === 'true';
const AUDIO_CACHE_READ = process.env.AUDIO_CACHE_READ !== 'false';
const ONLY_GOOGLE_DRIVE = process.env.ONLY_GOOGLE_DRIVE === 'true';
const AUDIO_CACHE_DASH_USER_AGENT = process.env.AUDIO_CACHE_DASH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Yupify/1.0';
const LYRICS_CACHE_DEBUG = process.env.LYRICS_CACHE_DEBUG === 'true';
const AUDIO_CACHE_DEBUG = process.env.AUDIO_CACHE_DEBUG === 'true' || LYRICS_CACHE_DEBUG;
const SEARCH_CACHE_DEBUG = process.env.SEARCH_CACHE_DEBUG === 'true' || LYRICS_CACHE_DEBUG;

const hasGDriveAuth = () => (
  isNonEmpty(process.env.AUTH_KEY_CLIENT_ID) &&
  isNonEmpty(process.env.AUTH_KEY_CLIENT_SECRET) &&
  isNonEmpty(process.env.AUTH_KEY_REFRESH_TOKEN)
);

const hasGDriveFolder = (folderId) => isNonEmpty(folderId);

const normalizeSourceKey = (raw) => {
  const v = (raw || '').toString().toLowerCase();
  if (!v) return '';
  if (v.includes('apple')) return 'apple';
  if (v.includes('musixmatch')) return 'musixmatch';
  if (v.includes('spotify')) return 'spotify';
  if (v.includes('lyrics')) return 'lyricsplus';
  return v;
};

const SOURCE_BY_FOLDER = Object.entries(GDRIVE_CACHE_FOLDERS).reduce((acc, [key, value]) => {
  if (value) acc[value] = key;
  return acc;
}, {});

const getSourceForFolder = (folderId) => SOURCE_BY_FOLDER[folderId] || '';

const getFolderForSource = (rawSource) => {
  if (LYRICS_CACHE_FOLDER_MODE === 'single' && GDRIVE_CACHE_FOLDERS.default) {
    return GDRIVE_CACHE_FOLDERS.default;
  }
  const key = normalizeSourceKey(rawSource);
  return GDRIVE_CACHE_FOLDERS[key] || GDRIVE_CACHE_FOLDERS.default || '';
};

const getCandidateFoldersForSources = (sources) => {
  if (LYRICS_CACHE_FOLDER_MODE === 'single' && GDRIVE_CACHE_FOLDERS.default) {
    return [GDRIVE_CACHE_FOLDERS.default];
  }
  const set = new Set();
  (sources || []).forEach(s => {
    const folder = getFolderForSource(s);
    if (folder) set.add(folder);
  });
  if (set.size === 0 && GDRIVE_CACHE_FOLDERS.default) {
    set.add(GDRIVE_CACHE_FOLDERS.default);
  }
  return Array.from(set);
};

async function getGDriveAccessToken() {
  if (gdriveState.accessToken && gdriveState.expiresAt > Date.now() + 10_000) {
    return gdriveState.accessToken;
  }

  let response;
  try {
    response = await axios.post(
      'https://www.googleapis.com/oauth2/v4/token',
      new URLSearchParams({
        client_id: process.env.AUTH_KEY_CLIENT_ID,
        client_secret: process.env.AUTH_KEY_CLIENT_SECRET,
        refresh_token: process.env.AUTH_KEY_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (err) {
    if (LYRICS_CACHE_DEBUG) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.log('[gdrive] token error:', status, data || err.message);
    }
    throw err;
  }

  const data = response.data || {};
  if (!data.access_token) {
    throw new Error('No access_token returned from Google OAuth');
  }
  gdriveState.accessToken = data.access_token;
  gdriveState.expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  return gdriveState.accessToken;
}

async function gdriveRequest(method, url, data, headers = {}, extraConfig = {}) {
  const token = await getGDriveAccessToken();
  return axios({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers
    },
    ...extraConfig
  });
}

function buildLyricsCacheFileName(cacheKey) {
  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex');
  return `lyrics_${hash}.json`;
}

async function findGDriveFileByName(fileName, folderId) {
  const q = `name = '${fileName}' and '${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const resp = await gdriveRequest('GET', url, null);
  const files = resp.data?.files || [];
  return files[0] || null;
}

async function findGDriveFileByQuery(query) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5`;
  const resp = await gdriveRequest('GET', url, null);
  const files = resp.data?.files || [];
  return files;
}

async function downloadGDriveFile(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const resp = await gdriveRequest('GET', url, null, { 'Accept': 'application/json' });
  return resp.data;
}

async function streamGDriveFile(fileId, rangeHeader) {
  const token = await getGDriveAccessToken();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const headers = {
    Authorization: `Bearer ${token}`
  };
  if (rangeHeader) headers.Range = rangeHeader;
  return axios({
    method: 'GET',
    url,
    headers,
    responseType: 'stream',
    validateStatus: (status) => status >= 200 && status < 500
  });
}

async function createGDriveFile(fileName, folderId, mimeType = '') {
  const url = 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true';
  const metadata = { name: fileName, parents: [folderId] };
  if (mimeType) metadata.mimeType = mimeType;
  const resp = await gdriveRequest('POST', url, metadata, { 'Content-Type': 'application/json' });
  return resp.data?.id;
}

async function updateGDriveFile(fileId, content, contentType = 'application/json') {
  const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`;
  await gdriveRequest(
    'PATCH',
    url,
    content,
    { 'Content-Type': contentType },
    { maxBodyLength: Infinity, maxContentLength: Infinity }
  );
}

async function loadLyricsCacheFromGDrive(cacheKey, sources) {
  if (!hasGDriveAuth()) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] GDrive auth missing, skipping read');
    }
    return null;
  }
  const fileName = buildLyricsCacheFileName(cacheKey);
  const folders = getCandidateFoldersForSources(sources);
  if (folders.length === 0) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] No GDrive folders configured, skipping read');
    }
    return null;
  }

  for (const folderId of folders) {
    try {
      const file = await findGDriveFileByName(fileName, folderId);
      if (!file?.id) {
        if (LYRICS_CACHE_DEBUG) {
          console.log('[lyrics-cache] GDrive MISS:', fileName, 'folder:', folderId);
        }
        continue;
      }
      const content = await downloadGDriveFile(file.id);
      if (LYRICS_CACHE_DEBUG) {
        console.log('[lyrics-cache] GDrive HIT:', fileName, 'id:', file.id, 'folder:', folderId);
      }
      if (typeof content === 'string') {
        try {
          return JSON.parse(content);
        } catch {
          return content;
        }
      }
      return content;
    } catch (e) {
      if (LYRICS_CACHE_DEBUG) {
        const status = e?.response?.status;
        const data = e?.response?.data;
        console.log('[lyrics-cache] GDrive read error:', status || '', data || e.message);
      }
    }
  }

  return null;
}

async function loadLyricsCachesFromGDrive(cacheKey, sources) {
  if (!hasGDriveAuth()) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] GDrive auth missing, skipping read');
    }
    return [];
  }
  const fileName = buildLyricsCacheFileName(cacheKey);
  const folders = getCandidateFoldersForSources(sources);
  if (folders.length === 0) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] No GDrive folders configured, skipping read');
    }
    return [];
  }

  const results = [];
  for (const folderId of folders) {
    try {
      const file = await findGDriveFileByName(fileName, folderId);
      if (!file?.id) {
        if (LYRICS_CACHE_DEBUG) {
          console.log('[lyrics-cache] GDrive MISS:', fileName, 'folder:', folderId);
        }
        continue;
      }
      const content = await downloadGDriveFile(file.id);
      if (LYRICS_CACHE_DEBUG) {
        console.log('[lyrics-cache] GDrive HIT:', fileName, 'id:', file.id, 'folder:', folderId);
      }
      let payload = content;
      if (typeof content === 'string') {
        try {
          payload = JSON.parse(content);
        } catch {
          payload = content;
        }
      }
      const sourceHint = extractSourceFromPayload(payload) || getSourceForFolder(folderId) || '';
      results.push({ source: sourceHint, payload, folderId, fileId: file.id });
    } catch (e) {
      if (LYRICS_CACHE_DEBUG) {
        const status = e?.response?.status;
        const data = e?.response?.data;
        console.log('[lyrics-cache] GDrive read error:', status || '', data || e.message);
      }
    }
  }

  return results;
}

function normalizeLyricsPayloadForOutput(payload) {
  if (payload == null) return { result: '' };
  if (Array.isArray(payload)) return { lyrics: payload };
  if (typeof payload === 'string') return { result: payload };
  if (typeof payload === 'object') return payload;
  return { result: String(payload) };
}

function buildCombinedLyricsPayload(caches, preferredSources = []) {
  if (!Array.isArray(caches) || caches.length === 0) return null;
  const preferredOrder = Array.isArray(preferredSources) ? preferredSources : [];
  let preferred = null;
  for (const src of preferredOrder) {
    preferred = caches.find(c => normalizeSourceKey(c.source) === normalizeSourceKey(src));
    if (preferred) break;
  }
  if (!preferred) preferred = caches[0];

  const base = normalizeLyricsPayloadForOutput(preferred.payload);
  const sourcesMap = {};
  const sourcesList = [];
  caches.forEach((entry) => {
    const key = normalizeSourceKey(entry.source) || entry.source || 'unknown';
    const safeKey = key || `folder_${entry.folderId || 'unknown'}`;
    sourcesMap[safeKey] = entry.payload;
    sourcesList.push({
      source: safeKey,
      folderId: entry.folderId,
      fileId: entry.fileId
    });
  });

  return {
    ...base,
    _combined: true,
    _sources: sourcesMap,
    _sourcesMeta: sourcesList
  };
}
async function saveLyricsCacheToGDrive(cacheKey, payload, sourceHint) {
  if (!hasGDriveAuth()) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] GDrive auth missing, skipping save');
    }
    return;
  }
  const folderId = getFolderForSource(sourceHint);
  if (!hasGDriveFolder(folderId)) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] GDrive folder missing for source:', sourceHint);
    }
    return;
  }
  const fileName = buildLyricsCacheFileName(cacheKey);
  const file = await findGDriveFileByName(fileName, folderId);
  const content = JSON.stringify(payload);

  const fileId = file?.id || await createGDriveFile(fileName, folderId, 'application/json');
  if (!fileId) throw new Error('Failed to create cache file in Google Drive');
  await updateGDriveFile(fileId, content, 'application/json');
  if (LYRICS_CACHE_DEBUG) {
    console.log('[lyrics-cache] GDrive SAVE:', fileName, 'id:', fileId, file?.id ? '(update)' : '(create)', 'folder:', folderId);
  }
}

function extractSourceFromPayload(payload) {
  const candidates = [
    payload?.metadata?.source,
    payload?.data?.metadata?.source,
    payload?.result?.metadata?.source,
    payload?.data?.result?.metadata?.source,
    payload?.source
  ].filter(Boolean);

  for (const s of candidates) {
    const norm = normalizeSourceKey(s);
    if (norm) return norm;
  }
  return '';
}

async function loadSongListFromGDrive() {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_SONGS_FILE_ID)) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] songList config missing, skipping read');
    }
    return [];
  }
  try {
    const url = `https://www.googleapis.com/drive/v3/files/${GDRIVE_SONGS_FILE_ID}?alt=media&supportsAllDrives=true`;
    const resp = await gdriveRequest('GET', url, null, { 'Accept': 'application/json' });
    const data = resp.data;
    if (Array.isArray(data)) return data;
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  } catch (e) {
    if (LYRICS_CACHE_DEBUG) {
      console.log('[lyrics-cache] songList read error:', e.message);
    }
    return [];
  }
}

async function saveSongListToGDrive(list) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_SONGS_FILE_ID)) return;
  const content = JSON.stringify(list);
  await updateGDriveFile(GDRIVE_SONGS_FILE_ID, content, 'application/json');
  if (LYRICS_CACHE_DEBUG) {
    console.log('[lyrics-cache] songList updated:', list.length);
  }
}

async function updateSongListEntry(entry) {
  if (!entry?.title || !entry?.artist) return;
  const list = await loadSongListFromGDrive();
  const norm = (v) => (v || '').toString().toLowerCase().trim();
  const key = `${norm(entry.title)}|${norm(entry.artist)}|${norm(entry.album || '')}`;
  const now = new Date().toISOString();

  let updated = false;
  const next = list.map(item => {
    const itemKey = `${norm(item.title)}|${norm(item.artist)}|${norm(item.album || '')}`;
    if (itemKey === key) {
      updated = true;
      return { ...item, ...entry, updatedAt: now };
    }
    return item;
  });

  if (!updated) {
    next.push({ ...entry, updatedAt: now });
  }

  await saveSongListToGDrive(next);
}
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
  credentials: true,
  exposedHeaders: ['Content-Disposition']
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

function sanitizeFilename(value) {
  if (!value) return 'track';
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'track';
}

function getArtistString(track) {
  if (!track) return '';
  if (Array.isArray(track.artists) && track.artists.length > 0) {
    return track.artists.map(a => a?.name || a).filter(Boolean).join(', ');
  }
  if (track.artist?.name) return track.artist.name;
  if (typeof track.artist === 'string') return track.artist;
  return '';
}

function buildCoverUrlFromTrack(track, size = 1280) {
  if (!track) return null;
  const rawCover = track.cover || track.album?.cover;
  if (!rawCover) return null;
  if (typeof rawCover === 'string' && rawCover.startsWith('http')) {
    return rawCover;
  }
  if (typeof rawCover !== 'string') return null;
  const trimmed = rawCover.trim();
  if (!trimmed) return null;
  let coverId = null;
  if (trimmed.includes('/')) {
    const clean = trimmed.replace(/^\//, '');
    if (/^[0-9a-fA-F/]{20,}$/.test(clean)) {
      coverId = clean;
    }
  } else if (/^[0-9a-fA-F-]{32,36}$/.test(trimmed)) {
    coverId = trimmed.replace(/-/g, '/');
  }
  if (!coverId) return null;
  return `https://resources.tidal.com/images/${coverId}/${size}x${size}.jpg`;
}

function inferAudioExtension(url, usedQuality) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '').toLowerCase();
    if (ext) return ext;
  } catch (e) {}
  if (usedQuality && usedQuality.includes('LOSSLESS')) return 'flac';
  return 'm4a';
}

function inferDashOutputExt(usedQuality, dashManifest = '') {
  const m = (dashManifest || '').toString().toLowerCase();
  if (m.includes('flac') || m.includes('audio/flac')) return 'flac';
  if (m.includes('mp4a') || m.includes('aac') || m.includes('audio/mp4')) return 'm4a';
  if (m.includes('opus')) return 'opus';
  if (m.includes('vorbis')) return 'ogg';
  if (usedQuality && usedQuality.includes('LOSSLESS')) return 'flac';
  return 'm4a';
}

function isDashMime(mimeType) {
  return typeof mimeType === 'string' && mimeType.toLowerCase().includes('dash');
}

function inferAudioMimeType(ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'flac') return 'audio/flac';
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'wav') return 'audio/wav';
  if (e === 'm4a' || e === 'mp4') return 'audio/mp4';
  if (e === 'aac') return 'audio/aac';
  return 'application/octet-stream';
}

function buildAudioFileName(id, track, usedQuality, ext, nameHint = {}) {
  const hintedTitle = (nameHint?.title || nameHint?.track || '').toString().trim();
  const hintedArtist = (nameHint?.artist || '').toString().trim();
  const title = hintedTitle || track?.title || track?.name || track?.trackTitle || `track-${id}`;
  const artist = hintedArtist || getArtistString(track);
  const baseName = sanitizeFilename(`${artist ? artist + ' - ' : ''}${title}`);
  const qualityTag = usedQuality ? ` [${usedQuality}]` : '';
  const suffix = ` (${id})`;
  const safeBase = baseName || `track-${id}`;
  return `${safeBase}${qualityTag}${suffix}.${ext || 'm4a'}`;
}

function buildAudioMetaFileName(audioFileName) {
  if (!audioFileName) return null;
  const idx = audioFileName.lastIndexOf('.');
  const base = idx > 0 ? audioFileName.slice(0, idx) : audioFileName;
  return `${base}.json`;
}

function buildAudioMetaPayload({ id, track, usedQuality, nameHint }) {
  if (!track && !id) return null;
  const meta = extractTrackMetadata(track || {}, nameHint || {});
  const albumObj = (track?.album && typeof track.album === 'object')
    ? track.album
    : (meta.albumTitle ? { title: meta.albumTitle } : undefined);
  const duration = track?.duration ?? track?.trackDuration ?? track?.length ?? null;
  const durationMs = track?.durationMs ?? track?.duration_ms ?? null;
  const normalizeQualityValue = (value) => {
    if (!value) return null;
    const raw = String(value).toUpperCase().trim();
    if (!raw) return null;
    const normalized = raw.replace(/[\s-]+/g, '_');
    if (normalized === 'HIRES_LOSSLESS') return 'HI_RES_LOSSLESS';
    if (normalized === 'HIRES') return 'HI_RES';
    return normalized;
  };

  const audioQuality = normalizeQualityValue(track?.audioQuality || track?.quality || track?.streamQuality);

  return {
    id: track?.id || track?.trackId || id || null,
    title: meta.title || track?.title || track?.name || '',
    artist: meta.artist || getArtistString(track),
    album: albumObj,
    albumTitle: meta.albumTitle || '',
    cover: track?.cover || track?.album?.cover || null,
    coverUrl: meta.coverUrl || null,
    albumArtUrl: track?.albumArtUrl || null,
    duration: duration,
    durationMs: durationMs,
    isrc: meta.isrc || null,
    trackNumber: meta.trackNumber || null,
    discNumber: meta.discNumber || null,
    releaseYear: meta.releaseYear || null,
    usedQuality: usedQuality || null,
    requestedQuality: track?.requestedQuality || null,
    audioQuality: audioQuality || null,
    cachedAt: new Date().toISOString()
  };
}

async function loadAudioMetaFromGDrive(audioFileName) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_AUDIO_FOLDER) || !audioFileName) return null;
  const metaName = buildAudioMetaFileName(audioFileName);
  if (!metaName) return null;
  try {
    const file = await findGDriveFileByName(metaName, GDRIVE_AUDIO_FOLDER);
    if (!file?.id) {
      if (AUDIO_CACHE_DEBUG) {
        console.log('[audio-cache] META MISS:', metaName);
      }
      return null;
    }
    const content = await downloadGDriveFile(file.id);
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] META HIT:', metaName, 'id:', file.id);
    }
    if (typeof content === 'string') {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    }
    return content;
  } catch (e) {
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] META read error:', e.message);
    }
    return null;
  }
}

async function saveAudioMetaToGDrive(audioFileName, payload) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_AUDIO_FOLDER) || !payload) return;
  const metaName = buildAudioMetaFileName(audioFileName);
  if (!metaName) return;
  try {
    const file = await findGDriveFileByName(metaName, GDRIVE_AUDIO_FOLDER);
    const fileId = file?.id || await createGDriveFile(metaName, GDRIVE_AUDIO_FOLDER, 'application/json');
    if (!fileId) throw new Error('Failed to create audio meta file in Google Drive');
    await updateGDriveFile(fileId, JSON.stringify(payload), 'application/json');
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] META SAVE:', metaName, 'id:', fileId, file?.id ? '(update)' : '(create)');
    }
  } catch (e) {
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] META save failed:', e.message);
    }
  }
}

function parseQualityFromFileName(name) {
  if (!name) return '';
  const match = name.match(/\[([A-Z_]+)\]/);
  return match ? match[1] : '';
}

function getQualityFallbackList(requestedQuality) {
  const q = (requestedQuality || '').toUpperCase().trim();
  const qualityFallback = {
    "HI_RES_LOSSLESS": ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"],
    "LOSSLESS": ["LOSSLESS", "HIGH", "LOW"],
    "HIGH": ["HIGH", "LOSSLESS", "LOW"],
    "LOW": ["LOW", "HIGH", "LOSSLESS"]
  };
  return qualityFallback[q] || (q ? [q] : ["LOSSLESS", "HIGH", "LOW"]);
}

async function findCachedAudioFile({ id, requestedQuality }) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_AUDIO_FOLDER) || !AUDIO_CACHE_READ) return null;
  const qualitiesToTry = getQualityFallbackList(requestedQuality);
  const isAudioCandidate = (file) => {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.json')) return false;
    const mime = (file.mimeType || '').toLowerCase();
    if (mime && mime.includes('application/json')) return false;
    return true;
  };
  for (const quality of qualitiesToTry) {
    const query = [
      `name contains '(${id})'`,
      `name contains '[${quality}]'`,
      `'${GDRIVE_AUDIO_FOLDER}' in parents`,
      'trashed = false'
    ].join(' and ');
    try {
      const files = await findGDriveFileByQuery(query);
      if (files && files.length > 0) {
        const audioFile = files.find(isAudioCandidate);
        if (audioFile) {
          return { file: audioFile, quality };
        }
      }
    } catch (e) {
      if (AUDIO_CACHE_DEBUG) {
        console.log('[audio-cache] query failed:', e.message);
      }
    }
  }

  // Fallback: buscar solo por id (por si el tag de calidad no coincide)
  const fallbackQuery = [
    `name contains '(${id})'`,
    `'${GDRIVE_AUDIO_FOLDER}' in parents`,
    'trashed = false'
  ].join(' and ');
  try {
    const files = await findGDriveFileByQuery(fallbackQuery);
    if (files && files.length > 0) {
      const audioFile = files.find(isAudioCandidate);
      if (audioFile) {
        const inferredQuality = parseQualityFromFileName(audioFile.name);
        return { file: audioFile, quality: inferredQuality || requestedQuality };
      }
    }
  } catch (e) {
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] fallback query failed:', e.message);
    }
  }

  return null;
}

function extractTrackMetadata(track, nameHint = {}) {
  const hintedTitle = (nameHint?.title || nameHint?.track || '').toString().trim();
  const hintedArtist = (nameHint?.artist || '').toString().trim();
  const hintedAlbum = (nameHint?.album || '').toString().trim();
  const hintedCover = (nameHint?.cover || '').toString().trim();
  const hintedCoverUrl = (nameHint?.coverUrl || '').toString().trim();

  const title = hintedTitle || track?.title || track?.name || track?.trackTitle || '';
  const artist = hintedArtist || getArtistString(track);
  const albumTitle = hintedAlbum || track?.album?.title || track?.albumTitle || '';
  const trackNumber = track?.trackNumber || track?.trackNumberInAlbum || '';
  const discNumber = track?.volumeNumber || track?.discNumber || '';
  const isrc = track?.isrc || track?.externalIds?.isrc || '';
  const releaseDateRaw = track?.streamStartDate || track?.releaseDate || '';
  const releaseYear = releaseDateRaw ? new Date(releaseDateRaw).getFullYear() : '';
  let coverUrl = buildCoverUrlFromTrack(track, 1280);
  if (!coverUrl && hintedCoverUrl && hintedCoverUrl.startsWith('http')) {
    coverUrl = hintedCoverUrl;
  }
  if (!coverUrl && hintedCover) {
    coverUrl = buildCoverUrlFromTrack({ cover: hintedCover }, 1280);
  }

  return { title, artist, albumTitle, trackNumber, discNumber, isrc, releaseYear, coverUrl };
}

function buildSearchCacheFileName(cacheKey) {
  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex');
  return `search_${hash}.json`;
}

async function loadSearchCacheFromGDrive(cacheKey) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_SEARCH_FOLDER)) {
    if (SEARCH_CACHE_DEBUG) {
      console.log('[search-cache] GDrive config missing, skipping read');
    }
    return null;
  }
  const fileName = buildSearchCacheFileName(cacheKey);
  try {
    const file = await findGDriveFileByName(fileName, GDRIVE_SEARCH_FOLDER);
    if (!file?.id) {
      if (SEARCH_CACHE_DEBUG) {
        console.log('[search-cache] GDrive MISS:', fileName);
      }
      return null;
    }
    const content = await downloadGDriveFile(file.id);
    if (SEARCH_CACHE_DEBUG) {
      console.log('[search-cache] GDrive HIT:', fileName, 'id:', file.id);
    }
    if (typeof content === 'string') {
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }
    return content;
  } catch (e) {
    if (SEARCH_CACHE_DEBUG) {
      console.log('[search-cache] GDrive read error:', e.message);
    }
    return null;
  }
}

async function saveSearchCacheToGDrive(cacheKey, payload) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_SEARCH_FOLDER)) {
    if (SEARCH_CACHE_DEBUG) {
      console.log('[search-cache] GDrive config missing, skipping save');
    }
    return;
  }
  const fileName = buildSearchCacheFileName(cacheKey);
  const content = JSON.stringify(payload);
  try {
    const file = await findGDriveFileByName(fileName, GDRIVE_SEARCH_FOLDER);
    const fileId = file?.id || await createGDriveFile(fileName, GDRIVE_SEARCH_FOLDER, 'application/json');
    if (!fileId) throw new Error('Failed to create search cache file in Google Drive');
    await updateGDriveFile(fileId, content, 'application/json');
    if (SEARCH_CACHE_DEBUG) {
      console.log('[search-cache] GDrive SAVE:', fileName, 'id:', fileId, file?.id ? '(update)' : '(create)');
    }
  } catch (e) {
    console.warn('[search-cache] save failed:', e.message);
  }
}

const audioCacheInFlight = new Set();

async function cacheTrackAudio({ id, track, streamUrl, usedQuality, nameHint, dashManifest, manifestMimeType }) {
  if (!hasGDriveAuth() || !isNonEmpty(GDRIVE_AUDIO_FOLDER)) {
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] GDrive config missing, skipping audio cache');
    }
    return false;
  }

  const dashEnabled = AUDIO_CACHE_DASH
    && isDashMime(manifestMimeType)
    && typeof dashManifest === 'string'
    && dashManifest.trim().length > 0;

  if (!streamUrl && !dashEnabled) {
    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] Missing stream URL, skipping audio cache');
    }
    return false;
  }

  const inputExt = streamUrl ? inferAudioExtension(streamUrl, usedQuality) : 'mpd';
  const outputExt = dashEnabled
    ? inferDashOutputExt(usedQuality, dashManifest)
    : ((AUDIO_CACHE_WITH_METADATA && ffmpegPath)
      ? (inputExt === 'flac' ? 'flac' : (inputExt === 'mp3' ? 'mp3' : 'm4a'))
      : inputExt);
  const fileName = buildAudioFileName(id, track, usedQuality, outputExt, nameHint);
  if (audioCacheInFlight.has(fileName)) {
    return false;
  }
  audioCacheInFlight.add(fileName);

  try {
    const existing = await findGDriveFileByName(fileName, GDRIVE_AUDIO_FOLDER);
    if (existing?.id) {
      if (AUDIO_CACHE_DEBUG) {
        console.log('[audio-cache] HIT:', fileName, 'id:', existing.id);
      }
      return true;
    }

    const tmpDir = os.tmpdir();
    const tempPath = path.join(tmpDir, `yupify-audio-${id}-${Date.now()}-in.${inputExt || 'm4a'}`);
    const outputPath = path.join(tmpDir, `yupify-audio-${id}-${Date.now()}-out.${outputExt || 'm4a'}`);
    const meta = extractTrackMetadata(track, nameHint);
    const metaPayload = buildAudioMetaPayload({ id, track, usedQuality, nameHint });
    const coverPath = meta.coverUrl ? path.join(tmpDir, `yupify-audio-${id}-${Date.now()}-cover.jpg`) : null;

    if (dashEnabled) {
      if (AUDIO_CACHE_DEBUG) {
        console.log('[audio-cache] DASH:', fileName);
      }
      if (!ffmpegPath) {
        if (AUDIO_CACHE_DEBUG) {
          console.log('[audio-cache] FFmpeg missing, cannot cache DASH');
        }
        return false;
      }
      fs.writeFileSync(tempPath, dashManifest);
      if (AUDIO_CACHE_WITH_METADATA && meta.coverUrl) {
        await downloadToFile(meta.coverUrl, coverPath);
      }

      const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-user_agent', AUDIO_CACHE_DASH_USER_AGENT,
        '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-i', tempPath
      ];

      if (AUDIO_CACHE_WITH_METADATA && coverPath) {
        args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
        args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
      } else {
        args.push('-map', '0:a');
      }
      args.push('-c', 'copy');

      if (AUDIO_CACHE_WITH_METADATA) {
        if (outputExt === 'mp3') {
          args.push('-id3v2_version', '3');
        }
        if (meta.title) args.push('-metadata', `title=${meta.title}`);
        if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
        if (meta.albumTitle) args.push('-metadata', `album=${meta.albumTitle}`);
        if (meta.trackNumber) args.push('-metadata', `track=${meta.trackNumber}`);
        if (meta.discNumber) args.push('-metadata', `disc=${meta.discNumber}`);
        if (meta.releaseYear) args.push('-metadata', `date=${meta.releaseYear}`);
        if (meta.isrc) args.push('-metadata', `isrc=${meta.isrc}`);
      }

      args.push(outputPath);
      try {
        await runFfmpeg(args);
      } catch (err) {
        const message = String(err?.message || '');
        if (message.toLowerCase().includes('option user_agent not found')) {
          const fallbackArgs = args.filter((arg, idx) => {
            const prev = args[idx - 1];
            if (prev === '-user_agent') return false;
            if (arg === '-user_agent') return false;
            return true;
          });
          await runFfmpeg(fallbackArgs);
        } else {
          throw err;
        }
      }

      const mimeType = inferAudioMimeType(outputExt);
      const fileId = await createGDriveFile(fileName, GDRIVE_AUDIO_FOLDER, mimeType);
      if (!fileId) throw new Error('Failed to create audio file in Google Drive');

      await updateGDriveFile(fileId, fs.createReadStream(outputPath), mimeType);

      if (AUDIO_CACHE_DEBUG) {
        console.log('[audio-cache] SAVE:', fileName, 'id:', fileId);
      }

      if (metaPayload) {
        await saveAudioMetaToGDrive(fileName, metaPayload);
      }

      try { fs.unlinkSync(tempPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      try { if (coverPath) fs.unlinkSync(coverPath); } catch {}
      return true;
    }

    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] DOWNLOAD:', fileName);
    }

    await downloadToFile(streamUrl, tempPath);
    if (meta.coverUrl) {
      await downloadToFile(meta.coverUrl, coverPath);
    }

    let uploadPath = tempPath;
    let uploadExt = inputExt;
    if (AUDIO_CACHE_WITH_METADATA && ffmpegPath) {
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempPath];
      if (coverPath) {
        args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
        args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
      } else {
        args.push('-map', '0:a');
      }
      args.push('-c', 'copy');

      if (outputExt === 'mp3') {
        args.push('-id3v2_version', '3');
      }
      if (meta.title) args.push('-metadata', `title=${meta.title}`);
      if (meta.artist) args.push('-metadata', `artist=${meta.artist}`);
      if (meta.albumTitle) args.push('-metadata', `album=${meta.albumTitle}`);
      if (meta.trackNumber) args.push('-metadata', `track=${meta.trackNumber}`);
      if (meta.discNumber) args.push('-metadata', `disc=${meta.discNumber}`);
      if (meta.releaseYear) args.push('-metadata', `date=${meta.releaseYear}`);
      if (meta.isrc) args.push('-metadata', `isrc=${meta.isrc}`);

      args.push(outputPath);
      await runFfmpeg(args);
      uploadPath = outputPath;
      uploadExt = outputExt;
    }

    const mimeType = inferAudioMimeType(uploadExt);
    const fileId = await createGDriveFile(fileName, GDRIVE_AUDIO_FOLDER, mimeType);
    if (!fileId) throw new Error('Failed to create audio file in Google Drive');

    await updateGDriveFile(fileId, fs.createReadStream(uploadPath), mimeType);

    if (AUDIO_CACHE_DEBUG) {
      console.log('[audio-cache] SAVE:', fileName, 'id:', fileId);
    }

    if (metaPayload) {
      await saveAudioMetaToGDrive(fileName, metaPayload);
    }

    try {
      fs.unlinkSync(tempPath);
    } catch {}
    try {
      if (uploadPath !== tempPath) fs.unlinkSync(uploadPath);
    } catch {}
    try {
      if (coverPath) fs.unlinkSync(coverPath);
    } catch {}
    return true;
  } catch (err) {
    console.warn('[audio-cache] failed:', err.message);
    return false;
  } finally {
    audioCacheInFlight.delete(fileName);
  }
}

async function downloadToFile(url, destPath) {
  const response = await axios.get(url, { responseType: 'stream', timeout: 0 });
  await pipeline(response.data, fs.createWriteStream(destPath));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`FFmpeg no disponible: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(stderr || `FFmpeg falló con código ${code}`));
    });
  });
}

function tryDecodeManifest(m) {
  if (!m || typeof m !== 'string') return null;

  let b64 = m.replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
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

async function resolveTrackForDownload(id, qRaw) {
  const VALID_QUALITIES = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
  const requestedQuality = VALID_QUALITIES.includes(qRaw) ? qRaw : "LOSSLESS";
  const qualityFallback = {
    "HI_RES_LOSSLESS": ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"],
    "LOSSLESS": ["LOSSLESS", "HIGH", "LOW"],
    "HIGH": ["HIGH", "LOSSLESS", "LOW"],
    "LOW": ["LOW", "HIGH", "LOSSLESS"]
  };
  const qualitiesToTry = qualityFallback[requestedQuality] || [requestedQuality];
  const allAPIs = Object.values(HIFI_APIS).flat();
  const shuffledAPIs = shuffleArray(allAPIs);
  const fastAPIs = shuffledAPIs.slice(0, FAST_TRACK_POOL);

  let success = null;
  let usedQuality = null;
  for (const quality of qualitiesToTry) {
    success = await fetchFirstTrackData({ apis: fastAPIs, id, quality, timeoutMs: TRACK_TIMEOUT_MS });
    if (!success) {
      success = await fetchFirstTrackData({ apis: allAPIs, id, quality, timeoutMs: TRACK_TIMEOUT_MS });
    }
    if (success) {
      usedQuality = quality;
      break;
    }
  }

  if (!success) {
    return { error: "No se pudo obtener el track en ninguna calidad" };
  }

  const respData = { ...success.data };
  const decoded = tryDecodeManifest(respData.manifest);
  if (decoded !== null) {
    respData.manifest = decoded;
  }

  let streamUrl = respData.url || null;
  if (!streamUrl && respData.manifest && typeof respData.manifest === 'object' && Array.isArray(respData.manifest.urls)) {
    streamUrl = respData.manifest.urls[0];
    respData.url = streamUrl;
  }

  return {
    respData,
    streamUrl,
    usedQuality,
    requestedQuality
  };
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
        const payload = data?.data;
        if (!payload || !payload.manifestMimeType || !payload.manifest) {
          return Promise.reject(new Error('Invalid track'));
        }
        const presentation = String(payload.assetPresentation || '').toUpperCase();
        if (presentation === 'PREVIEW') {
          return Promise.reject(new Error('Preview asset'));
        }
        if (payload.streamReady === false) {
          return Promise.reject(new Error('Stream not ready'));
        }
        return { ok: true, url, data: payload };
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
    const nameHint = {
      title: req.query.title,
      track: req.query.track,
      artist: req.query.artist,
      album: req.query.album,
      cover: req.query.cover,
      coverUrl: req.query.coverUrl
    };

    // Calidad solicitada
    const qRaw = (req.query.quality || "LOSSLESS").toUpperCase().trim();

    // Solo estas calidades
    const VALID_QUALITIES = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];

    // Si no existe, usar LOSSLESS
    const requestedQuality = VALID_QUALITIES.includes(qRaw) ? qRaw : "LOSSLESS";
    const cacheKey = `track:${id}|q:${requestedQuality}`;

    const normalizeQualityValue = (value) => {
      if (!value) return null;
      const raw = String(value).toUpperCase().trim();
      if (!raw) return null;
      const normalized = raw.replace(/[\s-]+/g, '_');
      if (normalized === 'HIRES_LOSSLESS') return 'HI_RES_LOSSLESS';
      if (normalized === 'HIRES') return 'HI_RES';
      return normalized;
    };

    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (AUDIO_CACHE_READ) {
      const audioCached = await findCachedAudioFile({ id, requestedQuality });
      if (audioCached?.file?.id) {
        const audioUrl = `/api/audio/file/${audioCached.file.id}`;
        let meta = null;
        if (audioCached.file.name) {
          meta = await loadAudioMetaFromGDrive(audioCached.file.name);
        }
        if (!meta && (nameHint?.title || nameHint?.track || nameHint?.artist || nameHint?.album)) {
          const hintedTitle = (nameHint?.title || nameHint?.track || '').toString().trim();
          const hintedArtist = (nameHint?.artist || '').toString().trim();
          const hintedAlbum = (nameHint?.album || '').toString().trim();
          meta = {
            id,
            title: hintedTitle || undefined,
            artist: hintedArtist || undefined,
            album: hintedAlbum ? { title: hintedAlbum } : undefined,
            albumTitle: hintedAlbum || undefined
          };
        }
        const cachedQuality = normalizeQualityValue(meta?.usedQuality)
          || normalizeQualityValue(audioCached.quality)
          || normalizeQualityValue(meta?.audioQuality)
          || requestedQuality;

        const payload = {
          ...(meta && typeof meta === 'object' ? meta : {}),
          url: audioUrl,
          assetPresentation: 'FULL',
          manifestMimeType: audioCached.file.mimeType || meta?.manifestMimeType || null,
          requestedQuality,
          usedQuality: cachedQuality,
          cached: true
        };
        if (!payload.id) payload.id = id;
        if (AUDIO_CACHE_DEBUG) {
          console.log('[audio-cache] USE:', audioCached.file.name, 'id:', audioCached.file.id);
        }
        setCache(cacheKey, payload, CACHE_TTL.track);
        return res.json(payload);
      }
    }

    if (ONLY_GOOGLE_DRIVE) {
      return res.status(404).json({
        error: 'ONLY_GOOGLE_DRIVE enabled: audio cache miss',
        id,
        requestedQuality
      });
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
      if (isDashMime(respData.manifestMimeType)) {
        console.log('✔️ HI_RES DASH manifest - será procesado por Shaka Player frontend');
        // No modificar: el frontend necesita el manifest completo
      }

      const reportedQuality = normalizeQualityValue(respData?.audioQuality || respData?.quality || respData?.streamQuality);
      if (!isDashMime(respData?.manifestMimeType) && reportedQuality && VALID_QUALITIES.includes(reportedQuality)) {
        usedQuality = reportedQuality;
      }

      const payload = {
        ...respData,
        requestedQuality: requestedQuality,
        usedQuality: usedQuality
      };
      setCache(cacheKey, payload, CACHE_TTL.track);
      const runAudioCache = async () => {
        let cacheUrl = streamUrl || respData.url || null;
        let cacheQuality = usedQuality;
        const dashManifest = (isDashMime(respData.manifestMimeType) && typeof respData.manifest === 'string')
          ? respData.manifest
          : null;

        let cached = await cacheTrackAudio({
          id,
          track: payload,
          streamUrl: cacheUrl,
          usedQuality: cacheQuality,
          nameHint,
          dashManifest,
          manifestMimeType: respData.manifestMimeType
        });

        if (!cached && !cacheUrl && AUDIO_CACHE_FALLBACK_LOSSLESS) {
          const fallback = await resolveTrackForDownload(id, "LOSSLESS");
          if (fallback?.streamUrl) {
            cacheUrl = fallback.streamUrl;
            cacheQuality = fallback.usedQuality;
            await cacheTrackAudio({
              id,
              track: fallback.respData || respData,
              streamUrl: cacheUrl,
              usedQuality: cacheQuality,
              nameHint
            });
          }
        }
      };
      if (AUDIO_CACHE_MODE === 'sync') {
        await runAudioCache();
      } else {
        runAudioCache().catch(err => console.warn('[audio-cache] background error:', err.message));
      }
      return res.json(payload);

  } catch (error) {
    console.error("❌ Error en TRACK:", error.message);
    res.status(500).json({ error: "Error interno al obtener track" });
  }
});

// Servir audio cacheado desde Google Drive
app.get('/api/audio/file/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!hasGDriveAuth()) {
      return res.status(500).json({ error: 'GDrive auth missing' });
    }
    const range = req.headers.range;
    const resp = await streamGDriveFile(fileId, range);
    if (resp.status >= 400) {
      return res.status(resp.status).json({ error: 'No se pudo obtener audio cacheado' });
    }
    const headers = resp.headers || {};
    if (headers['content-type']) res.setHeader('Content-Type', headers['content-type']);
    if (headers['content-length']) res.setHeader('Content-Length', headers['content-length']);
    if (headers['content-range']) res.setHeader('Content-Range', headers['content-range']);
    if (headers['accept-ranges']) res.setHeader('Accept-Ranges', headers['accept-ranges']);
    res.status(resp.status);
    resp.data.pipe(res);
  } catch (error) {
    console.error('Error en /api/audio/file:', error.message);
    res.status(500).json({ error: 'Error interno al obtener audio cacheado' });
  }
});

// Descargar track con metadata embebida
app.post('/api/download/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quality, track } = req.body || {};

    if (!ffmpegPath) {
      return res.status(500).json({ error: 'FFmpeg no disponible en el servidor' });
    }

    const qRaw = (quality || "LOSSLESS").toUpperCase().trim();
    let resolved = await resolveTrackForDownload(id, qRaw);
    if (resolved?.error) {
      return res.status(500).json({ error: resolved.error });
    }

    let { respData, streamUrl, usedQuality } = resolved;

    // Si es DASH, forzar fallback a LOSSLESS para descarga
    if (respData?.manifestMimeType === 'application/dash+xml') {
      resolved = await resolveTrackForDownload(id, "LOSSLESS");
      if (resolved?.error) {
        return res.status(500).json({ error: resolved.error });
      }
      respData = resolved.respData;
      streamUrl = resolved.streamUrl;
      usedQuality = resolved.usedQuality;
    }

    if (!streamUrl) {
      return res.status(500).json({ error: 'No se pudo resolver URL de descarga' });
    }

    const title = track?.title || `Track ${id}`;
    const artist = getArtistString(track);
    const albumTitle = track?.album?.title || track?.albumTitle || '';
    const trackNumber = track?.trackNumber || '';
    const discNumber = track?.volumeNumber || '';
    const isrc = track?.isrc || '';
    const releaseDateRaw = track?.streamStartDate || track?.releaseDate || '';
    const releaseYear = releaseDateRaw ? new Date(releaseDateRaw).getFullYear() : '';

    const coverUrl = buildCoverUrlFromTrack(track, 1280);
    const inputExt = inferAudioExtension(streamUrl, usedQuality);
    const outputExt = inputExt === 'flac' ? 'flac' : (inputExt === 'mp3' ? 'mp3' : 'm4a');

    const baseName = sanitizeFilename(`${artist ? artist + ' - ' : ''}${title}`);
    const filename = `${baseName}.${outputExt}`;

    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `yupify-${id}-${Date.now()}-in.${inputExt}`);
    const outputPath = path.join(tmpDir, `yupify-${id}-${Date.now()}-out.${outputExt}`);
    const coverPath = coverUrl ? path.join(tmpDir, `yupify-${id}-${Date.now()}-cover.jpg`) : null;

    try {
      await downloadToFile(streamUrl, inputPath);
      if (coverUrl) {
        await downloadToFile(coverUrl, coverPath);
      }

      const args = ['-y', '-i', inputPath];
      if (coverPath) {
        args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
        args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
      } else {
        args.push('-map', '0:a');
      }

      args.push('-c', 'copy');

      if (outputExt === 'mp3') {
        args.push('-id3v2_version', '3');
      }

      if (title) args.push('-metadata', `title=${title}`);
      if (artist) args.push('-metadata', `artist=${artist}`);
      if (albumTitle) args.push('-metadata', `album=${albumTitle}`);
      if (trackNumber) args.push('-metadata', `track=${trackNumber}`);
      if (discNumber) args.push('-metadata', `disc=${discNumber}`);
      if (releaseYear) args.push('-metadata', `date=${releaseYear}`);
      if (isrc) args.push('-metadata', `isrc=${isrc}`);

      args.push(outputPath);

      await runFfmpeg(args);

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (outputExt === 'flac') {
        res.setHeader('Content-Type', 'audio/flac');
      } else if (outputExt === 'mp3') {
        res.setHeader('Content-Type', 'audio/mpeg');
      } else {
        res.setHeader('Content-Type', 'audio/mp4');
      }

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('close', () => {
        try { fs.unlinkSync(outputPath); } catch {}
        try { fs.unlinkSync(inputPath); } catch {}
        if (coverPath) {
          try { fs.unlinkSync(coverPath); } catch {}
        }
      });
    } catch (err) {
      console.error('Error en descarga:', err.message);
      try { fs.unlinkSync(outputPath); } catch {}
      try { fs.unlinkSync(inputPath); } catch {}
      if (coverPath) {
        try { fs.unlinkSync(coverPath); } catch {}
      }
      return res.status(500).json({ error: 'Error generando descarga' });
    }
  } catch (error) {
    console.error('Error en /api/download:', error.message);
    return res.status(500).json({ error: 'Error interno al descargar' });
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

    const gdriveCached = await loadSearchCacheFromGDrive(cacheKey);
    if (gdriveCached) {
      setCache(cacheKey, gdriveCached, CACHE_TTL.search);
      return res.json(gdriveCached);
    }
    if (ONLY_GOOGLE_DRIVE) {
      return res.status(404).json({
        error: 'ONLY_GOOGLE_DRIVE enabled: search cache miss',
        cacheKey
      });
    }

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
      saveSearchCacheToGDrive(cacheKey, payload);
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
      saveSearchCacheToGDrive(cacheKey, payload);
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
      saveSearchCacheToGDrive(cacheKey, payload);
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
    saveSearchCacheToGDrive(cacheKey, payload);
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
    const { title, track, artist, album, duration, source, sourcePrefer, sourceOnly, version } = req.query;
    const finalTitle = title || track;
    const versionText = (version || '').toString().trim();
    const titleVariants = [];
    const baseTitle = (finalTitle || '').toString();
    const lowerBaseTitle = baseTitle.toLowerCase();
    const lowerVersion = versionText.toLowerCase();
    const addTitleVariant = (value) => {
      if (!value) return;
      if (!titleVariants.includes(value)) titleVariants.push(value);
    };
    if (versionText && !lowerBaseTitle.includes(lowerVersion)) {
      addTitleVariant(`${baseTitle} (${versionText})`);
      addTitleVariant(`${baseTitle} - ${versionText}`);
    }
    addTitleVariant(baseTitle);

    if (!finalTitle || !artist) {
      return res.status(400).json({
        error: "Faltan parámetros obligatorios: title (o track) y artist"
      });
    }

    const DEFAULT_SOURCES = ['apple', 'musixmatch', 'lyricsplus', 'spotify', 'musixmatch-word'];
    const parseSources = (value) => (
      (value || '')
        .toString()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );

    let sourcesList = source ? parseSources(source) : [...DEFAULT_SOURCES];
    if (sourceOnly) {
      sourcesList = [sourceOnly.toString().trim()].filter(Boolean);
    } else if (sourcePrefer) {
      const prefer = sourcePrefer.toString().trim();
      if (prefer) {
        sourcesList = [prefer, ...sourcesList.filter(s => s !== prefer)];
      }
    }
    if (sourcesList.length === 0) sourcesList = [...DEFAULT_SOURCES];
    const baseSource = sourcesList.join(',');
    const explicitSingleSource = Boolean(sourceOnly) || (source && parseSources(source).length === 1);
    const providerParam = (req.query.provider || '').toString().toLowerCase().trim();
    const DEFAULT_PROVIDERS = ['binimum', 'atomix', 'vercel', 'prjktla'];
    const parseProviders = (value) => (
      (value || '')
        .toString()
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );

    let providerList = providerParam ? parseProviders(providerParam) : [...DEFAULT_PROVIDERS];
    if (providerParam === 'all') {
      providerList = [...DEFAULT_PROVIDERS];
    }
    if (explicitSingleSource) {
      // Si el cliente fuerza una sola fuente, evitar fallback al provider rate-limited
      providerList = providerList.filter(p => p !== 'prjktla');
      if (providerList.length === 0) providerList = ['binimum'];
    }
    providerList = Array.from(new Set(providerList)).filter(p => DEFAULT_PROVIDERS.includes(p));
    if (providerList.length === 0) providerList = [...DEFAULT_PROVIDERS];

    const multiSourceRequest = sourcesList.length > 1 && !explicitSingleSource;
    if (multiSourceRequest && (!providerParam || providerParam === 'all')) {
      const forced = (process.env.LYRICS_MULTI_PROVIDER || '').toString().trim().toLowerCase();
      const preferred = forced && DEFAULT_PROVIDERS.includes(forced)
        ? forced
        : (providerList[0] || 'binimum');
      providerList = [preferred, ...providerList.filter(p => p !== preferred)];
    }
    const providerKey = providerList.join('|');

    const versionKey = versionText ? `|${versionText}` : '';
    const baseGdriveCacheKey = `lyrics:${finalTitle}|${artist}|${album || ""}|${duration || ""}`;
    const cacheKey = `lyrics:${finalTitle}|${artist}|${album || ""}|${duration || ""}${versionKey}|${baseSource}|${providerKey}`;
    const gdriveCacheKey = `${baseGdriveCacheKey}${versionKey}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let gdriveCaches = await loadLyricsCachesFromGDrive(gdriveCacheKey, sourcesList);
    if (gdriveCaches.length === 0 && versionText) {
      // Fallback a cache sin versión para no romper caches existentes
      gdriveCaches = await loadLyricsCachesFromGDrive(baseGdriveCacheKey, sourcesList);
    }
    if (gdriveCaches.length > 0) {
      const combined = buildCombinedLyricsPayload(gdriveCaches, sourcesList);
      if (combined) {
        setCache(cacheKey, combined, CACHE_TTL.lyrics);
        return res.json(combined);
      }
    }
    if (ONLY_GOOGLE_DRIVE) {
      return res.status(404).json({
        error: 'ONLY_GOOGLE_DRIVE enabled: lyrics cache miss',
        cacheKey: gdriveCacheKey
      });
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

    const paramsVariants = [];
    const seenParams = new Set();
    for (const t of titleVariants) {
      for (const art of artistVariants) {
        for (const alb of albumVariants) {
          for (const dur of durationVariants) {
            const paramsObj = {
              title: t,
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
    }

    const MAX_VARIANTS = 4;
    const paramsToTry = paramsVariants.slice(0, MAX_VARIANTS);

    const providerUrls = {
      binimum: 'https://lyricsplus.binimum.org/v2/lyrics/get',
      prjktla: 'https://lyricsplus.prjktla.workers.dev/v2/lyrics/get',
      atomix:  'https://lyricsplus.atomix.one/v2/lyrics/get',
      vercel:  'https://lyricsplus-seven.vercel.app/v2/lyrics/get'
    };
    const lyricsSources = providerList
      .map(p => providerUrls[p])
      .filter(Boolean);

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
            if (LYRICS_CACHE_DEBUG) {
              console.log('[lyrics-cache] SAVE attempt:', gdriveCacheKey);
            }
            const payloadSource = extractSourceFromPayload(payload);
            const inferredSource = explicitSingleSource ? sourcesList[0] : (payloadSource || '');
            try {
              await saveLyricsCacheToGDrive(gdriveCacheKey, payload, inferredSource);
            } catch (e) {
              console.warn('GDrive cache failed:', e.message);
            }
            try {
              await updateSongListEntry({
                title: finalTitle,
                artist,
                album: album || '',
                duration: duration || '',
                source: explicitSingleSource ? sourcesList[0] : (payloadSource || baseSource)
              });
            } catch (e) {
              console.warn('songList update failed:', e.message);
            }
            return res.json(payload);
          } else if (LYRICS_CACHE_DEBUG) {
            const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
            console.log('[lyrics-cache] No lyrics in response. Keys:', keys);
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
    const allAPIs = Object.values(HIFI_APIS).flat().map(a => a.replace(/\/+$/, ''));
    const shuffledAPIs = shuffleArray(allAPIs);
    const fastAPIs = shuffledAPIs.slice(0, FAST_SEARCH_POOL);

    const fetchHome = async (apis) => {
      if (!apis || apis.length === 0) return null;
      try {
        return await Promise.any(
          apis.map(api =>
            axiosFast.get(`${api}/home/?country=${country}`, { timeout: 7000 })
              .then(r => {
                const data = r.data;
                if (data && (Array.isArray(data?.items) || data?.data || Object.keys(data).length > 0)) {
                  return data;
                }
                return Promise.reject(new Error('Empty home'));
              })
          )
        );
      } catch {
        return null;
      }
    };

    const fastResult = await fetchHome(fastAPIs);
    if (fastResult) return res.json(fastResult);

    const fullResult = await fetchHome(shuffledAPIs);
    if (fullResult) return res.json(fullResult);

    return res.status(502).json({ error: 'No se pudo obtener home' });
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
  console.log(`🧩 /etc/secrets/.env: ${secretsExists ? 'found' : 'missing'}`);
  if (secretsResult?.error) {
    console.log(`🧩 /etc/secrets/.env error: ${secretsResult.error.message}`);
  }
  console.log(`🧩 backend/.env: ${localEnvExists ? 'found' : 'missing'}`);
  if (localResult?.error) {
    console.log(`🧩 backend/.env error: ${localResult.error.message}`);
  }
});

module.exports = app;
