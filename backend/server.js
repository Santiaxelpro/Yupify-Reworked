const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
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

const parsePositiveTimeout = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LYRICS_API_TIMEOUT_MS = parsePositiveTimeout(process.env.LYRICS_API_TIMEOUT_MS, 20000);
const LYRICS_ISRC_TIMEOUT_MS = parsePositiveTimeout(process.env.LYRICS_ISRC_TIMEOUT_MS, 18000);

// ============================================================
// Utilidades de descompresión para payloads de letras
// (los proveedores/búsquedas en GDrive pueden devolver binario gzip)
// ============================================================
function isGzipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// Detecta strings que son gzip binario (intacto o ya corrupto por round-trip utf8)
function isGzipMangledString(value) {
  if (typeof value !== 'string' || value.length < 4) return false;
  const c0 = value.charCodeAt(0);
  const c1 = value.charCodeAt(1);
  const intact = c0 === 0x1f && c1 === 0x8b;
  const mangled = c0 === 0x1f && c1 === 0x08 && value.charCodeAt(2) === 0;
  return intact || mangled;
}

// Recorre el payload buscando strings gzip (binario ya dañado) para descartarlo
function hasMangledGzipField(obj) {
  let bad = false;
  const walk = (v) => {
    if (bad) return;
    if (typeof v === 'string') {
      if (isGzipMangledString(v)) bad = true;
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v)) walk(val);
    }
  };
  walk(obj);
  return bad;
}

// Recibe Buffer de un fetch con responseType arraybuffer y devuelve el
// objeto/string ya descomprimido y parseado (soporta gzip plano o JSON plano).
function decodeLyricsBody(body) {
  if (Buffer.isBuffer(body)
    || (body && typeof body === 'object' && body.type === 'Buffer' && Array.isArray(body.data))) {
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body.data);
    if (isGzipBuffer(buf)) {
      try {
        buf = zlib.gunzipSync(buf);
      } catch (e) {
        /* no es gzip válido, se deja como está */
      }
    }
    const text = buf.toString('utf8');
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }
  return body;
}

// ============================================================
// Presentación de letras sincronizadas de fuente binimum-isrc
// (API https://lyrics-api.binimum.org/ devuelve un lyricsUrl TTML)
// ============================================================
function parseAppleTtmlTime(value) {
  const str = String(value || '').trim();
  const parts = str.split(':');
  let seconds = 0;
  if (parts.length === 3) {
    seconds = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + parseFloat(String(parts[2]).replace(',', '.'));
  } else if (parts.length === 2) {
    seconds = Number(parts[0]) * 60 + parseFloat(String(parts[1]).replace(',', '.'));
  } else {
    seconds = parseFloat(str.replace(',', '.'));
  }
  return Number.isFinite(seconds) ? seconds : 0;
}

function parseAppleTtmlToLines(ttml) {
  const text = String(ttml || '');
  const lines = [];
  const pRe = /<p\b[^>]*\bbegin=["']([^"']+)["'][^>]*\bend=["']([^"']+)["'][^>]*>(.*?)<\/p>/gs;
  let match;
  while ((match = pRe.exec(text)) !== null) {
    const time = parseAppleTtmlTime(match[1]);
    const end = parseAppleTtmlTime(match[2]);
    const raw = match[3]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw) continue;
    lines.push({
      time,
      duration: Math.max(0, end - time),
      text: raw
    });
  }
  return lines;
}

// Busca letras de binimum por ISRC y las devuelve en formato de líneas
// (misma estructura que el frontend espera: lines[].time/duration/text)
async function fetchBinimumIsrcLyrics(isrc) {
  const normalized = String(isrc || '').trim().toUpperCase();
  if (!normalized) return null;

  const apiUrl = `https://lyrics-api.binimum.org/?isrc=${encodeURIComponent(normalized)}`;
  const searchResp = await axios.get(apiUrl, { timeout: LYRICS_ISRC_TIMEOUT_MS, responseType: 'arraybuffer' });
  const searchData = decodeLyricsBody(searchResp.data);
  const results = Array.isArray(searchData?.results) ? searchData.results : [];
  const first = results[0];
  if (!first?.lyricsUrl) return null;

  const ttmlResp = await axios.get(first.lyricsUrl, { timeout: LYRICS_ISRC_TIMEOUT_MS, responseType: 'arraybuffer' });
  const ttml = decodeLyricsBody(ttmlResp.data);
  const lines = parseAppleTtmlToLines(typeof ttml === 'string' ? ttml : JSON.stringify(ttml));
  if (!lines.length) return null;

  return {
    lines,
    type: 'Line',
    title: first.track_name || '',
    artist: first.artist_name || '',
    album: first.album_name || '',
    duration: first.duration || null,
    isrc: first.isrc || normalized,
    metadata: {
      source: 'binimum-isrc',
      title: first.track_name || '',
      artist: first.artist_name || ''
    }
  };
}

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
let pool = null;

if (USE_POSTGRES) {
  const pgConfig = {
    connectionString: process.env.DATABASE_URL
  };

  const needsSSL = process.env.PGSSL === 'true'
    || process.env.NODE_ENV === 'production'
    || (process.env.DATABASE_URL || '').includes('render.com')
    || (process.env.DATABASE_URL || '').includes('supabase.co');

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
const MAX_MEMORY_CACHE_ENTRIES = Math.max(Number(process.env.MAX_MEMORY_CACHE_ENTRIES) || 500, 50);
const GDRIVE_LOOKUP_TTL_MS = Math.max(Number(process.env.GDRIVE_LOOKUP_TTL_MS) || 2 * 60 * 1000, 10 * 1000);
const GDRIVE_CONTENT_TTL_MS = Math.max(Number(process.env.GDRIVE_CONTENT_TTL_MS) || 5 * 60 * 1000, 30 * 1000);
const cacheStore = new Map();
const trackInFlight = new Map();
const searchInFlight = new Map();
const gdriveFileNameCache = new Map();
const gdriveQueryCache = new Map();
const gdriveDownloadCache = new Map();
const tidalAuthState = { accessToken: null, expiresAt: 0 };

const trimMap = (map, maxEntries = MAX_MEMORY_CACHE_ENTRIES) => {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
};

const getTtlMapValue = (map, key) => {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
};

const setTtlMapValue = (map, key, value, ttlMs, maxEntries = MAX_MEMORY_CACHE_ENTRIES) => {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  trimMap(map, maxEntries);
};

const runSingleFlight = (map, key, fn) => {
  const existing = map.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => map.delete(key));
  map.set(key, promise);
  trimMap(map, MAX_MEMORY_CACHE_ENTRIES);
  return promise;
};

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
  trimMap(cacheStore);
};

const hasOfficialTidalSearchConfig = () => (
  isNonEmpty(process.env.TIDAL_CLIENT_ID) &&
  isNonEmpty(process.env.TIDAL_CLIENT_SECRET)
);

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
  const cacheKey = `${folderId}:${fileName}`;
  const cached = getTtlMapValue(gdriveFileNameCache, cacheKey);
  if (cached !== undefined) return cached;

  const q = `name = '${fileName}' and '${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const resp = await gdriveRequest('GET', url, null);
  const files = resp.data?.files || [];
  const file = files[0] || null;
  setTtlMapValue(gdriveFileNameCache, cacheKey, file, GDRIVE_LOOKUP_TTL_MS);
  return file;
}

async function findGDriveFileByQuery(query) {
  const cached = getTtlMapValue(gdriveQueryCache, query);
  if (cached !== undefined) return cached;

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5`;
  const resp = await gdriveRequest('GET', url, null);
  const files = resp.data?.files || [];
  setTtlMapValue(gdriveQueryCache, query, files, Math.min(GDRIVE_LOOKUP_TTL_MS, 30 * 1000));
  return files;
}

async function downloadGDriveFile(fileId) {
  const cached = getTtlMapValue(gdriveDownloadCache, fileId);
  if (cached !== undefined) return cached;

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const resp = await gdriveRequest('GET', url, null, { 'Accept': 'application/json' });
  setTtlMapValue(gdriveDownloadCache, fileId, resp.data, GDRIVE_CONTENT_TTL_MS);
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
  const fileId = resp.data?.id;
  if (fileId) {
    setTtlMapValue(gdriveFileNameCache, `${folderId}:${fileName}`, { id: fileId, name: fileName, mimeType }, GDRIVE_LOOKUP_TTL_MS);
    gdriveQueryCache.clear();
  }
  return fileId;
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
  gdriveDownloadCache.delete(fileId);
}

async function _loadLyricsCacheFromGDrive(cacheKey, sources) {
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
      let parsedContent = content;
      if (typeof content === 'string') {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          parsedContent = content;
        }
      }
      if (hasMangledGzipField(parsedContent)) {
        console.warn('[lyrics-cache] GDrive cache corrupta (gzip mangled), se ignora:', fileName);
        return null;
      }
      return parsedContent;
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
      if (hasMangledGzipField(payload)) {
        console.warn('[lyrics-cache] GDrive cache corrupta (gzip mangled), se ignora:', fileName);
        continue;
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
const _FAST_SEARCH_POOL = 4;
const FAST_TRACK_POOL = 4;
const parsedSearchApiPool = Number(process.env.SEARCH_API_POOL);
const SEARCH_API_POOL = Number.isFinite(parsedSearchApiPool) && parsedSearchApiPool > 0
  ? parsedSearchApiPool
  : 6;
const EXHAUSTIVE_SEARCH = process.env.EXHAUSTIVE_SEARCH === 'true';
const SEARCH_TIMEOUT_MS = parsePositiveTimeout(process.env.SEARCH_TIMEOUT_MS, 6500);
const parsedTrackTimeoutMs = Number(process.env.TRACK_TIMEOUT_MS);
const TRACK_TIMEOUT_MS = Number.isFinite(parsedTrackTimeoutMs) && parsedTrackTimeoutMs > 0
  ? parsedTrackTimeoutMs
  : 7000;
const parsedTrackFallbackTimeoutMs = Number(process.env.TRACK_FALLBACK_TIMEOUT_MS);
const TRACK_FALLBACK_TIMEOUT_MS = Number.isFinite(parsedTrackFallbackTimeoutMs) && parsedTrackFallbackTimeoutMs > 0
  ? parsedTrackFallbackTimeoutMs
  : Math.min(TRACK_TIMEOUT_MS, 4500);
const QOBUZ_FALLBACK_ENABLED = process.env.QOBUZ_FALLBACK_ENABLED !== 'false';
const DEFAULT_QOBUZ_API_BASES = ['https://qobuz.itzsantiax.qzz.io, https://qobuz-br-southeast.kennyy.com.br/']; // api oficial in workers and kennyy api
const QOBUZ_API_BASES = dedupeStrings(
  (process.env.QOBUZ_API_BASES || process.env.QOBUZ_API_BASE || DEFAULT_QOBUZ_API_BASES.join(','))
    .toString()
    .split(',')
    .map(normalizeQobuzApiBase)
    .filter(Boolean)
);
const parsedQobuzSearchTimeoutMs = Number(process.env.QOBUZ_SEARCH_TIMEOUT_MS);
const QOBUZ_SEARCH_TIMEOUT_MS = Number.isFinite(parsedQobuzSearchTimeoutMs) && parsedQobuzSearchTimeoutMs > 0
  ? parsedQobuzSearchTimeoutMs
  : 8000;
const parsedQobuzDownloadTimeoutMs = Number(process.env.QOBUZ_DOWNLOAD_TIMEOUT_MS);
const QOBUZ_DOWNLOAD_TIMEOUT_MS = Number.isFinite(parsedQobuzDownloadTimeoutMs) && parsedQobuzDownloadTimeoutMs > 0
  ? parsedQobuzDownloadTimeoutMs
  : 10000;

// ==================== AMAZON MUSIC FALLBACK (amz.spotisaver.net) ====================
const AMAZON_FALLBACK_ENABLED = process.env.AMAZON_FALLBACK_ENABLED !== 'false';
const DEFAULT_AMAZON_API_BASES = ['https://amz.spotisaver.net'];
const AMAZON_API_BASES = dedupeStrings(
  (process.env.AMAZON_API_BASES || process.env.AMAZON_API_BASE || DEFAULT_AMAZON_API_BASES.join(','))
    .toString()
    .split(',')
    .map(normalizeAmazonApiBase)
    .filter(Boolean)
);
const parsedAmazonSearchTimeoutMs = Number(process.env.AMAZON_SEARCH_TIMEOUT_MS);
const AMAZON_SEARCH_TIMEOUT_MS = Number.isFinite(parsedAmazonSearchTimeoutMs) && parsedAmazonSearchTimeoutMs > 0
  ? parsedAmazonSearchTimeoutMs
  : 9000;
const parsedAmazonStreamTimeoutMs = Number(process.env.AMAZON_STREAM_TIMEOUT_MS);
const AMAZON_STREAM_TIMEOUT_MS = Number.isFinite(parsedAmazonStreamTimeoutMs) && parsedAmazonStreamTimeoutMs > 0
  ? parsedAmazonStreamTimeoutMs
  : 12000;
// Calidad por defecto para Amazon (SD_HIGH / HD_44 / UHD_96 / UHD_192)
const AMAZON_QUALITY = (process.env.AMAZON_QUALITY || '').toString().trim() || 'SD_HIGH';
// Amazon requiere un .wvd (Widevine device file) para descifrar claves
const AMAZON_WVD_PATH = (process.env.AMAZON_WVD_PATH || '').toString().trim() || '';


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
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
const isPagesDevOrigin = (origin) => {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host.endsWith('.pages.dev');
  } catch {
    return false;
  }
};
const isLocalhostOrigin = (origin) => {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};
const ALLOW_LOCALHOST_ORIGIN = process.env.ALLOW_LOCALHOST === 'true'
  || process.env.NODE_ENV !== 'production';
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://yupify-reworked.vercel.app',
      'https://yupify.qzz.io',
      'https://yupify.pages.dev',
      'https://yupify-reworked.onrender.com',
      'tauri://localhost',
      'https://tauri.localhost',
      'http://tauri.localhost',
      'app://localhost'
    ];
    
    // Permitir si está en la lista, si no tiene origin (server-to-server), o si es wildcard
    if (!origin
      || allowedOrigins.includes(origin)
      || isPagesDevOrigin(origin)
      || (ALLOW_LOCALHOST_ORIGIN && isLocalhostOrigin(origin))
      || process.env.CORS_ORIGIN === '*'
      || process.env.CORS_ORIGIN === origin
    ) {
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

// APIs de HiFi disponibles (algunas antiguos estan muertas)
const HIFI_APIS = {
  official: [
    'https://hifi-one.itzsantiax.qzz.io',
    'https://hifi-two.itzsantiax.qzz.io',
  ],
  monochrome: [
    'https://ohio-1.monochrome.tf',
    'https://singapore-1.monochrome.tf',
    'https://frankfurt-1.monochrome.tf',
    'https://eu-central.monochrome.tf',
    'https://us-west.monochrome.tf',
    'https://1.frankfurt.monochrome.tf',
    'https://1.oregon.monochrome.tf',
    'https://2.frankfurt.monochrome.tf',
    'https://2.oregon.monochrome.tf',
    'https://3.frankfurt.monochrome.tf',
    'https://3.oregon.monochrome.tf',
    'https://4.frankfurt.monochrome.tf',
    'https://4.oregon.monochrome.tf',
    'https://5.frankfurt.monochrome.tf',
    'https://5.oregon.monochrome.tf',
    'https://6.frankfurt.monochrome.tf',
    'https://6.oregon.monochrome.tf',
    'https://7.frankfurt.monochrome.tf',
    'https://7.oregon.monochrome.tf',
    'https://8.frankfurt.monochrome.tf',
    'https://8.oregon.monochrome.tf',
    'https://9.frankfurt.monochrome.tf',
    'https://9.oregon.monochrome.tf',
    'https://10.frankfurt.monochrome.tf',
    'https://10.oregon.monochrome.tf',
    'https://arran.monochrome.tf',
    'https://api.monochrome.tf',
    'https://monochrome-api.samidy.com'
  ],
  squid: [
    'https://triton.squid.wtf'
  ],
  qqdl: [
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://katze.qqdl.site',
    'https://hund.qqdl.site'
  ],
  community: [
    'https://hifi.rhythmax.workers.dev',
    'https://hifi-2tzpyfhd.geeked.wtf',
    'https://hifi-two.spotisaver.net',
    'https://hifi-spo.spotisaver.net',
    'https://hifi-api2.spotisaver.net',
    'https://hifi-api3.spotisaver.net',
    'https://hifi-api4.spotisaver.net',
    'https://hifi-api5.spotisaver.net',
    'https://hifi-api6.spotisaver.net',
    'https://hifi-one.spotisaver.net'
  ],
  kinoplus: [
    'https://tidal.kinoplus.online/'
  ]
};

const HIFI_UPTIME_URL = (process.env.HIFI_UPTIME_URL || 'https://tidal-uptime.geeked.wtf/').toString().trim() || 'https://tidal-uptime.geeked.wtf/';
const parsedHifiUptimeTtl = Number(process.env.HIFI_UPTIME_TTL_MS);
const HIFI_UPTIME_TTL_MS = Number.isFinite(parsedHifiUptimeTtl) && parsedHifiUptimeTtl >= 0
  ? parsedHifiUptimeTtl
  : 60 * 1000;
const HIFI_UPTIME_TIMEOUT_MS = 5000;
const parsedHifiHealthTtl = Number(process.env.HIFI_HEALTH_TTL_MS);
const HIFI_HEALTH_TTL_MS = Number.isFinite(parsedHifiHealthTtl) && parsedHifiHealthTtl >= 0
  ? parsedHifiHealthTtl
  : 60 * 1000;
const HIFI_HEALTH_TIMEOUT_MS = 3000;
const hifiApiState = {
  apis: [],
  apiType: null,
  fetchedAt: 0,
  source: 'local',
  lastUpdated: null,
  lastError: null,
  inFlight: null
};
const hifiHealthState = {
  activeApis: [],
  apiStatuses: [],
  checkedAt: 0,
  inFlight: null
};

function normalizeHifiApi(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  let api = (raw || '').toString().trim();
  if (!api) return '';
  if (!/^https?:\/\//i.test(api)) {
    api = `https://${api}`;
  }
  try {
    const parsed = new URL(api);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function dedupeHifiApis(values) {
  const seen = new Set();
  const apis = [];
  for (const value of values || []) {
    const api = normalizeHifiApi(value);
    if (!api || seen.has(api)) continue;
    seen.add(api);
    apis.push(api);
  }
  return apis;
}

function getLocalHifiApis() {
  return dedupeHifiApis(Object.values(HIFI_APIS).flat());
}

async function fetchHifiUptimeApis() {
  const response = await axiosFast.get(HIFI_UPTIME_URL, { timeout: HIFI_UPTIME_TIMEOUT_MS });
  const payload = response.data || {};
  const apis = dedupeHifiApis(Array.isArray(payload.api) ? payload.api : []);
  if (apis.length === 0) {
    throw new Error('HIFI uptime returned no active API endpoints');
  }
  return {
    apis,
    lastUpdated: typeof payload.lastUpdated === 'string' ? payload.lastUpdated : null
  };
}

async function getUptimeHifiApis() {
  const now = Date.now();
  const cacheIsFresh = hifiApiState.apis.length > 0
    && hifiApiState.apiType === 'uptime'
    && (HIFI_UPTIME_TTL_MS === 0 ? false : now - hifiApiState.fetchedAt < HIFI_UPTIME_TTL_MS);

  if (cacheIsFresh) {
    hifiApiState.source = 'uptime-cache';
    return hifiApiState.apis;
  }

  if (!hifiApiState.inFlight) {
    hifiApiState.inFlight = fetchHifiUptimeApis()
      .then(({ apis, lastUpdated }) => {
        hifiApiState.apis = apis;
        hifiApiState.apiType = 'uptime';
        hifiApiState.fetchedAt = Date.now();
        hifiApiState.source = 'uptime';
        hifiApiState.lastUpdated = lastUpdated;
        hifiApiState.lastError = null;
        return apis;
      })
      .catch((err) => {
        hifiApiState.lastError = err?.message || String(err);
        if (hifiApiState.apis.length > 0 && hifiApiState.apiType === 'uptime') {
          hifiApiState.source = 'uptime-cache';
          return hifiApiState.apis;
        }
        hifiApiState.source = 'local';
        return [];
      })
      .finally(() => {
        hifiApiState.inFlight = null;
      });
  }

  return hifiApiState.inFlight;
}

async function getHifiApiFallbackGroups(options = {}) {
  const localApis = getLocalHifiApis();
  const localSet = new Set(localApis);
  const waitForUptime = options?.waitForUptime !== false;
  let uptimeApis = [];
  if (waitForUptime) {
    uptimeApis = (await getUptimeHifiApis()).filter(api => !localSet.has(api));
  } else {
    uptimeApis = hifiApiState.apiType === 'uptime'
      ? hifiApiState.apis.filter(api => !localSet.has(api))
      : [];
    getUptimeHifiApis().catch(() => []);
  }
  const groups = [];
  if (localApis.length > 0) groups.push({ source: 'local', apis: localApis });
  if (uptimeApis.length > 0) groups.push({ source: 'uptime', apis: uptimeApis });
  return groups;
}

async function getAvailableHifiApis(options = {}) {
  const groups = await getHifiApiFallbackGroups({ waitForUptime: options?.waitForUptime });
  if (options?.waitForHealth === false) {
    getActiveHifiApiStatuses().catch(() => []);
  } else {
    await getActiveHifiApiStatuses();
  }
  const apis = dedupeHifiApis(groups.flatMap(group => orderHifiApisByLatency(group.apis)));
  hifiApiState.source = groups.some(group => group.source === 'uptime')
    ? 'local-first+uptime-fallback'
    : 'local-first';
  return apis;
}

async function getSearchHifiApis() {
  const apis = await getAvailableHifiApis({ waitForUptime: false, waitForHealth: false });
  return EXHAUSTIVE_SEARCH ? apis : apis.slice(0, SEARCH_API_POOL);
}

function getHifiLatencyWeight(responseTimeMs) {
  const latency = Number(responseTimeMs);
  if (!Number.isFinite(latency) || latency <= 0) return 0;
  return Number((1000 / Math.max(latency, 50)).toFixed(3));
}

function compareHifiApiStatus(a, b) {
  if (Boolean(a.ok) !== Boolean(b.ok)) return a.ok ? -1 : 1;
  const aLatency = Number.isFinite(Number(a.responseTimeMs)) ? Number(a.responseTimeMs) : Number.MAX_SAFE_INTEGER;
  const bLatency = Number.isFinite(Number(b.responseTimeMs)) ? Number(b.responseTimeMs) : Number.MAX_SAFE_INTEGER;
  if (aLatency !== bLatency) return aLatency - bLatency;
  return (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0);
}

function getHifiStatusMap() {
  const statuses = hifiHealthState.apiStatuses.length > 0
    ? hifiHealthState.apiStatuses
    : hifiHealthState.activeApis;
  return new Map((statuses || []).map(status => [normalizeHifiApi(status.api), status]));
}

function orderHifiApisByLatency(apis) {
  const normalizedApis = dedupeHifiApis(apis);
  const statusByApi = getHifiStatusMap();
  if (statusByApi.size === 0) return normalizedApis;

  return normalizedApis
    .map((api, index) => {
      const status = statusByApi.get(normalizeHifiApi(api));
      const knownActive = Boolean(status?.ok);
      const knownInactive = Boolean(status && !status.ok);
      const responseTimeMs = Number(status?.responseTimeMs);
      const latencyRank = knownActive && Number.isFinite(responseTimeMs)
        ? responseTimeMs
        : Number.MAX_SAFE_INTEGER;
      return {
        api,
        index,
        bucket: knownActive ? 0 : (knownInactive ? 2 : 1),
        latencyRank
      };
    })
    .sort((a, b) => (
      a.bucket - b.bucket
      || a.latencyRank - b.latencyRank
      || a.index - b.index
    ))
    .map(entry => entry.api);
}

async function getLatencyRankedHifiApiFallbackGroups(options = {}) {
  const groups = await getHifiApiFallbackGroups({ waitForUptime: options?.waitForUptime });
  if (options?.waitForHealth === false) {
    getActiveHifiApiStatuses().catch(() => []);
  } else {
    await getActiveHifiApiStatuses();
  }
  return groups
    .map(group => ({ ...group, apis: orderHifiApisByLatency(group.apis) }))
    .filter(group => group.apis.length > 0);
}

async function checkHifiApiStatus(api, source, orderIndex = 0) {
  const startedAt = Date.now();
  try {
    const response = await axiosFast.get(api, {
      timeout: HIFI_HEALTH_TIMEOUT_MS,
      validateStatus: () => true
    });
    const responseTimeMs = Date.now() - startedAt;
    const version = String(response?.data?.version || '').trim();
    const ok = response.status >= 200 && response.status < 300 && /^2\./.test(version);
    return {
      api,
      url: api,
      source,
      status: response.status,
      ok,
      active: ok,
      orderIndex,
      version: version || null,
      responseTimeMs,
      latencyMs: responseTimeMs,
      weight: getHifiLatencyWeight(responseTimeMs),
      checkedAt: new Date().toISOString(),
      message: `${api} ${response.status} (${responseTimeMs}ms${ok ? ' OK' : ' inactive'})`
    };
  } catch (err) {
    const responseTimeMs = Date.now() - startedAt;
    return {
      api,
      url: api,
      source,
      status: err?.response?.status || null,
      ok: false,
      active: false,
      orderIndex,
      version: null,
      responseTimeMs,
      latencyMs: responseTimeMs,
      weight: 0,
      checkedAt: new Date().toISOString(),
      error: err?.code || err?.message || String(err),
      message: `${api} failed (${responseTimeMs}ms)`
    };
  }
}

async function getActiveHifiApiStatuses(options = {}) {
  const force = options?.force === true;
  const now = Date.now();
  const cacheIsFresh = hifiHealthState.activeApis.length > 0
    && (HIFI_HEALTH_TTL_MS === 0 ? false : now - hifiHealthState.checkedAt < HIFI_HEALTH_TTL_MS);

  if (!force && cacheIsFresh) {
    return hifiHealthState.activeApis;
  }

  if (!hifiHealthState.inFlight) {
    hifiHealthState.inFlight = getHifiApiFallbackGroups()
      .then(async (groups) => {
        const seen = new Set();
        let orderIndex = 0;
        const checks = [];
        for (const group of groups) {
          for (const api of group.apis) {
            if (seen.has(api)) continue;
            seen.add(api);
            checks.push(checkHifiApiStatus(api, group.source, orderIndex));
            orderIndex += 1;
          }
        }
        const apiStatuses = (await Promise.all(checks)).sort(compareHifiApiStatus);
        const activeApis = apiStatuses.filter(status => status.ok).sort(compareHifiApiStatus);
        hifiHealthState.apiStatuses = apiStatuses;
        hifiHealthState.activeApis = activeApis;
        hifiHealthState.checkedAt = Date.now();
        return activeApis;
      })
      .catch(() => hifiHealthState.activeApis)
      .finally(() => {
        hifiHealthState.inFlight = null;
      });
  }

  return hifiHealthState.inFlight;
}

async function getRandomAPI() {
  const localAPIs = getLocalHifiApis();
  const allAPIs = localAPIs.length > 0 ? localAPIs : await getUptimeHifiApis();
  await getActiveHifiApiStatuses();
  const rankedApis = orderHifiApisByLatency(allAPIs);

  if (rankedApis.length === 0) {
    console.error("No hay APIs HiFi disponibles");
    throw new Error("No hay APIs HiFi disponibles");
  }

  return rankedApis[0];
}

async function _searchInAPI(apiBase, query, limit = 1) {
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

  const allAPIs = await getSearchHifiApis();
  const requests = allAPIs.map(api =>
    axiosFast.get(`${api}/search/?s=${encodeURIComponent(query)}&li=${limit}&offset=0`, { timeout: SEARCH_TIMEOUT_MS })
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

async function getOfficialTidalAccessToken() {
  if (tidalAuthState.accessToken && tidalAuthState.expiresAt > Date.now() + 10_000) {
    return tidalAuthState.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.TIDAL_CLIENT_ID,
    client_secret: process.env.TIDAL_CLIENT_SECRET
  }).toString();

  const response = await axios.post(
    'https://auth.tidal.com/v1/oauth2/token',
    body,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    }
  );

  const data = response.data || {};
  if (!data.access_token) {
    throw new Error('No access_token returned from TIDAL OAuth');
  }

  tidalAuthState.accessToken = data.access_token;
  tidalAuthState.expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  return tidalAuthState.accessToken;
}

function getOfficialTidalSearchConfig({ q, s, a, al, v, p, i }) {
  if (a) return { query: a, types: 'ARTISTS', kind: 'artist', bucket: 'artists' };
  if (al) return { query: al, types: 'ALBUMS', kind: 'album', bucket: 'albums' };
  if (v) return { query: v, types: 'VIDEOS', kind: 'video', bucket: 'videos' };
  if (p) return { query: p, types: 'PLAYLISTS', kind: 'playlist', bucket: 'playlists' };
  if (i) return { query: i, types: 'TRACKS', kind: 'track', bucket: 'tracks' };
  const query = q || s || '';
  return {
    query,
    types: 'ARTISTS,ALBUMS,TRACKS,VIDEOS,PLAYLISTS',
    kind: 'track',
    bucket: 'tracks',
    global: true
  };
}

function normalizeOfficialTidalImageCover(imageId) {
  if (!imageId || typeof imageId !== 'string') return null;
  const normalized = imageId.replace(/-/g, '/');
  return normalized || null;
}

function matchesOfficialTidalBucket(item, bucket) {
  if (!item || typeof item !== 'object') return false;

  if (bucket === 'artists') {
    return isNonEmpty(item.name) && !item.title && !item.album && !item.audioQuality && !item.videoQuality;
  }

  if (bucket === 'albums') {
    return Boolean(item.title || item.name) && !item.audioQuality && !item.videoQuality
      && (item.numberOfTracks != null || item.releaseDate || item.cover || item.imageCover);
  }

  if (bucket === 'videos') {
    return !item.audioQuality && Boolean(item.videoQuality || item.squareImage || item.imageId);
  }

  if (bucket === 'playlists') {
    return !item.audioQuality && !item.videoQuality
      && Boolean(item.uuid || item.squareImage || item.description != null);
  }

  return true;
}

function normalizeOfficialTidalSearchItem(item, bucket) {
  if (!item || typeof item !== 'object') return item;

  if (bucket === 'artists') {
    return {
      id: item.id,
      name: item.name || '',
      title: item.name || '',
      artist: item.name || '',
      cover: normalizeOfficialTidalImageCover(item.picture || item.imageId || item.squareImage),
      popularity: item.popularity ?? null,
      type: 'artist'
    };
  }

  if (bucket === 'albums') {
    return {
      id: item.id,
      title: item.title || item.name || '',
      name: item.title || item.name || '',
      artist: item.artists?.[0]?.name || item.artist?.name || '',
      artists: Array.isArray(item.artists) ? item.artists.map(a => ({ id: a.id, name: a.name })) : [],
      album: { title: item.title || item.name || '', cover: normalizeOfficialTidalImageCover(item.imageCover || item.cover) },
      cover: normalizeOfficialTidalImageCover(item.imageCover || item.cover),
      releaseDate: item.releaseDate || null,
      numberOfTracks: item.numberOfTracks ?? null,
      type: 'album'
    };
  }

  if (bucket === 'videos') {
    const cover = normalizeOfficialTidalImageCover(item.imageId || item.squareImage || item.album?.cover);
    return {
      id: item.id,
      title: item.title || item.name || '',
      version: item.version || null,
      artist: item.artists?.map(a => a.name).filter(Boolean).join(', ') || item.artist?.name || '',
      artists: Array.isArray(item.artists) ? item.artists.map(a => ({ id: a.id, name: a.name })) : [],
      cover,
      coverUrl: buildCoverUrlFromTrack({ cover }, 1280, 720),
      duration: item.duration ?? null,
      quality: item.videoQuality || item.quality || null,
      type: 'video'
    };
  }

  if (bucket === 'playlists') {
    return {
      id: item.uuid || item.id,
      uuid: item.uuid || item.id,
      title: item.title || item.name || '',
      name: item.title || item.name || '',
      description: item.description || '',
      squareImage: item.squareImage || null,
      cover: normalizeOfficialTidalImageCover(item.squareImage),
      numberOfTracks: item.numberOfTracks ?? null,
      type: 'playlist'
    };
  }

  return {
    id: item.id,
    trackId: item.id,
    title: item.title || item.name || '',
    version: item.version || null,
    artist: item.artists?.[0]?.name || item.artist?.name || '',
    artists: Array.isArray(item.artists) ? item.artists.map(a => ({ id: a.id, name: a.name })) : [],
    cover: normalizeOfficialTidalImageCover(
      item.imageCover
      || item.imageId
      || item.squareImage
      || item.cover
      || item.album?.cover
    ),
    album: item.album
      ? {
          id: item.album.id,
          title: item.album.title || '',
          cover: normalizeOfficialTidalImageCover(
            item.album.imageCover
            || item.album.imageId
            || item.album.squareImage
            || item.album.cover
          )
        }
      : undefined,
    duration: item.duration ?? null,
    explicit: Boolean(item.explicit),
    popularity: item.popularity ?? null,
    isrc: item.isrc || null,
    audioQuality: item.audioQuality || item.quality || null,
    quality: item.audioQuality || item.quality || null,
    mediaMetadata: item.mediaMetadata || {
      tags: [
        item.audioQuality,
        item.audioModes?.[0],
        item.audioMode
      ].filter(Boolean)
    },
    type: 'track'
  };
}

async function searchOfficialTidal({ q, s, a, al, v, p, i, limit = 20, offset = 0 }) {
  const config = getOfficialTidalSearchConfig({ q, s, a, al, v, p, i });
  if (!config.query) {
    return { version: 'tidal-official', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] } };
  }

  const accessToken = await getOfficialTidalAccessToken();
  const countryCode = (process.env.TIDAL_COUNTRY_CODE || 'US').toString().trim() || 'US';
  const params = new URLSearchParams({
    query: config.query,
    limit: String(limit),
    offset: String(offset || 0),
    types: config.types,
    countryCode
  });

  const response = await axios.get(`https://api.tidal.com/v1/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeout: SEARCH_TIMEOUT_MS
  });

  const raw = response.data || {};
  if (config.global) {
    const normalizeBucket = (bucketName) => {
      const bucket = raw?.[bucketName] || {};
      const items = Array.isArray(bucket?.items)
        ? bucket.items
            .filter(item => matchesOfficialTidalBucket(item, bucketName))
            .map(item => normalizeOfficialTidalSearchItem(item, bucketName))
        : [];
      return {
        limit: Number(bucket?.limit ?? limit),
        offset: Number(bucket?.offset ?? offset) || 0,
        totalNumberOfItems: Number(bucket?.totalNumberOfItems ?? bucket?.total ?? items.length ?? 0),
        items
      };
    };

    const sections = {
      tracks: normalizeBucket('tracks'),
      artists: normalizeBucket('artists'),
      albums: normalizeBucket('albums'),
      videos: normalizeBucket('videos'),
      playlists: normalizeBucket('playlists')
    };

    const topHitType = String(raw?.topHit?.type || '').toUpperCase();
    const topHitBucket = topHitType === 'ARTISTS'
      ? 'artists'
      : topHitType === 'ALBUMS'
        ? 'albums'
        : topHitType === 'VIDEOS'
          ? 'videos'
          : topHitType === 'PLAYLISTS'
            ? 'playlists'
            : 'tracks';
    const topHitValue = raw?.topHit?.value
      ? normalizeOfficialTidalSearchItem(raw.topHit.value, topHitBucket)
      : null;

    return {
      version: 'tidal-official',
      topHit: topHitValue ? { type: topHitBucket, value: topHitValue } : null,
      sections,
      data: sections.tracks
    };
  }

  const bucket = raw?.[config.bucket] || {};
  const items = Array.isArray(bucket?.items)
    ? bucket.items
        .filter(item => matchesOfficialTidalBucket(item, config.bucket))
        .map(item => normalizeOfficialTidalSearchItem(item, config.bucket))
    : [];
  const total = Number(bucket?.totalNumberOfItems ?? bucket?.total ?? items.length ?? 0);

  return {
    version: 'tidal-official',
    data: {
      limit: Number(limit),
      offset: Number(offset) || 0,
      totalNumberOfItems: total,
      items
    }
  };
}

function normalizeSearchText(value) {
  if (!value) return '';
  const text = String(value).toLowerCase();
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return normalized
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchTitle(item) {
  if (!item) return '';
  return (
    item.title ||
    item.name ||
    item.trackTitle ||
    item.track?.title ||
    item.track?.name ||
    item.data?.title ||
    ''
  );
}

function getSearchArtist(item) {
  if (!item) return '';
  if (item.artistName) return item.artistName;
  if (item.artist?.name) return item.artist.name;
  if (typeof item.artist === 'string') return item.artist;
  if (Array.isArray(item.artists) && item.artists.length > 0) {
    return item.artists.map(a => a?.name || a).filter(Boolean).join(', ');
  }
  if (item.track) return getArtistString(item.track);
  return getArtistString(item);
}

function getSearchAlbum(item) {
  if (!item) return '';
  return (
    item.albumTitle ||
    item.album?.title ||
    item.album?.name ||
    item.albumName ||
    ''
  );
}

function buildSearchQueryInfo(rawQuery, kind) {
  const normalized = normalizeSearchText(rawQuery);
  const tokens = normalized ? normalized.split(' ').filter(Boolean) : [];
  return { raw: rawQuery || '', normalized, tokens, kind: kind || 'track' };
}

function scoreSearchItem(item, queryInfo) {
  if (!item || !queryInfo?.normalized) return 0;
  const { normalized: q, tokens, kind } = queryInfo;

  const title = normalizeSearchText(getSearchTitle(item));
  const artist = normalizeSearchText(getSearchArtist(item));
  const album = normalizeSearchText(getSearchAlbum(item));
  const target = kind === 'artist' ? artist : kind === 'album' ? album : title;

  if (!target) return 0;

  let score = 0;
  if (target === q) score += 1000;
  if (target.startsWith(q) && target !== q) score += 600;
  if (target.includes(q) && target !== q) score += 450;
  if (q.includes(target) && target.length >= 3) score += 120;

  if (tokens.length > 0) {
    let matches = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (target.includes(t)) matches += 1;
    }
    score += Math.round((matches / tokens.length) * 200);
  }

  if (kind === 'track' && artist) {
    let artistMatches = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (artist.includes(t)) artistMatches += 1;
    }
    score += Math.round((artistMatches / Math.max(1, tokens.length)) * 60);
  }

  const lenDiff = Math.abs(target.length - q.length);
  score += Math.max(0, 40 - Math.min(40, lenDiff));

  return score;
}

function rankSearchItems(items, rawQuery, kind = 'track') {
  if (!Array.isArray(items) || items.length === 0) return items;
  const queryInfo = buildSearchQueryInfo(rawQuery, kind);
  if (!queryInfo.normalized) return items;

  const scored = items.map((item, index) => ({
    item,
    index,
    score: scoreSearchItem(item, queryInfo)
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map(s => s.item);
}

function applySearchRanking(payload, rawQuery, kind) {
  if (!payload || !payload.data || !Array.isArray(payload.data.items)) return payload;
  const ranked = rankSearchItems(payload.data.items, rawQuery, kind);
  if (ranked === payload.data.items) return payload;
  return {
    ...payload,
    data: {
      ...payload.data,
      items: ranked
    }
  };
}

function hasStrongSearchMatch(items, rawQuery, kind) {
  if (!Array.isArray(items) || items.length === 0) return false;
  const queryInfo = buildSearchQueryInfo(rawQuery, kind);
  if (!queryInfo.normalized) return true;
  return items.some(item => scoreSearchItem(item, queryInfo) >= 900);
}

function dedupeSearchItems(items) {
  const uniqueItems = [];
  const seen = new Set();
  for (const item of items || []) {
    const idKey = item?.id ?? item?.trackId ?? item?.uuid ?? JSON.stringify(item);
    if (!seen.has(idKey)) {
      seen.add(idKey);
      uniqueItems.push(item);
    }
  }
  return uniqueItems;
}

function filterSearchItemsByKind(items, kind = 'track') {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (kind === 'track') return items;

  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;

    const looksLikeTrack = Boolean(
      item.audioQuality
      || item.streamReady
      || item.allowStreaming
      || item.isrc
      || item.replayGain != null
      || item.trackNumber != null
      || item.duration != null
    );

    if (kind === 'artist') {
      return !looksLikeTrack && Boolean(item.name) && !item.album;
    }

    if (kind === 'album') {
      return !looksLikeTrack && Boolean(
        item.cover
        || item.imageCover
        || item.releaseDate
        || item.numberOfTracks != null
      );
    }

    if (kind === 'video') {
      return !item.audioQuality && Boolean(
        item.videoQuality
        || item.squareImage
        || item.imageId
        || item.type === 'video'
      );
    }

    if (kind === 'playlist') {
      return !looksLikeTrack && Boolean(
        item.uuid
        || item.squareImage
        || item.description != null
        || item.numberOfTracks != null
      );
    }

    return true;
  });
}

async function runLegacySearchQuery({ searchQuery, rawQuery, kind, limit, offset }) {
  const envSearch = process.env.SEARCH_API && process.env.SEARCH_API.trim()
    ? process.env.SEARCH_API.replace(/\/+$/, '')
    : null;

  if (envSearch) {
    const url = `${envSearch}/search/?${searchQuery}&li=${limit}&offset=${offset}`;
    const response = await axiosFast.get(url, { timeout: SEARCH_TIMEOUT_MS });
    const remote = response.data || {};

    let items = [];
    let total = 0;
    let resolvedOffset = Number(offset) || 0;
    let resolvedLimit = Number(limit);

    if (remote.data && Array.isArray(remote.data.items)) {
      items = remote.data.items;
      total = remote.data.totalNumberOfItems ?? remote.data.total ?? items.length;
      resolvedOffset = Number(remote.data.offset ?? resolvedOffset) || 0;
      resolvedLimit = Number(remote.data.limit ?? resolvedLimit);
    } else if (Array.isArray(remote.items)) {
      items = remote.items;
      total = remote.total ?? remote.totalNumberOfItems ?? items.length;
      resolvedOffset = Number(remote.offset ?? resolvedOffset) || 0;
      resolvedLimit = Number(remote.limit ?? resolvedLimit);
    }

    const filteredItems = filterSearchItemsByKind(dedupeSearchItems(items), kind);
    const rankedItems = rankSearchItems(filteredItems, rawQuery, kind);
    return {
      version: remote.version || '2.4',
      data: {
        limit: Number.isFinite(resolvedLimit) ? resolvedLimit : Number(limit),
        offset: resolvedOffset,
        totalNumberOfItems: Number(total ?? rankedItems.length) || rankedItems.length,
        items: rankedItems
      }
    };
  }

  const allAPIs = await getSearchHifiApis();
  const requests = allAPIs.map(api =>
    axiosFast.get(`${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`, { timeout: SEARCH_TIMEOUT_MS })
      .then(r => ({ ok: true, data: r.data }))
      .catch(() => ({ ok: false }))
  );

  const responses = await Promise.all(requests);
  const combinedItems = responses
    .filter(r => r.ok && r.data)
    .flatMap(r => r.data?.data?.items ?? r.data?.items ?? []);

  const filteredItems = filterSearchItemsByKind(dedupeSearchItems(combinedItems), kind);
  const rankedItems = rankSearchItems(filteredItems, rawQuery, kind);
  return {
    version: '2.4',
    data: {
      limit: Number(limit),
      offset: Number(offset) || 0,
      totalNumberOfItems: rankedItems.length,
      items: rankedItems.slice(0, Number(limit))
    }
  };
}

async function buildLegacyGlobalSearchPayload(rawQuery, limit, offset) {
  const sectionConfigs = [
    { key: 'tracks', param: 's', kind: 'track' },
    { key: 'artists', param: 'a', kind: 'artist' },
    { key: 'albums', param: 'al', kind: 'album' },
    { key: 'videos', param: 'v', kind: 'video' },
    { key: 'playlists', param: 'p', kind: 'playlist' }
  ];

  const sectionResults = await Promise.all(sectionConfigs.map(async ({ key, param, kind }) => {
    const queryParam = `${param}=${encodeURIComponent(rawQuery)}`;
    try {
      const payload = await runLegacySearchQuery({ searchQuery: queryParam, rawQuery, kind, limit, offset });
      return [key, payload?.data || { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] }];
    } catch {
      return [key, { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] }];
    }
  }));

  const sections = Object.fromEntries(sectionResults);
  return {
    version: '2.4',
    topHit: null,
    sections,
    data: sections.tracks || { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: 0, items: [] }
  };
}

async function fetchRecommendationsFromAPIs(params) {
  const allAPIs = await getAvailableHifiApis({ waitForUptime: false, waitForHealth: false });
  const apis = EXHAUSTIVE_SEARCH ? allAPIs : allAPIs.slice(0, SEARCH_API_POOL);
  const requests = apis.map(api =>
    axiosFast.get(`${api}/recommendations/?${params}`, { timeout: SEARCH_TIMEOUT_MS })
      .then(r => {
        const data = r.data;
        const items = data?.data?.items ?? data?.items ?? data?.data;
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error('Empty recommendations');
        }
        return data;
      })
  );

  try {
    return await Promise.any(requests);
  } catch {
    const fallbackRequests = allAPIs
      .slice(apis.length, apis.length + SEARCH_API_POOL)
      .map(api => axiosFast.get(`${api}/recommendations/?${params}`, { timeout: SEARCH_TIMEOUT_MS }).then(r => r.data));
    if (fallbackRequests.length === 0) return null;
    try {
      return await Promise.any(fallbackRequests);
    } catch {
      return null;
    }
  }
}

function isAllowedVideoProxyUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname.endsWith('.tidal.com')
      || hostname === 'resources.tidal.com'
      || hostname.endsWith('.video.tidal.com')
    );
  } catch {
    return false;
  }
}

function isAllowedAudioProxyUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'audio.tidal.com'
      || hostname.endsWith('.audio.tidal.com')
    ) || isAmazonAudioHost(hostname);
  } catch {
    return false;
  }
}

function isAmazonAudioHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return (
    h === 'amazon.com'
    || h.endsWith('.amazon.com')
    || h.endsWith('.amazonaws.com')
    || h.endsWith('.media-amazon.com')
    || h.endsWith('.cloudfront.net')
    || h.endsWith('.amazonmusic.com')
    || h.endsWith('.mzstatic.com')
  );
}

function buildVideoProxyUrl(req, rawUrl) {
  if (!rawUrl || !isAllowedVideoProxyUrl(rawUrl)) return null;
  return `${req.protocol}://${req.get('host')}/api/video/proxy?url=${encodeURIComponent(rawUrl)}`;
}

function buildAudioProxyUrl(req, rawUrl) {
  if (!rawUrl || !isAllowedAudioProxyUrl(rawUrl)) return null;
  return `${req.protocol}://${req.get('host')}/api/audio/proxy?url=${encodeURIComponent(rawUrl)}`;
}

function inferTidalAudioFetchDestination(targetUrl) {
  try {
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    if (pathname.endsWith('.mp4') || pathname.endsWith('.m4s')) {
      return 'video';
    }
  } catch {
    // Ignore parse errors and fall back to audio.
  }
  return 'audio';
}

function buildTidalAudioRequestHeaders(req, targetUrl, options = {}) {
  const readHeader = (name) => {
    if (typeof req?.get === 'function') {
      const value = req.get(name);
      if (value) return value;
    }
    return '';
  };

  const headers = {
    Accept: readHeader('accept') || '*/*',
    'Accept-Language': readHeader('accept-language') || 'es-419,es-US;q=0.9,es;q=0.8,en;q=0.7',
    'Accept-Encoding': 'identity',
    'User-Agent': readHeader('user-agent') || process.env.TIDAL_MEDIA_USER_AGENT || AUDIO_CACHE_DASH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Referer: targetUrl,
    Connection: 'keep-alive'
  };

  const passthroughHeaders = {
    'cache-control': 'Cache-Control',
    'if-modified-since': 'If-Modified-Since',
    'if-none-match': 'If-None-Match',
    pragma: 'Pragma',
    priority: 'Priority',
    range: 'Range',
    'sec-ch-ua': 'Sec-CH-UA',
    'sec-ch-ua-mobile': 'Sec-CH-UA-Mobile',
    'sec-ch-ua-platform': 'Sec-CH-UA-Platform',
    'sec-fetch-dest': 'Sec-Fetch-Dest',
    'sec-fetch-mode': 'Sec-Fetch-Mode',
    'sec-fetch-site': 'Sec-Fetch-Site',
    'sec-gpc': 'Sec-GPC'
  };

  Object.entries(passthroughHeaders).forEach(([incoming, outgoing]) => {
    const value = readHeader(incoming);
    if (value) headers[outgoing] = value;
  });

  if (!headers['Sec-Fetch-Dest']) headers['Sec-Fetch-Dest'] = options.destination || 'audio';
  if (!headers['Sec-Fetch-Mode']) headers['Sec-Fetch-Mode'] = 'no-cors';
  if (!headers['Sec-Fetch-Site']) headers['Sec-Fetch-Site'] = 'same-origin';
  if (!headers['Sec-GPC']) headers['Sec-GPC'] = '1';
  if (!headers.Priority) headers.Priority = 'i';
  if (!headers.Range && options.forceRange !== false) {
    headers.Range = options.range || 'bytes=0-';
  }

  return headers;
}

function absolutizeUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function rewriteM3u8Manifest(manifestText, baseUrl, req) {
  return String(manifestText || '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      const keyMatch = line.match(/URI="([^"]+)"/i);
      if (keyMatch) {
        const absolute = absolutizeUrl(keyMatch[1], baseUrl);
        const proxied = buildVideoProxyUrl(req, absolute);
        return proxied ? line.replace(keyMatch[1], proxied) : line;
      }

      if (trimmed.startsWith('#')) return line;
      const absolute = absolutizeUrl(trimmed, baseUrl);
      const proxied = buildVideoProxyUrl(req, absolute);
      return proxied || line;
    })
    .join('\n');
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
  const invalidChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const cleaned = Array.from(String(value))
    .filter((char) => {
      if (invalidChars.has(char)) return false;
      return char.charCodeAt(0) >= 32;
    })
    .join('');
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, 180) || 'track';
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

function buildCoverUrlFromTrack(track, size = 1280, height = null) {
  if (!track) return null;
  const parsedWidth = Number(size);
  const width = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : 1280;
  const parsedHeight = height == null ? NaN : Number(height);
  const safeHeight = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : width;
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
  return `https://resources.tidal.com/images/${coverId}/${width}x${safeHeight}.jpg`;
}

function inferAudioExtension(url, usedQuality) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '').toLowerCase();
    if (ext) return ext;
  } catch (e) {
    // Ignore malformed URLs and fall back to quality-based inference.
  }
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

function normalizeQualityValue(value) {
  if (!value) return null;
  const raw = String(value).toUpperCase().trim();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_').replace(/_+/g, '_');
  const compact = normalized.replace(/_/g, '');
  if (compact === 'HIRESLOSSLESS' || compact === 'HIRESLOSSLSS') return 'HI_RES_LOSSLESS';
  if (compact === 'HIRES') return 'HI_RES';
  if (compact === 'LOSSLESS' || compact === 'LOSSLSS') return 'LOSSLESS';
  if (compact === 'HIGH') return 'HIGH';
  if (compact === 'LOW') return 'LOW';
  return normalized;
}

function buildAudioMetaPayload({ id, track, usedQuality, nameHint }) {
  if (!track && !id) return null;
  const meta = extractTrackMetadata(track || {}, nameHint || {});
  const albumObj = (track?.album && typeof track.album === 'object')
    ? track.album
    : (meta.albumTitle ? { title: meta.albumTitle } : undefined);
  const duration = track?.duration ?? track?.trackDuration ?? track?.length ?? null;
  const durationMs = track?.durationMs ?? track?.duration_ms ?? null;

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
    "HIGH": ["HIGH", "LOW", "LOSSLESS"],
    "LOW": ["LOW", "HIGH", "LOSSLESS"]
  };
  return qualityFallback[q] || ["LOSSLESS", "HIGH", "LOW"];
}

function isLosslessQuality(quality) {
  const normalized = (quality || '').toString().toUpperCase().trim();
  return normalized === 'HI_RES_LOSSLESS' || normalized === 'LOSSLESS';
}

function getTrackAttemptTimeoutMs(quality, requestedQuality) {
  return quality === requestedQuality ? TRACK_TIMEOUT_MS : TRACK_FALLBACK_TIMEOUT_MS;
}

async function fetchTrackFallbackData({ id, requestedQuality, log = null, req = null }) {
  const qualitiesToTry = getQualityFallbackList(requestedQuality);

  for (const quality of qualitiesToTry) {
    const attemptTimeoutMs = getTrackAttemptTimeoutMs(quality, requestedQuality);
    const fallbackLabel = quality === requestedQuality ? '' : ' fallback';

    // Tidal/HiFi es la fuente prioritaria; si no encuentra, se pasa a las demás.
    log?.(`   -> HiFi${fallbackLabel} calidad: ${quality} (${attemptTimeoutMs}ms)`);
    const hifiSuccess = await fetchFirstTrackFromHifiFallbacks({ id, quality, timeoutMs: attemptTimeoutMs });
    if (hifiSuccess) {
      return {
        success: hifiSuccess,
        usedQuality: normalizeQualityValue(hifiSuccess.data?.usedQuality) || quality,
        matchedQuality: quality,
        attemptedQualities: qualitiesToTry
      };
    }

    log?.(`   -> Qobuz${fallbackLabel} calidad: ${quality} (${attemptTimeoutMs}ms)`);
    const qobuzSuccess = await fetchQobuzFallbackTrackData({ id, quality, timeoutMs: attemptTimeoutMs });
    if (qobuzSuccess) {
      return {
        success: qobuzSuccess,
        usedQuality: normalizeQualityValue(qobuzSuccess.data?.usedQuality) || quality,
        matchedQuality: quality,
        attemptedQualities: qualitiesToTry
      };
    }

    // Amazon Music fallback (DRM: requiere .wvd para descifrar claves)
    log?.(`   -> Amazon fallback calidad: ${quality} (${attemptTimeoutMs}ms)`);
    const amazonSuccess = await fetchAmazonFallbackTrackData({ id, quality, timeoutMs: attemptTimeoutMs, req });
    if (amazonSuccess) {
      return {
        success: amazonSuccess,
        usedQuality: normalizeQualityValue(amazonSuccess.data?.usedQuality) || quality,
        matchedQuality: quality,
        attemptedQualities: qualitiesToTry
      };
    }
  }

  const nonLosslessFallbackQualities = isLosslessQuality(requestedQuality)
    ? qualitiesToTry.filter(quality => !isLosslessQuality(quality))
    : qualitiesToTry;
  for (const quality of nonLosslessFallbackQualities) {
    const attemptTimeoutMs = getTrackAttemptTimeoutMs(quality, requestedQuality);
    log?.(`   -> Qobuz fallback calidad: ${quality} (${attemptTimeoutMs}ms)`);
    const qobuzSuccess = await fetchQobuzFallbackTrackData({ id, quality, timeoutMs: attemptTimeoutMs });
    if (qobuzSuccess) {
      return {
        success: qobuzSuccess,
        usedQuality: normalizeQualityValue(qobuzSuccess.data?.usedQuality) || quality,
        matchedQuality: quality,
        attemptedQualities: qualitiesToTry
      };
    }

    log?.(`   -> Amazon fallback (no-lossless) calidad: ${quality} (${attemptTimeoutMs}ms)`);
    const amazonSuccess = await fetchAmazonFallbackTrackData({ id, quality, timeoutMs: attemptTimeoutMs, req });
    if (amazonSuccess) {
      return {
        success: amazonSuccess,
        usedQuality: normalizeQualityValue(amazonSuccess.data?.usedQuality) || quality,
        matchedQuality: quality,
        attemptedQualities: qualitiesToTry
      };
    }
  }

  return {
    success: null,
    usedQuality: null,
    matchedQuality: null,
    attemptedQualities: qualitiesToTry
  };
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

      try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup error */ }
      try { fs.unlinkSync(outputPath); } catch { /* ignore cleanup error */ }
      try { if (coverPath) fs.unlinkSync(coverPath); } catch { /* ignore cleanup error */ }
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
    } catch {
      // Ignore cleanup errors for temporary files.
    }
    try {
      if (uploadPath !== tempPath) fs.unlinkSync(uploadPath);
    } catch {
      // Ignore cleanup errors for temporary files.
    }
    try {
      if (coverPath) fs.unlinkSync(coverPath);
    } catch {
      // Ignore cleanup errors for temporary files.
    }
    return true;
  } catch (err) {
    console.warn('[audio-cache] failed:', err.message);
    return false;
  } finally {
    audioCacheInFlight.delete(fileName);
  }
}

async function downloadToFile(url, destPath) {
  const requestConfig = {
    responseType: 'stream',
    timeout: 0
  };

  if (isAllowedAudioProxyUrl(url)) {
    requestConfig.headers = buildTidalAudioRequestHeaders(null, url, {
      forceRange: true,
      destination: inferTidalAudioFetchDestination(url)
    });
  }

  const response = await axios.get(url, requestConfig);
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

// Asegura que un payload DASH tenga el manifest inline como string.
// El frontend reproduce el DASH con Shaka Player usando el manifest inline
// (para evitar CORS/token), por lo que si solo viene la URL del .mpd hay que descargarlo.
async function ensureDashManifestString(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!isDashMime(payload?.manifestMimeType)) return payload;
  if (typeof payload?.manifest === 'string' && payload.manifest.trim().length > 0) return payload;

  const mpdUrl = payload?.url || payload?.directUrl || null;
  if (!mpdUrl || !/^https?:\/\//i.test(mpdUrl)) return payload;

  try {
    const resp = await axios.get(mpdUrl, {
      timeout: 10000,
      validateStatus: () => true,
      responseType: 'text'
    });
    if (resp.status >= 200 && resp.status < 300
      && typeof resp.data === 'string'
      && resp.data.trim().length > 0) {
      return { ...payload, manifest: resp.data };
    }
  } catch (e) {
    if (AUDIO_CACHE_DEBUG) {
      console.warn('[dash] no se pudo descargar el manifest:', e?.message);
    }
  }

  return payload;
}

async function resolveTrackForDownload(id, qRaw) {
  const VALID_QUALITIES = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
  const requestedQuality = VALID_QUALITIES.includes(qRaw) ? qRaw : "LOSSLESS";
  const fallback = await fetchTrackFallbackData({ id, requestedQuality });
  const success = fallback.success;
  let usedQuality = fallback.usedQuality;

  if (!success) {
    return { error: "No se pudo obtener el track en ninguna calidad" };
  }

  const respDataBase = { ...success.data };
  const decoded = tryDecodeManifest(respDataBase.manifest);
  if (decoded !== null) {
    respDataBase.manifest = decoded;
  }
  const respData = await ensureDashManifestString(respDataBase);

  let streamUrl = respData.url || null;
  if (!streamUrl && respData.manifest && typeof respData.manifest === 'object' && Array.isArray(respData.manifest.urls)) {
    streamUrl = respData.manifest.urls[0];
    respData.url = streamUrl;
  }

  const reportedQuality = normalizeQualityValue(respData?.audioQuality || respData?.quality || respData?.streamQuality);
  if (isDashMime(respData?.manifestMimeType)) {
    usedQuality = isLosslessQuality(reportedQuality) ? reportedQuality : "HI_RES_LOSSLESS";
  } else if (reportedQuality && VALID_QUALITIES.includes(reportedQuality)) {
    usedQuality = reportedQuality;
  }

  return {
    respData,
    streamUrl,
    usedQuality: normalizeQualityValue(usedQuality) || requestedQuality,
    requestedQuality
  };
}

async function _fetchFirstSearchResult({ apis, searchQuery, limit, offset, timeoutMs = 4500 }) {
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
  const normalizeHifiPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    let result = payload;
    if (result.data && typeof result.data === 'object') {
      const inner = result.data;
      result = (inner && typeof inner.attributes === 'object' && inner.attributes)
        ? { ...inner.attributes, ...inner }
        : { ...inner };
    }
    if (typeof result.uri === 'string' && !result.url) result.url = result.uri;
    if (result.trackPresentation && !result.assetPresentation) result.assetPresentation = result.trackPresentation;
    if (!result.manifestMimeType && typeof result.url === 'string') {
      if (/\.mpd($|\?)/i.test(result.url)) result.manifestMimeType = 'application/dash+xml';
      else if (/\.m3u8($|\?)/i.test(result.url)) result.manifestMimeType = 'application/vnd.apple.mpegurl';
    }
    return result;
  };

  const extractTrackPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    if (data.data && typeof data.data === 'object') return normalizeHifiPayload(data.data);

    if (
      data.manifest != null
      || data.url
      || data.manifestMimeType
      || data.trackId != null
      || data.id != null
    ) {
      return normalizeHifiPayload(data);
    }

    return null;
  };

  const hasUsableTrackStream = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.streamReady === false) return false;

    const presentation = String(payload.assetPresentation || payload.presentation || '').toUpperCase();
    if (presentation === 'PREVIEW') return false;

    if (typeof payload.url === 'string' && payload.url.trim()) return true;
    if (typeof payload.manifest === 'string' && payload.manifest.trim()) return true;
    if (payload.manifest && typeof payload.manifest === 'object') return true;

    return false;
  };

  const requests = apis.map(api => {
    const cleanApi = api.replace(/\/+$/, "");
    const manifestPath = cleanApi.includes('hifi.rhythmax.workers.dev')
      ? '/manifests'
      : '/trackManifests/';
    const url = `${cleanApi}${manifestPath}?id=${encodeURIComponent(id)}&quality=${encodeURIComponent(quality)}`;
    return axiosFast.get(url, { timeout: timeoutMs })
      .then(r => {
        const payload = extractTrackPayload(r.data);
        if (!hasUsableTrackStream(payload)) {
          return Promise.reject(new Error('Invalid track'));
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

async function fetchFirstTrackFromHifiFallbacks({ id, quality, timeoutMs = TRACK_TIMEOUT_MS }) {
  const groups = await getLatencyRankedHifiApiFallbackGroups({
    waitForUptime: false,
    waitForHealth: false
  });
  for (const group of groups) {
    const fastAPIs = group.apis.slice(0, FAST_TRACK_POOL);
    let success = await fetchFirstTrackData({ apis: fastAPIs, id, quality, timeoutMs });
    if (!success && group.apis.length > fastAPIs.length) {
      success = await fetchFirstTrackData({ apis: group.apis, id, quality, timeoutMs });
    }
    if (success) return success;
  }
  return null;
}

function dedupeStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeQobuzApiBase(value) {
  let base = (value || '').toString().trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  try {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeAmazonApiBase(value) {
  return normalizeQobuzApiBase(value);
}

function mapTidalQualityToQobuzQuality(quality) {
  const normalized = (quality || '').toString().toUpperCase().trim();
  if (normalized === 'LOW' || normalized === 'HIGH') return '5';
  return '7';
}

function extractQobuzTrackItems(payload) {
  const items = payload?.data?.tracks?.items
    ?? payload?.tracks?.items
    ?? payload?.data?.items
    ?? payload?.items
    ?? [];
  return Array.isArray(items) ? items : [];
}

function pickQobuzTrack(items, isrc) {
  const normalizedIsrc = (isrc || '').toString().trim().toUpperCase();
  return items.find(item => (
    normalizedIsrc
    && (item?.isrc || '').toString().trim().toUpperCase() === normalizedIsrc
    && item.streamable !== false
  )) || items.find(item => item?.streamable !== false) || null;
}

function getQobuzDownloadUrl(payload) {
  return payload?.data?.url
    || payload?.url
    || payload?.download_url
    || payload?.downloadUrl
    || payload?.stream_url
    || payload?.streamUrl
    || null;
}

function getQobuzUsedQuality(qobuzTrack, requestedQuality) {
  const normalized = (requestedQuality || '').toString().toUpperCase().trim();
  if (normalized === 'LOW' || normalized === 'HIGH') return normalized || 'HIGH';

  const bitDepth = Number(qobuzTrack?.maximum_bit_depth || qobuzTrack?.album?.maximum_bit_depth || 0);
  const sampleRate = Number(qobuzTrack?.maximum_sampling_rate || qobuzTrack?.album?.maximum_sampling_rate || 0);
  if (bitDepth > 16 || sampleRate > 48 || qobuzTrack?.hires || qobuzTrack?.hires_streamable) {
    return 'HI_RES_LOSSLESS';
  }
  return 'LOSSLESS';
}

async function fetchOfficialTidalTrackInfo(id, timeoutMs = TRACK_TIMEOUT_MS) {
  if (!hasOfficialTidalSearchConfig()) return null;
  const accessToken = await getOfficialTidalAccessToken();
  const countryCode = (process.env.TIDAL_COUNTRY_CODE || 'US').toString().trim() || 'US';
  const url = `https://api.tidal.com/v1/tracks/${encodeURIComponent(id)}/?countryCode=${encodeURIComponent(countryCode)}`;
  const response = await axiosFast.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeout: Math.max(timeoutMs, 10000)
  });
  return response.data || null;
}

function buildQobuzFallbackPayload({ id, tidalTrack, qobuzTrack, streamUrl, requestedQuality, qobuzQuality }) {
  const usedQuality = getQobuzUsedQuality(qobuzTrack, requestedQuality);
  const tidalCover = normalizeOfficialTidalImageCover(tidalTrack?.album?.cover || tidalTrack?.cover);
  const qobuzCoverUrl = qobuzTrack?.album?.image?.large || qobuzTrack?.album?.image?.small || null;
  const artistName = tidalTrack?.artist?.name
    || tidalTrack?.artists?.[0]?.name
    || qobuzTrack?.performer?.name
    || qobuzTrack?.album?.artist?.name
    || '';
  const coverUrl = buildCoverUrlFromTrack({ cover: tidalCover }, 1280)
    || qobuzCoverUrl;

  return {
    id: Number(tidalTrack?.id || id) || id,
    trackId: Number(tidalTrack?.id || id) || id,
    title: tidalTrack?.title || qobuzTrack?.title || '',
    version: tidalTrack?.version || qobuzTrack?.version || null,
    artist: artistName,
    artists: Array.isArray(tidalTrack?.artists)
      ? tidalTrack.artists.map(a => ({ id: a.id, name: a.name })).filter(a => a.name)
      : (artistName ? [{ name: artistName }] : []),
    album: {
      id: tidalTrack?.album?.id || qobuzTrack?.album?.qobuz_id || qobuzTrack?.album?.id || null,
      title: tidalTrack?.album?.title || qobuzTrack?.album?.title || '',
      cover: tidalCover || qobuzCoverUrl
    },
    cover: tidalCover || qobuzCoverUrl,
    coverUrl,
    duration: tidalTrack?.duration ?? qobuzTrack?.duration ?? null,
    explicit: Boolean(tidalTrack?.explicit || qobuzTrack?.parental_warning),
    isrc: tidalTrack?.isrc || qobuzTrack?.isrc || null,
    audioQuality: usedQuality,
    quality: usedQuality,
    requestedQuality,
    usedQuality,
    assetPresentation: 'FULL',
    manifestMimeType: qobuzQuality === '5' ? 'audio/mpeg' : 'audio/flac',
    source: 'qobuz-fallback',
    qobuzTrackId: qobuzTrack?.id || null,
    url: streamUrl,
    directUrl: streamUrl
  };
}

async function fetchQobuzFallbackTrackData({ id, quality, timeoutMs = TRACK_TIMEOUT_MS }) {
  if (!QOBUZ_FALLBACK_ENABLED || QOBUZ_API_BASES.length === 0) return null;

  try {
    const tidalTrack = await fetchOfficialTidalTrackInfo(id, timeoutMs);
    const isrc = (tidalTrack?.isrc || '').toString().trim();
    if (!isrc) return null;

    const searchTimeoutMs = Math.min(Math.max(timeoutMs, 3000), QOBUZ_SEARCH_TIMEOUT_MS);
    const downloadTimeoutMs = Math.min(Math.max(timeoutMs, 4000), QOBUZ_DOWNLOAD_TIMEOUT_MS);

    // Se recorren las APIs de Qobuz en orden: la primera (API oficial itzsantiax) tiene prioridad.
    for (const qobuzApiBase of QOBUZ_API_BASES) {
      try {
        const searchUrl = `${qobuzApiBase}/api/get-music?q=${encodeURIComponent(isrc)}&offset=0`;
        const searchResponse = await axiosFast.get(searchUrl, { timeout: searchTimeoutMs });
        const qobuzTrack = pickQobuzTrack(extractQobuzTrackItems(searchResponse.data), isrc);
        const qobuzTrackId = qobuzTrack?.id || qobuzTrack?.track_id || qobuzTrack?.trackId;
        if (!qobuzTrackId) throw new Error('Qobuz track not found');

        const qobuzQuality = mapTidalQualityToQobuzQuality(quality);
        const downloadUrl = `${qobuzApiBase}/api/download-music?track_id=${encodeURIComponent(qobuzTrackId)}&quality=${encodeURIComponent(qobuzQuality)}`;
        const downloadResponse = await axiosFast.get(downloadUrl, { timeout: downloadTimeoutMs });
        const streamUrl = getQobuzDownloadUrl(downloadResponse.data);
        if (!streamUrl) throw new Error('Qobuz download URL not found');

        // Qobuz devuelve URLs de muestra (solo unos segundos) con el parámetro `range`
        // (p.ej. range=20-30). Se descartan para evitar reproducir previews.
        if (/[?&]range=/.test(streamUrl)) {
          throw new Error('Qobuz sample URL (preview)');
        }

        return {
          ok: true,
          url: downloadUrl,
          data: {
            ...buildQobuzFallbackPayload({
              id,
              tidalTrack,
              qobuzTrack,
              streamUrl,
              requestedQuality: quality,
              qobuzQuality
            }),
            qobuzApiBase
          }
        };
      } catch (err) {
        if (AUDIO_CACHE_DEBUG) {
          console.warn('[qobuz-fallback] provider failed:', qobuzApiBase, err?.message || err);
        }
      }
    }

    return null;
  } catch (err) {
    if (AUDIO_CACHE_DEBUG) {
      console.warn('[qobuz-fallback] failed:', err?.message || err);
    }
    return null;
  }
}

// ==================== AMAZON MUSIC FALLBACK HELPERS ====================

function mapTidalQualityToAmazonQuality(quality) {
  const normalized = (quality || '').toString().toUpperCase().trim();
  if (normalized === 'HI_RES_LOSSLESS') return 'UHD_96';
  if (normalized === 'LOSSLESS') return 'HD_44';
  if (normalized === 'HIGH') return 'SD_HIGH';
  return 'SD_HIGH';
}

function getConfigAmazonQuality(requestedQuality) {
  const configured = (AMAZON_QUALITY || '').toString().toUpperCase().trim();
  if (configured && /^(SD_LOW|SD_HIGH|HD_UHD|HD_44|UHD_96|UHD_192|HD|SD)$/.test(configured)) {
    return configured;
  }
  return mapTidalQualityToAmazonQuality(requestedQuality);
}

function extractAmazonData(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.data && typeof payload.data === 'object') return payload.data;
  if (payload.result && typeof payload.result === 'object') return payload.result;
  if (payload.track && typeof payload.track === 'object') return payload.track;
  return payload;
}

function extractAmazonTracks(payload) {
  const data = extractAmazonData(payload);
  if (!data || typeof data !== 'object') return [];
  const candidates = [
    data.tracks,
    data.items,
    data.results,
    data.data,
    Array.isArray(data) ? data : null
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.items)) return candidate.items;
    if (candidate && Array.isArray(candidate.tracks)) return candidate.tracks;
    if (candidate && Array.isArray(candidate.results)) return candidate.results;
  }
  return [];
}

function pickAmazonTrack(items, nameHint) {
  const normalizedTitle = (nameHint?.title || '').toString().trim().toLowerCase();
  const normalizedArtist = (nameHint?.artist || '').toString().trim().toLowerCase();
  const normalizedIsrc = (nameHint?.isrc || '').toString().trim().toUpperCase();
  if (!Array.isArray(items)) return null;

  const score = (item) => {
    let points = 0;
    if (normalizedIsrc && String(item?.isrc || '').toUpperCase() === normalizedIsrc) points += 100;
    const title = String(item?.name || item?.title || '').toLowerCase();
    if (normalizedTitle && title === normalizedTitle) points += 10;
    else if (normalizedTitle && title.includes(normalizedTitle)) points += 5;
    const artistNames = Array.isArray(item?.artists)
      ? item.artists.map((a) => String(a?.name || a || '').toLowerCase())
      : [String(item?.artist || '').toLowerCase()];
    if (normalizedArtist && artistNames.some((name) => name && name.includes(normalizedArtist))) points += 5;
    return points;
  };

  const ranked = items.map((item, index) => ({ item, index, points: score(item) }))
    .sort((a, b) => (b.points - a.points) || (a.index - b.index));
  return ranked[0]?.points > 0 ? ranked[0].item : items[0] || null;
}

function getAmazonAsin(track) {
  if (!track) return null;
  return track?.asin || track?.id || track?.trackId || track?.asins?.[0] || null;
}

function extractAmazonStreamUrl(payload, quality) {
  const data = extractAmazonData(payload);
  if (!data || typeof data !== 'object') return null;

  const qualityLabel = (quality || '').toUpperCase();
  const candidates = [];

  // keys endpoints suelen devolver streams por calidad
  const qualitiesList = Array.isArray(data.streams) ? data.streams : (Array.isArray(data.results) ? data.results : []);
  if (qualitiesList.length === 0 && Array.isArray(data.data)) {
    qualitiesList.push(...data.data);
  }

  for (const q of qualitiesList) {
    if (typeof q === 'string') {
      candidates.push(q);
      continue;
    }
    if (qualityLabel && String(q?.quality || q?.name || '').toUpperCase() === qualityLabel) {
      candidates.push(q?.url || q?.stream_url || q?.play_url || q?.manifest || q?.link);
    }
    candidates.push(q?.url || q?.stream_url || q?.play_url || q?.manifest || q?.link);
  }

  candidates.push(
    data.url,
    data.stream_url,
    data.play_url,
    data.manifest,
    data.playUrl,
    data.streamUrl,
    data.href
  );

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
    if (value && typeof value === 'object') {
      const nested = extractAmazonData(value);
      const nestedUrl = extractAmazonStreamUrl({ data: nested }, quality);
      if (nestedUrl) return nestedUrl;
    }
  }
  return null;
}

function extractAmazonManifest(payload) {
  const data = extractAmazonData(payload);
  if (!data || typeof data !== 'object') return null;
  const value = data.manifest || data.xml || null;
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function extractAmazonKeys(payload) {
  const data = extractAmazonData(payload);
  if (!data || typeof data !== 'object') return null;
  const encKeys = data.encryption_keys || data.encryptionKey || data.keys || data.key
    || data.content_key || data.contentKey || data.decryption_key || data.decryptionKey;
  if (Array.isArray(encKeys) && encKeys.length > 0) {
    return encKeys.map((k) => (typeof k === 'string' ? k : (k?.key || k?.content_key || k?.contentKey || null))).filter(Boolean);
  }
  if (typeof encKeys === 'string' && encKeys.trim()) return [encKeys];
  return null;
}

function getAmazonKeyHex(payload) {
  const data = extractAmazonData(payload);
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.key,
    data.content_key,
    data.contentKey,
    data.decryption_key,
    data.decryptionKey,
    data.encryption_key,
    data.encryptionKey
  ];
  if (data.encryption_keys && typeof data.encryption_keys === 'object') {
    candidates.push(data.encryption_keys.key, data.encryption_keys.content_key, data.encryption_keys.contentKey);
  }
  if (Array.isArray(data.keys)) {
    const first = data.keys[0];
    if (typeof first === 'string') candidates.push(first);
    else if (first && typeof first === 'object') candidates.push(first.key, first.content_key, first.contentKey);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function buildAmazonFallbackUrl(req, rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(String(rawUrl).trim())) return rawUrl;
  // Proxificar streams de Amazon (no son accesibles directamente desde el navegador por CORS/DRM)
  if (isAllowedAudioProxyUrl(rawUrl)) {
    return buildAudioProxyUrl(req, rawUrl) || rawUrl;
  }
  return rawUrl;
}

async function fetchAmazonFallbackTrackData({ id, quality, timeoutMs = TRACK_TIMEOUT_MS, req = null }) {
  if (!AMAZON_FALLBACK_ENABLED || AMAZON_API_BASES.length === 0) {
    if (AUDIO_CACHE_DEBUG) {
      console.warn('[amazon-fallback] disabled or no API bases configured');
    }
    return null;
  }

  try {
    const tidalTrack = await fetchOfficialTidalTrackInfo(id, timeoutMs);
    const nameHint = {
      title: tidalTrack?.title || '',
      artist: tidalTrack?.artist?.name || tidalTrack?.artists?.[0]?.name || '',
      album: tidalTrack?.album?.title || '',
      isrc: (tidalTrack?.isrc || '').toString().trim() || ''
    };

    const amazonQuality = getConfigAmazonQuality(quality);
    const searchTimeoutMs = Math.min(Math.max(timeoutMs, 3000), AMAZON_SEARCH_TIMEOUT_MS);
    const streamTimeoutMs = Math.min(Math.max(timeoutMs, 4000), AMAZON_STREAM_TIMEOUT_MS);
    const controller = new AbortController();
    let settled = false;

    const requests = AMAZON_API_BASES.map(async (amazonApiBase) => {
      try {
        // 1) Resolver el track a un ASIN
        const resolveParams = new URLSearchParams();
        resolveParams.set('title', nameHint.title);
        if (nameHint.artist) resolveParams.set('artist', nameHint.artist);
        if (nameHint.album) resolveParams.set('album', nameHint.album);
        if (nameHint.isrc) resolveParams.set('isrc', nameHint.isrc);
        const resolveUrl = `${amazonApiBase}/v1/resolve?${resolveParams.toString()}`;
        const resolveResponse = await axiosFast.get(resolveUrl, { timeout: searchTimeoutMs, signal: controller.signal });
        const resolveData = extractAmazonData(resolveResponse.data);
        const asin = getAmazonAsin(
          resolveData?.track || resolveData?.candidates?.[0] || resolveData?.[0]
          || (Array.isArray(resolveData) ? resolveData[0] : resolveData)
        );

        // Si la resolución falló, intentar una búsqueda
        let amazonTrack = resolveData?.track || (Array.isArray(resolveData?.candidates) ? resolveData.candidates[0] : null);
        if (!asin) {
          const searchParams = new URLSearchParams();
          searchParams.set('q', `${nameHint.title} ${nameHint.artist}`.trim());
          searchParams.set('enrich', 'false');
          const searchUrl = `${amazonApiBase}/v1/search?${searchParams.toString()}`;
          const searchResponse = await axiosFast.get(searchUrl, { timeout: searchTimeoutMs, signal: controller.signal });
          const searchItems = extractAmazonTracks(searchResponse.data);
          const picked = pickAmazonTrack(searchItems, nameHint);
          amazonTrack = picked;
          const resolvedAsin = getAmazonAsin(picked);
          if (!resolvedAsin) throw new Error('Amazon track ASIN not found');
        }
        const finalAsin = getAmazonAsin(amazonTrack) || asin;
        if (!finalAsin) throw new Error('Amazon ASIN not found');

        // 2) Listar streams
        const streamsUrl = `${amazonApiBase}/v1/streams/${encodeURIComponent(finalAsin)}?quality=${encodeURIComponent(amazonQuality)}`;
        const streamsResponse = await axiosFast.get(streamsUrl, { timeout: streamTimeoutMs, signal: controller.signal });

        // 3) Obtener claves de descifrado
        const keysUrl = `${amazonApiBase}/v1/keys/${encodeURIComponent(finalAsin)}?quality=${encodeURIComponent(amazonQuality)}`;
        const keysResponse = await axiosFast.get(keysUrl, { timeout: streamTimeoutMs, signal: controller.signal });

        const streamUrl = extractAmazonStreamUrl(streamsResponse.data, amazonQuality);
        const streamUrlFromKeys = extractAmazonStreamUrl(keysResponse.data, amazonQuality);
        const finalStreamUrl = streamUrl || streamUrlFromKeys;
        const manifest = extractAmazonManifest(streamsResponse.data) || extractAmazonManifest(keysResponse.data);
        const keys = extractAmazonKeys(keysResponse.data);
        const keyHex = getAmazonKeyHex(keysResponse.data) || (Array.isArray(keys) ? keys[0] : null);

        if (!finalStreamUrl && !manifest) throw new Error('Amazon stream URL not found');
        if (!keyHex) throw new Error('Amazon decryption key not found');

        // Proxificar el stream de Amazon (CORS/DRM) y apuntar el player al
        // Service Worker descifrador (/api/decrypt-stream), que lo descifra
        // en el navegador con AES-CTR y lo sirve como FLAC.
        const proxiedStreamUrl = req ? buildAmazonFallbackUrl(req, finalStreamUrl) : finalStreamUrl;
        const decryptParams = new URLSearchParams();
        decryptParams.set('url', proxiedStreamUrl);
        decryptParams.set('key', keyHex);
        decryptParams.set('codec', 'flac');
        const decryptUrl = `/api/decrypt-stream?${decryptParams.toString()}`;

        const payload = {
          id: Number(tidalTrack?.id || id) || id,
          trackId: Number(tidalTrack?.id || id) || id,
          title: tidalTrack?.title || nameHint.title || '',
          version: tidalTrack?.version || null,
          artist: nameHint.artist,
          artists: Array.isArray(tidalTrack?.artists)
            ? tidalTrack.artists.map((a) => ({ id: a.id, name: a.name })).filter((a) => a.name)
            : (nameHint.artist ? [{ name: nameHint.artist }] : []),
          album: {
            id: tidalTrack?.album?.id || null,
            title: nameHint.album || tidalTrack?.album?.title || '',
            cover: normalizeOfficialTidalImageCover(tidalTrack?.album?.cover || tidalTrack?.cover)
          },
          cover: normalizeOfficialTidalImageCover(tidalTrack?.album?.cover || tidalTrack?.cover),
          coverUrl: buildCoverUrlFromTrack(
            { cover: normalizeOfficialTidalImageCover(tidalTrack?.album?.cover || tidalTrack?.cover) },
            1280
          ),
          duration: tidalTrack?.duration ?? null,
          explicit: Boolean(tidalTrack?.explicit),
          isrc: tidalTrack?.isrc || null,
          audioQuality: quality,
          quality,
          requestedQuality: quality,
          usedQuality: quality,
          assetPresentation: 'FULL',
          manifestMimeType: 'audio/flac',
          source: 'amazon-fallback',
          amazonAsin: finalAsin,
          amazonQuality,
          url: decryptUrl,
          directUrl: proxiedStreamUrl || finalStreamUrl || null,
          amazonStreamUrl: finalStreamUrl || null,
          amazonKey: keyHex,
          amazonKeys: keys,
          amazonManifest: manifest,
          amazonApiBase
        };

        settled = true;
        controller.abort();
        return { ok: true, url: keysUrl, data: payload };
      } catch (err) {
        if (AUDIO_CACHE_DEBUG && !settled && err?.code !== 'ERR_CANCELED') {
          console.warn('[amazon-fallback] provider failed:', amazonApiBase, err?.message || err);
        }
        throw err;
      }
    });

    return await Promise.any(requests);
  } catch (err) {
    if (AUDIO_CACHE_DEBUG) {
      console.warn('[amazon-fallback] failed:', err?.message || err);
    }
    return null;
  }
}

async function fetchFirstVideoData({ apis, id, quality = 'HIGH', timeoutMs = 4500, mode = 'STREAM', presentation = 'FULL' }) {
  const extractTrackPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    if (data.data && typeof data.data === 'object') return data.data;
    if (data.video && typeof data.video === 'object') return data.video;

    if (
      data.manifest != null
      || data.url
      || data.manifestMimeType
      || data.videoId != null
      || data.trackId != null
      || data.id != null
    ) {
      return data;
    }

    return null;
  };

  const hasUsableTrackStream = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.streamReady === false) return false;

    const assetPresentation = String(payload.assetPresentation || payload.presentation || '').toUpperCase();
    if (assetPresentation === 'PREVIEW') return false;

    if (typeof payload.url === 'string' && payload.url.trim()) return true;
    if (typeof payload.manifest === 'string' && payload.manifest.trim()) return true;
    if (payload.manifest && typeof payload.manifest === 'object') return true;

    return false;
  };

  const requests = apis.map(api => {
    const cleanApi = api.replace(/\/+$/, "");
    const params = new URLSearchParams({
      id: String(id),
      quality: String(quality || 'HIGH'),
      mode: String(mode || 'STREAM'),
      presentation: String(presentation || 'FULL')
    });
    const url = `${cleanApi}/video/?${params.toString()}`;
    return axiosFast.get(url, { timeout: timeoutMs })
      .then(r => {
        const payload = extractTrackPayload(r.data);
        if (!hasUsableTrackStream(payload)) {
          return Promise.reject(new Error('Invalid video'));
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

async function fetchFirstVideoFromHifiFallbacks({ id, quality = 'HIGH', timeoutMs = TRACK_TIMEOUT_MS, mode = 'STREAM', presentation = 'FULL' }) {
  const groups = await getLatencyRankedHifiApiFallbackGroups();
  for (const group of groups) {
    const fastAPIs = group.apis.slice(0, FAST_TRACK_POOL);
    let success = await fetchFirstVideoData({
      apis: fastAPIs,
      id,
      quality,
      timeoutMs,
      mode,
      presentation
    });

    if (!success && group.apis.length > fastAPIs.length) {
      success = await fetchFirstVideoData({
        apis: group.apis,
        id,
        quality,
        timeoutMs,
        mode,
        presentation
      });
    }

    if (success) return success;
  }
  return null;
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
async function _forward(req, res, endpoint) {
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

    const readCachedTrackPayload = async () => {
      const cached = getCache(cacheKey);
      if (cached) return cached;

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
          return payload;
        }
      }

      return null;
    };

    if (ONLY_GOOGLE_DRIVE) {
      const cachedPayload = await readCachedTrackPayload();
      if (cachedPayload) {
        return res.json(cachedPayload);
      }
      return res.status(404).json({
        error: 'ONLY_GOOGLE_DRIVE enabled: audio cache miss',
        id,
        requestedQuality
      });
    }

    const pendingTrackPayload = trackInFlight.get(cacheKey);
    if (pendingTrackPayload) {
      console.log(`[track] JOIN in-flight: ${id} ${requestedQuality}`);
      try {
        const payload = await pendingTrackPayload;
        return res.json(payload);
      } catch (error) {
        if (error?.payload && error?.status) {
          return res.status(error.status).json(error.payload);
        }
        throw error;
      }
    }

    const trackPayloadPromise = (async () => {
    console.log(`\n>>> Calidad solicitada: ${qRaw} → intentando: ${requestedQuality}`);

    const fallback = await fetchTrackFallbackData({
      id,
      requestedQuality,
      req,
      log: (message) => console.log(message)
    });
    const { success, matchedQuality, attemptedQualities: qualitiesToTry } = fallback;
    let { usedQuality } = fallback;

    if (success) {
      console.log(`OK Track encontrado en calidad: ${matchedQuality || usedQuality}`);
    }

    if (!success) {
      const cachedPayload = await readCachedTrackPayload();
      if (cachedPayload) {
        return cachedPayload;
      }

      const error = new Error("No se pudo obtener el track en ninguna calidad");
      error.status = 500;
      error.payload = {
        error: "No se pudo obtener el track en ninguna calidad",
        requestedQuality,
        attemptedQualities: qualitiesToTry,
        attempedQualities: qualitiesToTry
      };
      throw error;
    }

    console.log(`✔️ Track OK desde: ${success.url} | Calidad: ${usedQuality}`);

    // Devolver la data real
      // Decodificar manifest si viene en base64
      const respDataBase = { ...success.data };
      const decoded = tryDecodeManifest(respDataBase.manifest);
      if (decoded !== null) {
        // Reemplazar manifest por el objeto/string decodificado (sin duplicar)
        respDataBase.manifest = decoded;
        console.log('✔️ Manifest decodificado para track', respDataBase.trackId || id);
      } else {
        console.log('ℹ️ No se pudo decodificar manifest para track', respDataBase.trackId || id);
      }
      // Si es DASH y solo hay URL del .mpd, descargar el manifest inline
      const respData = await ensureDashManifestString(respDataBase);

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
      if (isDashMime(respData?.manifestMimeType)) {
        usedQuality = isLosslessQuality(reportedQuality) ? reportedQuality : "HI_RES_LOSSLESS";
      } else if (reportedQuality && VALID_QUALITIES.includes(reportedQuality)) {
        usedQuality = reportedQuality;
      }

      const directStreamUrl = streamUrl || respData.url || null;
      const playbackUrl = !isDashMime(respData?.manifestMimeType)
        ? (buildAudioProxyUrl(req, directStreamUrl) || directStreamUrl)
        : directStreamUrl;

      const payload = {
        ...respData,
        url: playbackUrl,
        directUrl: directStreamUrl,
        requestedQuality: requestedQuality,
        usedQuality: normalizeQualityValue(usedQuality) || requestedQuality
      };
      setCache(cacheKey, payload, CACHE_TTL.track);
      const runAudioCache = async () => {
        let cacheUrl = directStreamUrl;
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
      return payload;
    })();

    trackInFlight.set(cacheKey, trackPayloadPromise);
    try {
      const payload = await trackPayloadPromise;
      return res.json(payload);
    } catch (error) {
      if (error?.payload && error?.status) {
        return res.status(error.status).json(error.payload);
      }
      throw error;
    } finally {
      trackInFlight.delete(cacheKey);
    }

  } catch (error) {
    console.error("❌ Error en TRACK:", error.message);
    res.status(500).json({ error: "Error interno al obtener track" });
  }
});

app.get('/api/video/proxy', async (req, res) => {
  try {
    const targetUrl = (req.query.url || '').toString().trim();
    if (!targetUrl || !isAllowedVideoProxyUrl(targetUrl)) {
      return res.status(400).json({ error: 'URL de video no permitida' });
    }

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');

    const upstream = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      timeout: 0,
      validateStatus: () => true,
      headers: {
        ...(req.headers.range ? { Range: req.headers.range } : {}),
        'User-Agent': req.get('user-agent') || 'Yupify/1.0'
      }
    });

    const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
    res.status(upstream.status);
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
    res.setHeader('Cache-Control', 'no-store');

    if (upstream.status >= 400) {
      upstream.data.pipe(res);
      return;
    }

    if (contentType.includes('mpegurl') || targetUrl.toLowerCase().includes('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.removeHeader('Content-Length');
      let manifestText = '';
      upstream.data.setEncoding('utf8');
      upstream.data.on('data', chunk => { manifestText += chunk; });
      upstream.data.on('end', () => {
        const rewritten = rewriteM3u8Manifest(manifestText, targetUrl, req);
        res.end(rewritten);
      });
      upstream.data.on('error', () => {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Error al leer manifest de video' });
        } else {
          res.end();
        }
      });
      return;
    }

    upstream.data.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Error al proxificar video' });
      } else {
        res.end();
      }
    });
    upstream.data.pipe(res);
  } catch (error) {
    console.error('Error en /api/video/proxy:', error.message);
    return res.status(500).json({ error: 'Error interno al proxificar video' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const requestedQuality = (req.query.quality || 'HIGH').toString().toUpperCase().trim();
    const mode = (req.query.mode || 'STREAM').toString().trim();
    const presentation = (req.query.presentation || 'FULL').toString().trim();
    const cacheKey = `video:${id}|q:${requestedQuality}|m:${mode}|p:${presentation}`;

    const success = await fetchFirstVideoFromHifiFallbacks({
      id,
      quality: requestedQuality,
      timeoutMs: TRACK_TIMEOUT_MS,
      mode,
      presentation
    });

    if (!success) {
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      return res.status(500).json({ error: 'No se pudo obtener el video' });
    }

    const respData = { ...success.data };
    const decoded = tryDecodeManifest(respData.manifest);
    if (decoded !== null) {
      respData.manifest = decoded;
    }

    let playbackUrl = respData.url || null;
    if (!playbackUrl && respData.manifest && typeof respData.manifest === 'object' && Array.isArray(respData.manifest.urls)) {
      playbackUrl = respData.manifest.urls[0];
    }
    if (!playbackUrl && typeof respData.manifest === 'string') {
      const match = respData.manifest.match(/https?:\/\/[^\s"'<>]+/i);
      if (match) playbackUrl = match[0];
    }

    const payload = {
      ...respData,
      id: respData.id || respData.videoId || Number(id),
      url: playbackUrl,
      directUrl: playbackUrl,
      coverUrl: buildCoverUrlFromTrack(respData, 1280, 720),
      requestedQuality
    };
    setCache(cacheKey, payload, CACHE_TTL.track);
    return res.json(payload);
  } catch (error) {
    console.error('Error en /api/video:', error.message);
    return res.status(500).json({ error: 'Error interno al obtener video' });
  }
});

app.get('/api/audio/proxy', async (req, res) => {
  try {
    const targetUrl = (req.query.url || '').toString().trim();
    if (!targetUrl || !isAllowedAudioProxyUrl(targetUrl)) {
      return res.status(400).json({ error: 'URL de audio no permitida' });
    }

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');

    const upstream = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      timeout: 0,
      validateStatus: () => true,
      headers: buildTidalAudioRequestHeaders(req, targetUrl, {
        forceRange: true,
        destination: inferTidalAudioFetchDestination(targetUrl)
      })
    });

    res.status(upstream.status);
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
    if (upstream.headers.etag) res.setHeader('ETag', upstream.headers.etag);
    if (upstream.headers['last-modified']) res.setHeader('Last-Modified', upstream.headers['last-modified']);
    res.setHeader('Cache-Control', 'no-store');

    upstream.data.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Error al proxificar audio' });
      } else {
        res.end();
      }
    });

    upstream.data.pipe(res);
  } catch (error) {
    console.error('Error en /api/audio/proxy:', error.message);
    return res.status(500).json({ error: 'Error interno al proxificar audio' });
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
        try { fs.unlinkSync(outputPath); } catch { /* ignore cleanup error */ }
        try { fs.unlinkSync(inputPath); } catch { /* ignore cleanup error */ }
        if (coverPath) {
          try { fs.unlinkSync(coverPath); } catch { /* ignore cleanup error */ }
        }
      });
    } catch (err) {
      console.error('Error en descarga:', err.message);
      try { fs.unlinkSync(outputPath); } catch { /* ignore cleanup error */ }
      try { fs.unlinkSync(inputPath); } catch { /* ignore cleanup error */ }
      if (coverPath) {
        try { fs.unlinkSync(coverPath); } catch { /* ignore cleanup error */ }
      }
      return res.status(500).json({ error: 'Error generando descarga' });
    }
  } catch (error) {
    console.error('Error en /api/download:', error.message);
    return res.status(500).json({ error: 'Error interno al descargar' });
  }
});



// Obtener manifest DASH (Ya no usado, ahora /api/song/:id)

app.get('/api/search', async (req, res) => {
  try {
    const { q, s, a, al, v, p, i, limit = 20, offset = 0 } = req.query;

    let searchQuery = '';
    if (q) searchQuery = `s=${encodeURIComponent(q)}`;
    else if (s) searchQuery = `s=${encodeURIComponent(s)}`;
    else if (a) searchQuery = `a=${encodeURIComponent(a)}`;
    else if (al) searchQuery = `al=${encodeURIComponent(al)}`;
    else if (v) searchQuery = `v=${encodeURIComponent(v)}`;
    else if (p) searchQuery = `p=${encodeURIComponent(p)}`;
    else if (i) searchQuery = `i=${encodeURIComponent(i)}`;

    if (!searchQuery) {
      return res.status(400).json({ error: 'Falta parámetro de búsqueda (q/s/a/al/v/p/i)' });
    }

    const rawQuery = q || s || a || al || v || p || i || '';
    const searchKind = (q || s)
      ? 'track'
      : (a ? 'artist' : (al ? 'album' : (v ? 'video' : (p ? 'playlist' : 'track'))));
    const officialSearchConfig = hasOfficialTidalSearchConfig()
      ? getOfficialTidalSearchConfig({ q, s, a, al, v, p, i })
      : null;
    const searchMode = officialSearchConfig
      ? (officialSearchConfig.global ? 'tidal-official-global-v3' : `tidal-official-${officialSearchConfig.bucket}-v3`)
      : ((q || s) ? 'legacy-global-v2' : 'legacy-v2');

    const cacheKey = `search:${searchMode}:${searchQuery}|li:${limit}|offset:${offset}`;
    const cached = getCache(cacheKey);
    if (cached) {
      if (!(officialSearchConfig?.global && (!cached.sections || typeof cached.sections !== 'object'))) {
        const rankedCached = applySearchRanking(cached, rawQuery, searchKind);
        if (hasStrongSearchMatch(rankedCached?.data?.items, rawQuery, searchKind)) {
          return res.json(rankedCached);
        }
      }
    }

    const payload = await runSingleFlight(searchInFlight, cacheKey, async () => {
    const gdriveCached = await loadSearchCacheFromGDrive(cacheKey);
    if (gdriveCached) {
      if (!(officialSearchConfig?.global && (!gdriveCached.sections || typeof gdriveCached.sections !== 'object'))) {
        const rankedGdrive = applySearchRanking(gdriveCached, rawQuery, searchKind);
        if (hasStrongSearchMatch(rankedGdrive?.data?.items, rawQuery, searchKind)) {
          setCache(cacheKey, rankedGdrive, CACHE_TTL.search);
          return rankedGdrive;
        }
      }
    }

    if (ONLY_GOOGLE_DRIVE) {
      const error = new Error('ONLY_GOOGLE_DRIVE enabled: search cache miss');
      error.status = 404;
      error.payload = { error: error.message, cacheKey };
      throw error;
    }

    if (officialSearchConfig) {
      try {
        const officialPayload = await searchOfficialTidal({ q, s, a, al, v, p, i, limit, offset });
        const rankedOfficial = applySearchRanking(officialPayload, rawQuery, searchKind);
        setCache(cacheKey, rankedOfficial, CACHE_TTL.search);
        saveSearchCacheToGDrive(cacheKey, rankedOfficial);
        return rankedOfficial;
      } catch (err) {
        console.warn('[search] official TIDAL search failed, using fallback:', err.message);
      }
    }

    if (q || s) {
      const globalLegacyPayload = await buildLegacyGlobalSearchPayload(rawQuery, limit, offset);
      setCache(cacheKey, globalLegacyPayload, CACHE_TTL.search);
      saveSearchCacheToGDrive(cacheKey, globalLegacyPayload);
      return globalLegacyPayload;
    }

    const legacyPayload = await runLegacySearchQuery({ searchQuery, rawQuery, kind: searchKind, limit, offset });
    const rankedPayload = applySearchRanking(legacyPayload, rawQuery, searchKind);
    setCache(cacheKey, rankedPayload, CACHE_TTL.search);
    saveSearchCacheToGDrive(cacheKey, rankedPayload);
    return rankedPayload;
    });

    return res.json(payload);
  } catch (error) {
    if (error?.payload && error?.status) {
      return res.status(error.status).json(error.payload);
    }
    console.error('Error en búsqueda (v2):', error?.message || error);
    return res.status(500).json({ error: 'Error al buscar', details: error?.message || String(error) });
  }
});

//app.get('/api/dash/:id', async (req, res) => {
//  try {
app.get('/api/search', async (req, res) => {
  try {
  const { q, s, a, al, v, p, i, limit = 20, offset = 0 } = req.query;

    // Construir parámetro de búsqueda (usa 's' como parámetro externo)
    let searchQuery = '';
    if (q) searchQuery = `s=${encodeURIComponent(q)}`;
    else if (s) searchQuery = `s=${encodeURIComponent(s)}`;
    else if (a) searchQuery = `a=${encodeURIComponent(a)}`;
    else if (al) searchQuery = `al=${encodeURIComponent(al)}`;
    else if (v) searchQuery = `v=${encodeURIComponent(v)}`;
    else if (p) searchQuery = `p=${encodeURIComponent(p)}`;
    else if (i) searchQuery = `i=${encodeURIComponent(i)}`;

    if (!searchQuery) {
      return res.status(400).json({ error: 'Falta parámetro de búsqueda (q/s/a/al/v/p/i)' });

    }

    const rawQuery = q || s || a || al || v || p || i || '';
    const searchKind = (q || s)
      ? 'track'
      : (a ? 'artist' : (al ? 'album' : (v ? 'video' : (p ? 'playlist' : (i ? 'track' : 'track')))));
    const officialSearchConfig = hasOfficialTidalSearchConfig()
      ? getOfficialTidalSearchConfig({ q, s, a, al, v, p, i })
      : null;
    const searchMode = officialSearchConfig
      ? (officialSearchConfig.global ? 'tidal-official-global-v3' : `tidal-official-${officialSearchConfig.bucket}-v3`)
      : 'legacy-v1';

    // Si se especifica SEARCH_API en env, usar solo esa URL
    const envSearch = process.env.SEARCH_API && process.env.SEARCH_API.trim()
      ? process.env.SEARCH_API.replace(/\/+$/, '')
      : null;

    const cacheKey = `search:${searchMode}:${searchQuery}|li:${limit}|offset:${offset}`;
    const cached = getCache(cacheKey);
    if (cached) {
      if (officialSearchConfig?.global && (!cached.sections || typeof cached.sections !== 'object')) {
        // Ignorar cachés anteriores a la búsqueda global oficial
      } else {
      const rankedCached = applySearchRanking(cached, rawQuery, searchKind);
      if (hasStrongSearchMatch(rankedCached?.data?.items, rawQuery, searchKind)) {
        return res.json(rankedCached);
      }
      }
    }

    const gdriveCached = await loadSearchCacheFromGDrive(cacheKey);
    if (gdriveCached) {
      if (officialSearchConfig?.global && (!gdriveCached.sections || typeof gdriveCached.sections !== 'object')) {
        // Ignorar cachés anteriores a la búsqueda global oficial
      } else {
      const rankedGdrive = applySearchRanking(gdriveCached, rawQuery, searchKind);
      if (hasStrongSearchMatch(rankedGdrive?.data?.items, rawQuery, searchKind)) {
        setCache(cacheKey, rankedGdrive, CACHE_TTL.search);
        return res.json(rankedGdrive);
      }
      }
    }
    if (ONLY_GOOGLE_DRIVE) {
      return res.status(404).json({
        error: 'ONLY_GOOGLE_DRIVE enabled: search cache miss',
        cacheKey
      });
    }

    if (officialSearchConfig) {
      try {
        const officialPayload = await searchOfficialTidal({ q, s, a, al, v, p, i, limit, offset });
        const rankedOfficial = applySearchRanking(officialPayload, rawQuery, searchKind);
        setCache(cacheKey, rankedOfficial, CACHE_TTL.search);
        saveSearchCacheToGDrive(cacheKey, rankedOfficial);
        return res.json(rankedOfficial);
      } catch (err) {
        console.warn('[search] official TIDAL search failed, using fallback:', err.message);
      }
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

      const rankedPayload = applySearchRanking(payload, rawQuery, searchKind);
      setCache(cacheKey, rankedPayload, CACHE_TTL.search);
      saveSearchCacheToGDrive(cacheKey, rankedPayload);
      return res.json(rankedPayload);
    }

    // Por defecto: consultar todas las APIs HiFi activas en paralelo
    const allAPIs = await getSearchHifiApis();

    const requests = allAPIs.map(api =>
      axiosFast.get(`${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`, { timeout: SEARCH_TIMEOUT_MS })
        .then(r => ({ ok: true, api, data: r.data }))
        .catch(e => ({ ok: false, api, error: e.message }))
    );

    const responses = await Promise.all(requests);

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

    const rankedItems = rankSearchItems(uniqueItems, rawQuery, searchKind);
    const lim = Number(limit);
    const limitedItems = Number.isFinite(lim) && lim > 0 ? rankedItems.slice(0, lim) : rankedItems;
    const payload = { version: '2.4', data: { limit: Number(limit), offset: Number(offset) || 0, totalNumberOfItems: rankedItems.length, items: limitedItems } };
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
    const { id, title, track, artist, album, duration, source, sourcePrefer, sourceOnly, version, isrc } = req.query;
    const routeIsrc = (isrc || '').toString().trim().toUpperCase();
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

    const trackId = (id || '').toString().trim();
    if ((!finalTitle || !artist) && !trackId && !routeIsrc) {
      return res.status(400).json({
        error: "Faltan parámetros obligatorios: id o title (o track) y artist (o isrc)"
      });
    }

    const DEFAULT_SOURCES = routeIsrc
      ? ['binimum-isrc', 'prjktla', 'apple', 'musixmatch', 'lyricsplus', 'spotify', 'musixmatch-word']
      : ['prjktla', 'apple', 'musixmatch', 'lyricsplus', 'spotify', 'musixmatch-word'];
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
    const DEFAULT_PROVIDERS = ['prjktla', 'santiax'];
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
    const identityKey = trackId || `${finalTitle}|${artist}`;
    const baseGdriveCacheKey = `lyrics:${identityKey}|${album || ""}|${duration || ""}`;
    const cacheKey = `lyrics:${identityKey}|${album || ""}|${duration || ""}${versionKey}|${baseSource}|${providerKey}`;
    const gdriveCacheKey = `${baseGdriveCacheKey}${versionKey}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
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
              duration: dur || ""
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
      santiax: 'https://lyricsplus.itzsantiax.qzz.io/v2/lyrics/get',
      prjktla: 'https://lyricsplus.prjktla.my.id/v2/lyrics/get',
    };
    const lyricsSources = providerList
      .map(p => providerUrls[p])
      .filter(Boolean);

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

    const parseLyricsPayload = (payload) => {
      if (typeof payload !== 'string') return payload;
      const trimmed = payload.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return payload;
        }
      }
      return payload;
    };

    const hasLyrics = (payload) => {
      if (payload == null) return false;
      if (hasMangledGzipField(payload)) return false;
      return hasLyricsPayload(payload)
        || hasLyricsPayload(payload?.data)
        || hasLyricsPayload(payload?.result)
        || hasLyricsPayload(payload?.data?.result);
    };

    const attachLyricsSource = (payload, sourceName) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return payload;
      }
      const next = { ...payload };
      next.source = next.source || sourceName;
      if (next.metadata && typeof next.metadata === 'object') {
        next.metadata = { ...next.metadata, source: next.metadata.source || sourceName };
      } else {
        next.metadata = { source: sourceName };
      }
      return next;
    };

    const saveLyricsInBackground = (payload, sourceName) => {
      if (LYRICS_CACHE_DEBUG) {
        console.log('[lyrics-cache] SAVE queued:', gdriveCacheKey, 'source:', sourceName);
      }
      saveLyricsCacheToGDrive(gdriveCacheKey, payload, sourceName).catch((error) => {
        console.warn('GDrive cache failed:', error.message);
      });
    };

    const updateSongListInBackground = (sourceName, title = finalTitle, artistName = artist) => {
      updateSongListEntry({
        title,
        artist: artistName,
        album: album || '',
        duration: duration || '',
        source: sourceName
      }).catch((error) => {
        console.warn('songList update failed:', error.message);
      });
    };

    const collectedPayloads = [];
    const collectedSources = new Set();
    let lastError = null;
    let sawRateLimit = false;
    for (const requestedSource of sourcesList) {
      let sourcePayload = null;

      if (requestedSource === 'binimum-isrc') {
        // Fuente por ISRC: https://lyrics-api.binimum.org/?isrc=...
        if (routeIsrc) {
          try {
            console.log("-> Lyrics API binimum-isrc:", routeIsrc);
            const isrcPayload = await fetchBinimumIsrcLyrics(routeIsrc);
            if (isrcPayload && hasLyrics(isrcPayload)) {
              sourcePayload = attachLyricsSource(isrcPayload, requestedSource);
            } else {
              lastError = new Error(`Binimum ISRC sin letras: ${routeIsrc}`);
            }
          } catch (err) {
            lastError = err;
          }
        }
      } else {
        for (const baseUrl of lyricsSources) {
          for (const paramsObj of paramsToTry) {
            const requestParams = routeIsrc
              ? {
                  title: paramsObj.title,
                  artist: paramsObj.artist,
                  isrc: routeIsrc,
                  album: paramsObj.album,
                  duration: paramsObj.duration
                }
              : { ...paramsObj };
            if (baseUrl !== 'https://lyricsplus.prjktla.my.id/v2/lyrics/get') {
              requestParams.source = requestedSource;
            }
            const url = `${baseUrl}?${new URLSearchParams(requestParams)}`;
            console.log("-> Lyrics API:", url);
            try {
              const response = await axios.get(url, {
                timeout: LYRICS_API_TIMEOUT_MS,
                responseType: 'arraybuffer'
              });
              const payload = attachLyricsSource(parseLyricsPayload(decodeLyricsBody(response.data)), requestedSource);

              if (hasLyrics(payload)) {
                sourcePayload = payload;
                break;
              } else if (LYRICS_CACHE_DEBUG) {
                const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
                console.log('[lyrics-cache] No lyrics in response. Keys:', keys, 'source:', requestedSource);
              }

              lastError = new Error(`Lyrics empty for source ${requestedSource}`);
            } catch (err) {
              lastError = err;
              const status = err?.response?.status;
              if (status === 429) {
                sawRateLimit = true;
                break; // no insistir con este proveedor
              }
            }
          }

          if (sourcePayload) break;
        }
      }

      if (sourcePayload) {
        collectedPayloads.push({
          source: requestedSource,
          payload: sourcePayload
        });
        collectedSources.add(requestedSource);

        setCache(cacheKey, sourcePayload, CACHE_TTL.lyrics);
        res.json(sourcePayload);
        saveLyricsInBackground(sourcePayload, requestedSource);
        updateSongListInBackground(requestedSource);
        return;
      }
    }

    if (trackId) {
      const allLyricsApis = await getAvailableHifiApis({ waitForUptime: false, waitForHealth: false });
      const lyricsApis = EXHAUSTIVE_SEARCH ? allLyricsApis : allLyricsApis.slice(0, SEARCH_API_POOL);
      const controller = new AbortController();
      let idFallbackPayload = null;

      const idFallbackRequests = lyricsApis.map(async (apiBase) => {
        const url = `${apiBase}/lyrics/?id=${encodeURIComponent(trackId)}`;
        if (LYRICS_CACHE_DEBUG) console.log('-> Lyrics ID API:', url);
        const response = await axiosFast.get(url, { timeout: SEARCH_TIMEOUT_MS, signal: controller.signal, responseType: 'arraybuffer' });
        const payload = parseLyricsPayload(decodeLyricsBody(response.data));
        if (!hasLyrics(payload)) throw new Error('Lyrics ID fallback empty');

        const payloadSource = extractSourceFromPayload(payload);
        const result = attachLyricsSource(payload, payloadSource || 'track-id');
        controller.abort();
        return result;
      });

      try {
        idFallbackPayload = await Promise.any(idFallbackRequests);
      } catch (err) {
        lastError = err;
      }

      if (idFallbackPayload) {
        setCache(cacheKey, idFallbackPayload, CACHE_TTL.lyrics);
        const sourceName = extractSourceFromPayload(idFallbackPayload) || 'track-id';
        res.json(idFallbackPayload);
        saveLyricsInBackground(idFallbackPayload, sourceName);
        updateSongListInBackground(sourceName, finalTitle || `track:${trackId}`, artist || '');
        return;
      }
    }

    // Las APIs son la fuente principal; Google Drive se consulta solo como último fallback.
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

// Extraer los items de video reales de la respuesta de Tidal HiFi.
// La API devuelve un wrapper de página: { videos: [ { type: "VIDEO_LIST", pagedList: { items: [...] } } ] }.
function extractTopVideoItems(payload) {
  const candidates = [];
  const seen = new Set();

  const pushItem = (item) => {
    if (!item || typeof item !== 'object') return;
    if (!seen.has(item)) seen.add(item);
    else return;
    candidates.push(item);
  };

  const walkVideosList = (list) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.pagedList && Array.isArray(entry.pagedList.items)) {
        for (const item of entry.pagedList.items) pushItem(item);
      } else {
        pushItem(entry);
      }
      if (Array.isArray(entry.items)) {
        for (const item of entry.items) pushItem(item);
      }
    }
  };

  if (Array.isArray(payload?.videos)) walkVideosList(payload.videos);
  if (Array.isArray(payload?.items)) {
    for (const item of payload.items) pushItem(item);
  }
  if (Array.isArray(payload?.data?.videos)) walkVideosList(payload.data.videos);
  if (Array.isArray(payload?.data?.items)) {
    for (const item of payload.data.items) pushItem(item);
  }

  return candidates.filter((item) => {
    if (item?.id == null && item?.videoId == null) return false;
    const type = String(item?.type || item?.itemType || '').toLowerCase();
    if (type.includes('video') && !type.includes('video_list')) return true;
    if (type === 'music video' || type === 'musicvideo') return true;
    if (String(item?.videoType || '').toLowerCase().includes('video')) return true;
    if (type === 'video_item' || type === 'video_list') return false;
    if (item?.imageId && !item?.cover) return true;
    return type === 'track' ? false : Boolean(item?.title);
  });
}

// Obtener top videos (music videos de Tidal) con fallback entre APIs disponibles
app.get('/api/topvideos', async (req, res) => {
  try {
    const {
      countryCode = 'US',
      locale = 'en_US',
      deviceType = 'BROWSER',
      limit = 12,
      offset = 0
    } = req.query;

    const maxLimit = 50;
    const parsedLimit = Math.max(0, Math.min(parseInt(limit, 10) || 12, maxLimit));
    const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

    // El mirror de Tidal HiFi ignora el limit y devuelve `videos` vacío si offset > 0.
    // Siempre pedimos offset=0 y paginamos localmente sobre los items obtenidos.
    const params = new URLSearchParams({
      countryCode: String(countryCode),
      locale: String(locale),
      deviceType: String(deviceType),
      limit: '100',
      offset: '0'
    });

    const apis = await getAvailableHifiApis({ waitForHealth: true });
    let lastError = null;

    for (const api of apis) {
      try {
        const response = await axios.get(`${api}/topvideos/?${params.toString()}`, {
          timeout: 10000,
          validateStatus: () => true
        });
        if (response.status < 200 || response.status >= 300) {
          lastError = new Error(`${api} respondió ${response.status}`);
          console.warn(`[topvideos] ${api} respondió ${response.status}, probando siguiente`);
          continue;
        }

        const items = extractTopVideoItems(response.data);
        if (items.length === 0) {
          lastError = new Error(`${api} no devolvió videos`);
          console.warn(`[topvideos] ${api} no devolvió videos, probando siguiente`);
          continue;
        }

        const total = response.data?.videos?.[0]?.pagedList?.totalNumberOfItems
          ?? items.length;
        const pageItems = items.slice(parsedOffset, parsedOffset + parsedLimit);

        return res.json({
          items: pageItems,
          total,
          limit: parsedLimit,
          offset: parsedOffset,
          hasMore: parsedOffset + pageItems.length < total,
          videos: Array.isArray(response.data?.videos) ? response.data.videos : undefined
        });
      } catch (error) {
        lastError = error;
        console.warn(`[topvideos] error con ${api}:`, error.message);
      }
    }

    throw lastError || new Error('No hay APIs HiFi disponibles');
  } catch (error) {
    console.error('Error al obtener top videos:', error.message);
    res.status(500).json({ error: 'Error al obtener top videos' });
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
    const hifiGroups = await getHifiApiFallbackGroups();
    const hifiApis = dedupeHifiApis(hifiGroups.flatMap(group => group.apis));
    const localHifiCount = hifiGroups.find(group => group.source === 'local')?.apis.length || 0;
    const uptimeHifiCount = hifiGroups.find(group => group.source === 'uptime')?.apis.length || 0;
    const hifiActiveApis = await getActiveHifiApiStatuses({ force: req.query.cache !== 'true' });
    const hifiApiStatuses = hifiHealthState.apiStatuses;
    const hifiApiOrder = dedupeHifiApis(hifiGroups.flatMap(group => orderHifiApisByLatency(group.apis)));
    const hifiStatusByApi = getHifiStatusMap();
    const hifiSelectedApi = hifiStatusByApi.get(normalizeHifiApi(hifiApiOrder[0])) || null;
    hifiApiState.source = uptimeHifiCount > 0 ? 'local-first+uptime-fallback' : 'local-first';
    let usersCount = db.users.size;
    if (pool) {
      const result = await pool.query('SELECT COUNT(*) FROM users');
      usersCount = Number(result.rows[0]?.count || 0);
    }

    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      apis: Object.keys(HIFI_APIS),
      hifiApiSource: hifiApiState.source,
      hifiApiCount: hifiApis.length,
      hifiLocalApiCount: localHifiCount,
      hifiUptimeApiCount: uptimeHifiCount,
      hifiActiveApiCount: hifiActiveApis.length,
      hifiActiveApis,
      hifiApiStatuses,
      hifiApiOrder,
      hifiSelectedApi,
      hifiFastestApi: hifiActiveApis[0] || null,
      hifiHealthCheckedAt: hifiHealthState.checkedAt ? new Date(hifiHealthState.checkedAt).toISOString() : null,
      hifiHealthTtlMs: HIFI_HEALTH_TTL_MS,
      hifiUptimeUrl: HIFI_UPTIME_URL,
      hifiUptimeLastUpdated: hifiApiState.lastUpdated,
      hifiApiLastError: hifiApiState.lastError || undefined,
      qobuzFallbackEnabled: QOBUZ_FALLBACK_ENABLED,
      qobuzApiCount: QOBUZ_API_BASES.length,
      qobuzApis: QOBUZ_API_BASES,
      amazonFallbackEnabled: AMAZON_FALLBACK_ENABLED,
      amazonApiCount: AMAZON_API_BASES.length,
      amazonApis: AMAZON_API_BASES,
      amazonQuality: AMAZON_QUALITY,
      amazonWvdConfigured: Boolean(AMAZON_WVD_PATH),
      users: usersCount
    });
  } catch (error) {
    const localHifiApis = getLocalHifiApis();
    const uptimeHifiApis = hifiApiState.apiType === 'uptime' ? hifiApiState.apis : [];
    const hifiApis = hifiApiState.apis.length > 0
      ? dedupeHifiApis([...localHifiApis, ...uptimeHifiApis])
      : localHifiApis;
    const uptimeHifiCount = uptimeHifiApis.filter(api => !localHifiApis.includes(api)).length;
    const hifiActiveApis = await getActiveHifiApiStatuses();
    const hifiApiStatuses = hifiHealthState.apiStatuses;
    const hifiApiOrder = dedupeHifiApis([
      ...orderHifiApisByLatency(localHifiApis),
      ...orderHifiApisByLatency(uptimeHifiApis)
    ]);
    const hifiStatusByApi = getHifiStatusMap();
    const hifiSelectedApi = hifiStatusByApi.get(normalizeHifiApi(hifiApiOrder[0])) || null;
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      apis: Object.keys(HIFI_APIS),
      hifiApiSource: uptimeHifiCount > 0 ? 'local-first+uptime-fallback' : 'local-first',
      hifiApiCount: hifiApis.length,
      hifiLocalApiCount: localHifiApis.length,
      hifiUptimeApiCount: uptimeHifiCount,
      hifiActiveApiCount: hifiActiveApis.length,
      hifiActiveApis,
      hifiApiStatuses,
      hifiApiOrder,
      hifiSelectedApi,
      hifiFastestApi: hifiActiveApis[0] || null,
      hifiHealthCheckedAt: hifiHealthState.checkedAt ? new Date(hifiHealthState.checkedAt).toISOString() : null,
      hifiHealthTtlMs: HIFI_HEALTH_TTL_MS,
      hifiUptimeUrl: HIFI_UPTIME_URL,
      hifiUptimeLastUpdated: hifiApiState.lastUpdated,
      hifiApiLastError: hifiApiState.lastError || undefined,
      qobuzFallbackEnabled: QOBUZ_FALLBACK_ENABLED,
      qobuzApiCount: QOBUZ_API_BASES.length,
      qobuzApis: QOBUZ_API_BASES,
      amazonFallbackEnabled: AMAZON_FALLBACK_ENABLED,
      amazonApiCount: AMAZON_API_BASES.length,
      amazonApis: AMAZON_API_BASES,
      amazonQuality: AMAZON_QUALITY,
      amazonWvdConfigured: Boolean(AMAZON_WVD_PATH),
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
      proxy: ['/api/dash/:id', '/api/lyrics', '/api/cover', '/api/mix/:id', '/api/topvideos']
    }
  });
});

// Manejo de errores
app.use((err, req, res, _next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🎵 Yupify Backend iniciado en http://localhost:${PORT}`);
  console.log(`📡 HIFI uptime: ${HIFI_UPTIME_URL} (ttl ${HIFI_UPTIME_TTL_MS}ms)`);
  console.log(`📡 APIs fallback: ${Object.keys(HIFI_APIS).join(', ')}`);
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
