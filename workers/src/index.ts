export interface Env {
  SEARCH_API?: string;
  HIFI_APIS?: string;
  CORS_ORIGIN?: string;
  LYRICS_MULTI_PROVIDER?: string;
  LYRICS_PROVIDER?: string;
  BACKEND_URL?: string;
}

type TrackItem = Record<string, any>;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://yupify-reworked.vercel.app',
  'https://yupify-reworked.onrender.com',
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'app://localhost'
];

const DEFAULT_HIFI_APIS = [
  'https://hifi-one.itzsantiax.qzz.io',
  'https://hifi-two.itzsantiax.qzz.io',
  'https://eu-central.monochrome.tf',
  'https://us-west.monochrome.tf',
  'https://arran.monochrome.tf',
  'https://api.monochrome.tf',
  'https://monochrome-api.samidy.com',
  'https://triton.squid.wtf',
  'https://wolf.qqdl.site',
  'https://maus.qqdl.site',
  'https://vogel.qqdl.site',
  'https://katze.qqdl.site',
  'https://hund.qqdl.site',
  'https://hifi-one.spotisaver.net',
  'https://hifi-two.spotisaver.net',
  'https://tidal.kinoplus.online'
];

const FAST_SEARCH_POOL = 4;
const FAST_TRACK_POOL = 4;
const SEARCH_TIMEOUT_MS = 4500;
const TRACK_TIMEOUT_MS = 4500;

const TRENDING_TTL_MS = 15 * 60 * 1000;
const TRENDING_TARGET = 600;
const TRENDING_BATCH = 8;
const TRENDING_COUNTRIES = [
  'ar', 'bo', 'br', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'es', 'gt', 'hn',
  'mx', 'ni', 'pa', 'pe', 'pr', 'py', 'sv', 'uy', 've'
];

const DEFAULT_LYRICS_SOURCES = ['apple', 'musixmatch', 'lyricsplus', 'spotify', 'musixmatch-word'];
const DEFAULT_LYRICS_PROVIDERS = ['binimum', 'atomix', 'vercel', 'prjktla'];
const LYRICS_PROVIDER_URLS: Record<string, string> = {
  santiax: 'https://lyricsplus.itzsantiax.qzz.io/v2/lyrics/get',
  binimum: 'https://lyricsplus.binimum.org/v2/lyrics/get',
  prjktla: 'https://lyricsplus.prjktla.workers.dev/v2/lyrics/get',
  atomix: 'https://lyricsplus.atomix.one/v2/lyrics/get',
  vercel: 'https://lyricsplus-seven.vercel.app/v2/lyrics/get'
};

let trendingState: {
  ts: number;
  seeds: Array<{ title: string; artist: string }>;
  seedCursor: number;
  items: TrackItem[];
  seenIds: Set<string>;
} = { ts: 0, seeds: [], seedCursor: 0, items: [], seenIds: new Set() };

function normalizeApi(value: string): string {
  let v = (value || '').toString().trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v.replace(/\/+$/, '');
}

function getApis(env: Env): string[] {
  if (env.HIFI_APIS) {
    const list = env.HIFI_APIS.split(',')
      .map(s => normalizeApi(s))
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return DEFAULT_HIFI_APIS.map(normalizeApi).filter(Boolean);
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isPagesDevOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host.endsWith('.yupify.pages.dev');
  } catch {
    return false;
  }
}

function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return true;
  const envList = parseList(env.CORS_ORIGIN);
  if (envList.length > 0) {
    if (envList.includes('*')) return true;
    if (envList.includes(origin)) return true;
    return isPagesDevOrigin(origin);
  }
  return DEFAULT_ALLOWED_ORIGINS.includes(origin) || isPagesDevOrigin(origin);
}

function buildCorsHeaders(origin: string | null, env: Env): HeadersInit {
  const headers: HeadersInit = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Range, Accept-Ranges'
  };
  if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  if (isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

function textResponse(text: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(text, { status, headers });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const resp = await fetchWithTimeout(url, {}, timeoutMs);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function normalizeSearchText(value: string): string {
  if (!value) return '';
  const text = value.toString().toLowerCase();
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return normalized
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchTitle(item: TrackItem): string {
  return (
    item?.title ||
    item?.name ||
    item?.trackTitle ||
    item?.track?.title ||
    item?.track?.name ||
    item?.data?.title ||
    ''
  );
}

function getSearchArtist(item: TrackItem): string {
  if (item?.artistName) return item.artistName;
  if (item?.artist?.name) return item.artist.name;
  if (typeof item?.artist === 'string') return item.artist;
  if (Array.isArray(item?.artists) && item.artists.length > 0) {
    return item.artists.map((a: any) => a?.name || a).filter(Boolean).join(', ');
  }
  if (item?.track) return getArtistString(item.track);
  return getArtistString(item);
}

function getSearchAlbum(item: TrackItem): string {
  return (
    item?.albumTitle ||
    item?.album?.title ||
    item?.album?.name ||
    item?.albumName ||
    ''
  );
}

function buildSearchQueryInfo(rawQuery: string, kind: string) {
  const normalized = normalizeSearchText(rawQuery || '');
  const tokens = normalized ? normalized.split(' ').filter(Boolean) : [];
  return { raw: rawQuery || '', normalized, tokens, kind: kind || 'track' };
}

function scoreSearchItem(item: TrackItem, queryInfo: { normalized: string; tokens: string[]; kind: string }): number {
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

function rankSearchItems(items: TrackItem[], rawQuery: string, kind = 'track'): TrackItem[] {
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

function hasStrongSearchMatch(items: TrackItem[], rawQuery: string, kind: string): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  const queryInfo = buildSearchQueryInfo(rawQuery, kind);
  if (!queryInfo.normalized) return true;
  return items.some(item => scoreSearchItem(item, queryInfo) >= 900);
}

function getArtistString(track: TrackItem): string {
  if (!track) return '';
  if (Array.isArray(track.artists) && track.artists.length > 0) {
    return track.artists.map((a: any) => a?.name || a).filter(Boolean).join(', ');
  }
  if (track.artist?.name) return track.artist.name;
  if (typeof track.artist === 'string') return track.artist;
  return '';
}

function normalizeQualityValue(value: any): string | null {
  if (!value) return null;
  const raw = String(value).toUpperCase().trim();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'HIRES_LOSSLESS') return 'HI_RES_LOSSLESS';
  if (normalized === 'HIRES') return 'HI_RES';
  return normalized;
}

function isDashMime(mimeType: any): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().includes('dash');
}

function tryDecodeManifest(m: any): any {
  if (!m || typeof m !== 'string') return null;

  let b64 = m.replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';

  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const decodedStr = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(decodedStr);
    } catch {
      return decodedStr;
    }
  } catch {
    return null;
  }
}
async function fetchSearchItems(apis: string[], searchQuery: string, limit: number, offset: number, timeoutMs: number): Promise<TrackItem[]> {
  if (!apis.length) return [];
  const requests = apis.map(api => {
    const url = `${api}/search/?${searchQuery}&li=${limit}&offset=${offset}`;
    return fetchJson(url, timeoutMs)
      .then(data => ({ ok: true, data }))
      .catch(() => ({ ok: false }));
  });

  const responses = await Promise.all(requests);
  return responses
    .filter(r => r.ok && r.data)
    .flatMap(r => (r.data?.data?.items ?? r.data?.items ?? []));
}

function dedupeItems(items: TrackItem[]): TrackItem[] {
  const uniqueItems: TrackItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const idKey = String(item?.id ?? item?.trackId ?? JSON.stringify(item));
    if (!seen.has(idKey)) {
      seen.add(idKey);
      uniqueItems.push(item);
    }
  }
  return uniqueItems;
}

async function searchAnyAPI(env: Env, query: string, limit = 1): Promise<TrackItem[]> {
  if (!query) return [];

  if (env.SEARCH_API) {
    const api = normalizeApi(env.SEARCH_API);
    const url = `${api}/search/?s=${encodeURIComponent(query)}&li=${limit}&offset=0`;
    const remote = await fetchJson(url, SEARCH_TIMEOUT_MS).catch(() => null);
    const items = remote?.data?.items ?? remote?.items ?? [];
    return Array.isArray(items) ? items : [];
  }

  const allAPIs = getApis(env);
  const shuffled = shuffleArray(allAPIs);
  const fast = shuffled.slice(0, Math.min(FAST_SEARCH_POOL, shuffled.length));

  const fastItems = await fetchSearchItems(fast, `s=${encodeURIComponent(query)}`, Math.max(limit, 10), 0, SEARCH_TIMEOUT_MS);
  const uniqueFast = dedupeItems(fastItems);
  const rankedFast = rankSearchItems(uniqueFast, query, 'track');
  if (hasStrongSearchMatch(rankedFast, query, 'track')) {
    return rankedFast.slice(0, limit);
  }

  const allItems = await fetchSearchItems(shuffled, `s=${encodeURIComponent(query)}`, Math.max(limit, 10), 0, SEARCH_TIMEOUT_MS);
  const uniqueItems = dedupeItems(allItems);
  const ranked = rankSearchItems(uniqueItems, query, 'track');
  return ranked.slice(0, limit);
}

async function fetchFirstTrackData(apis: string[], id: string, quality: string, timeoutMs: number) {
  const requests = apis.map(api => {
    const url = `${api}/track/?id=${encodeURIComponent(id)}&quality=${encodeURIComponent(quality)}`;
    return fetchJson(url, timeoutMs)
      .then(data => {
        const payload = data?.data ?? data;
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
    // Promise.any will resolve on the first successful response
    return await Promise.any(requests);
  } catch {
    return null;
  }
}

function getBackendBase(env: Env): string | null {
  const raw = (env.BACKEND_URL || '').toString().trim();
  if (!raw) return null;
  return normalizeApi(raw);
}

async function proxyToBackend(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  const base = getBackendBase(env);
  if (!base) {
    return jsonResponse({ error: 'BACKEND_URL not configured' }, 502, corsHeaders);
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, base);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');

  const init: RequestInit = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual'
  };

  const upstream = await fetch(targetUrl.toString(), init);
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('content-length');
  Object.entries(corsHeaders).forEach(([key, value]) => {
    respHeaders.set(key, String(value));
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders
  });
}

async function fetchRecommendations(apis: string[], params: string): Promise<any | null> {
  const requests = apis.map(api => {
    const url = `${api}/recommendations/?${params}`;
    return fetchJson(url, 10000)
      .then(data => ({ ok: true, data }))
      .catch(() => ({ ok: false }));
  });

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

function normalizeSeedKey(title: string, artist: string): string {
  const t = normalizeSearchText(title || '');
  const a = normalizeSearchText(artist || '');
  return `${t}|${a}`;
}

async function fetchDeezerSeeds(): Promise<Array<{ title: string; artist: string }>> {
  try {
    const url = 'https://api.deezer.com/chart/0/tracks?limit=100&index=0';
    const resp = await fetchJson(url, 10000);
    const tracks = resp?.data ?? [];
    return tracks
      .map((t: any) => ({ title: t?.title, artist: t?.artist?.name }))
      .filter((t: any) => t.title && t.artist);
  } catch {
    return [];
  }
}

async function fetchITunesSeeds(country: string, limit = 100): Promise<Array<{ title: string; artist: string }>> {
  try {
    const url = `https://itunes.apple.com/${country}/rss/topsongs/limit=${limit}/json`;
    const resp = await fetchJson(url, 10000);
    const entries = resp?.feed?.entry ?? [];
    return entries
      .map((e: any) => ({
        title: e?.['im:name']?.label || e?.title?.label,
        artist: e?.['im:artist']?.label
      }))
      .filter((t: any) => t.title && t.artist);
  } catch {
    return [];
  }
}

async function buildTrendingSeeds(): Promise<Array<{ title: string; artist: string }>> {
  const deezer = await fetchDeezerSeeds();
  const itunesLists = await Promise.all(TRENDING_COUNTRIES.map(c => fetchITunesSeeds(c, 100)));
  const itunes = itunesLists.flat();

  const seen = new Set<string>();
  const merged: Array<{ title: string; artist: string }> = [];
  for (const seed of [...deezer, ...itunes]) {
    const key = normalizeSeedKey(seed.title, seed.artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(seed);
  }

  return shuffleArray(merged);
}

async function ensureTrendingItems(env: Env, targetCount: number) {
  while (trendingState.items.length < targetCount && trendingState.seedCursor < trendingState.seeds.length) {
    const batch = trendingState.seeds.slice(trendingState.seedCursor, trendingState.seedCursor + TRENDING_BATCH);
    trendingState.seedCursor += batch.length;

    const results = await Promise.all(batch.map(seed => {
      const query = [seed.title, seed.artist].filter(Boolean).join(' ');
      return searchAnyAPI(env, query, 1)
        .then(items => (items && items.length > 0 ? items[0] : null))
        .catch(() => null);
    }));

    results.forEach(item => {
      if (!item || item.id == null) return;
      const key = String(item.id);
      if (trendingState.seenIds.has(key)) return;
      trendingState.seenIds.add(key);
      trendingState.items.push(item);
    });

    if (trendingState.items.length >= TRENDING_TARGET) break;
  }
}

function getQueryNumber(value: string | null, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function buildSearchPayload(items: TrackItem[], limit: number, offset: number) {
  return {
    version: '2.4',
    data: {
      limit,
      offset,
      totalNumberOfItems: items.length,
      items
    }
  };
}

function getTrackQualityFallback(requested: string): string[] {
  const qualityFallback: Record<string, string[]> = {
    HI_RES_LOSSLESS: ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'],
    LOSSLESS: ['LOSSLESS', 'HIGH', 'LOW'],
    HIGH: ['HIGH', 'LOSSLESS', 'LOW'],
    LOW: ['LOW', 'HIGH', 'LOSSLESS']
  };
  return qualityFallback[requested] || [requested];
}
async function handleSearch(url: URL, env: Env, headers: HeadersInit): Promise<Response> {
  const q = url.searchParams.get('q');
  const s = url.searchParams.get('s');
  const a = url.searchParams.get('a');
  const al = url.searchParams.get('al');
  const limit = Math.min(getQueryNumber(url.searchParams.get('limit') || url.searchParams.get('li'), 20), 100);
  const offset = Math.max(getQueryNumber(url.searchParams.get('offset'), 0), 0);

  let searchQuery = '';
  if (q) searchQuery = `s=${encodeURIComponent(q)}`;
  else if (s) searchQuery = `s=${encodeURIComponent(s)}`;
  else if (a) searchQuery = `a=${encodeURIComponent(a)}`;
  else if (al) searchQuery = `al=${encodeURIComponent(al)}`;

  if (!searchQuery) {
    return jsonResponse({ error: 'Missing search query (q/s/a/al)' }, 400, headers);
  }

  const rawQuery = q || s || a || al || '';
  const searchKind = (q || s) ? 'track' : (a ? 'artist' : (al ? 'album' : 'track'));

  const upstreamLimit = Math.min(80, Math.max(limit, 40));
  const apis = getApis(env);

  if (env.SEARCH_API) {
    const api = normalizeApi(env.SEARCH_API);
    const remote = await fetchJson(`${api}/search/?${searchQuery}&li=${upstreamLimit}&offset=0`, SEARCH_TIMEOUT_MS).catch(() => null);
    const items = remote?.data?.items ?? remote?.items ?? [];
    const ranked = rankSearchItems(dedupeItems(items), rawQuery, searchKind);
    const paged = ranked.slice(offset, offset + limit);
    return jsonResponse(buildSearchPayload(paged, limit, offset), 200, headers);
  }

  const shuffled = shuffleArray(apis);
  const fast = shuffled.slice(0, Math.min(FAST_SEARCH_POOL, shuffled.length));

  const fastItems = await fetchSearchItems(fast, searchQuery, upstreamLimit, 0, SEARCH_TIMEOUT_MS);
  const uniqueFast = dedupeItems(fastItems);
  const rankedFast = rankSearchItems(uniqueFast, rawQuery, searchKind);
  if (hasStrongSearchMatch(rankedFast, rawQuery, searchKind)) {
    const paged = rankedFast.slice(offset, offset + limit);
    return jsonResponse(buildSearchPayload(paged, limit, offset), 200, headers);
  }

  const allItems = await fetchSearchItems(shuffled, searchQuery, upstreamLimit, 0, SEARCH_TIMEOUT_MS);
  const uniqueItems = dedupeItems(allItems);
  const ranked = rankSearchItems(uniqueItems, rawQuery, searchKind);
  const paged = ranked.slice(offset, offset + limit);

  return jsonResponse(buildSearchPayload(paged, limit, offset), 200, headers);
}

async function handleTrack(request: Request, url: URL, env: Env, headers: HeadersInit, id: string): Promise<Response> {
  const VALID_QUALITIES = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
  const qRaw = (url.searchParams.get('quality') || 'LOSSLESS').toUpperCase().trim();
  const requestedQuality = VALID_QUALITIES.includes(qRaw) ? qRaw : 'LOSSLESS';

  const apis = shuffleArray(getApis(env));
  const fast = apis.slice(0, Math.min(FAST_TRACK_POOL, apis.length));

  let success: { ok: boolean; url: string; data: any } | null = null;
  let usedQuality: string | null = null;
  const qualitiesToTry = getTrackQualityFallback(requestedQuality);

  for (const quality of qualitiesToTry) {
    success = await fetchFirstTrackData(fast, id, quality, TRACK_TIMEOUT_MS);
    if (!success) {
      success = await fetchFirstTrackData(apis, id, quality, TRACK_TIMEOUT_MS);
    }
    if (success) {
      usedQuality = quality;
      break;
    }
  }

  if (!success) {
    return jsonResponse({ error: 'Track not found', requestedQuality }, 502, headers);
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

  const reportedQuality = normalizeQualityValue(respData?.audioQuality || respData?.quality || respData?.streamQuality);
  if (!isDashMime(respData?.manifestMimeType) && reportedQuality && VALID_QUALITIES.includes(reportedQuality)) {
    usedQuality = reportedQuality;
  }

  const payload = {
    ...respData,
    requestedQuality,
    usedQuality: usedQuality || requestedQuality
  };

  return jsonResponse(payload, 200, headers);
}

async function handleSimpleProxy(path: string, query: string, env: Env, headers: HeadersInit, timeoutMs = 10000): Promise<Response> {
  const apis = shuffleArray(getApis(env));
  for (const api of apis) {
    const url = `${api}${path}${query ? `?${query}` : ''}`;
    try {
      const data = await fetchJson(url, timeoutMs);
      return jsonResponse(data, 200, headers);
    } catch {
      // try next api
    }
  }
  return jsonResponse({ error: 'Upstream error' }, 502, headers);
}

async function handleLyrics(url: URL, env: Env, headers: HeadersInit): Promise<Response> {
  const title = url.searchParams.get('title');
  const track = url.searchParams.get('track');
  const artist = url.searchParams.get('artist');
  const album = url.searchParams.get('album');
  const duration = url.searchParams.get('duration');
  const source = url.searchParams.get('source');
  const sourcePrefer = url.searchParams.get('sourcePrefer');
  const sourceOnly = url.searchParams.get('sourceOnly');
  const version = url.searchParams.get('version');

  const finalTitle = title || track || '';
  if (!finalTitle || !artist) {
    return jsonResponse({ error: 'Missing required params: title (or track) and artist' }, 400, headers);
  }

  const versionText = (version || '').toString().trim();
  const titleVariants: string[] = [];
  const baseTitle = finalTitle.toString();
  const lowerBaseTitle = baseTitle.toLowerCase();
  const lowerVersion = versionText.toLowerCase();
  const addTitleVariant = (value: string) => {
    if (!value) return;
    if (!titleVariants.includes(value)) titleVariants.push(value);
  };
  if (versionText && !lowerBaseTitle.includes(lowerVersion)) {
    addTitleVariant(`${baseTitle} (${versionText})`);
    addTitleVariant(`${baseTitle} - ${versionText}`);
  }
  addTitleVariant(baseTitle);

  const parseSources = (value: string | null) =>
    (value || '')
      .toString()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

  let sourcesList = source ? parseSources(source) : [...DEFAULT_LYRICS_SOURCES];
  if (sourceOnly) {
    sourcesList = [sourceOnly.toString().trim()].filter(Boolean);
  } else if (sourcePrefer) {
    const prefer = sourcePrefer.toString().trim();
    if (prefer) {
      sourcesList = [prefer, ...sourcesList.filter(s => s !== prefer)];
    }
  }
  if (sourcesList.length === 0) sourcesList = [...DEFAULT_LYRICS_SOURCES];
  const baseSource = sourcesList.join(',');

  const providerParam = (url.searchParams.get('provider') || '').toString().toLowerCase().trim();
  const parseProviders = (value: string) =>
    (value || '')
      .toString()
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

  let providerList = providerParam ? parseProviders(providerParam) : [...DEFAULT_LYRICS_PROVIDERS];
  if (providerParam === 'all') {
    providerList = [...DEFAULT_LYRICS_PROVIDERS];
  }

  if (sourceOnly || (source && parseSources(source).length === 1)) {
    providerList = providerList.filter(p => p !== 'prjktla');
    if (providerList.length === 0) providerList = ['binimum'];
  }

  const forced = (env.LYRICS_MULTI_PROVIDER || '').toString().trim().toLowerCase();
  if (sourcesList.length > 1 && !providerParam && forced && DEFAULT_LYRICS_PROVIDERS.includes(forced)) {
    providerList = [forced, ...providerList.filter(p => p !== forced)];
  }

  providerList = Array.from(new Set(providerList)).filter(p => DEFAULT_LYRICS_PROVIDERS.includes(p) || p === 'santiax');
  if (providerList.length === 0) providerList = [...DEFAULT_LYRICS_PROVIDERS];

  const artistVariants = buildArtistVariants(artist).sort((a, b) => {
    const aScore = a.includes('&') ? 0 : 1;
    const bScore = b.includes('&') ? 0 : 1;
    return aScore - bScore;
  });
  const albumVariants = album ? [album] : ['', finalTitle];
  const durationVariants = duration ? [duration] : [''];

  const paramsVariants: Array<Record<string, string>> = [];
  const seenParams = new Set<string>();
  for (const t of titleVariants) {
    for (const art of artistVariants) {
      for (const alb of albumVariants) {
        for (const dur of durationVariants) {
          const paramsObj = {
            title: t,
            artist: art,
            album: alb || '',
            duration: dur || '',
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

  const paramsToTry = paramsVariants.slice(0, 4);
  const providerUrls = providerList.map(p => LYRICS_PROVIDER_URLS[p]).filter(Boolean);

  let lastError: Error | null = null;
  for (const baseUrl of providerUrls) {
    for (const paramsObj of paramsToTry) {
      const urlToFetch = `${baseUrl}?${new URLSearchParams(paramsObj).toString()}`;
      try {
        const response = await fetchWithTimeout(urlToFetch, {}, 15000);
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        let payload: any = await response.text();
        const trimmed = typeof payload === 'string' ? payload.trim() : '';
        if (trimmed && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
          try {
            payload = JSON.parse(trimmed);
          } catch {
            // keep as text
          }
        }
        const hasLyricsPayload = (obj: any) => {
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
          hasLyricsPayload(payload) ||
          hasLyricsPayload(payload?.data) ||
          hasLyricsPayload(payload?.result) ||
          hasLyricsPayload(payload?.data?.result);

        if (hasLyrics) {
          return jsonResponse(payload, 200, headers);
        }
        lastError = new Error('Lyrics empty');
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  return jsonResponse({ error: 'Lyrics not found', details: lastError?.message || '' }, 502, headers);
}

function buildArtistVariants(raw: string | null): string[] {
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
}

function extractPathParam(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest) return null;
  return decodeURIComponent(rest.replace(/^\/+/, ''));
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const corsHeaders = buildCorsHeaders(origin, env);

    if (origin && !isOriginAllowed(origin, env)) {
      return jsonResponse({ error: 'Not allowed by CORS' }, 403, corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    if (path === '/') {
      return textResponse('Yupify API in cloudflare workers, same endpoints as https://api-one.yupify.qzz.io without auth functions', 200, corsHeaders);
    }

    if (path === '/api/search' && request.method === 'GET') {
      return handleSearch(url, env, corsHeaders);
    }

    const trackId = extractPathParam(path, '/api/track/');
    if (trackId && request.method === 'GET') {
      return handleTrack(request, url, env, corsHeaders, trackId);
    }

    const albumId = extractPathParam(path, '/api/album/');
    if (albumId && request.method === 'GET') {
      return handleSimpleProxy('/album/', `id=${encodeURIComponent(albumId)}`, env, corsHeaders);
    }

    const artistId = extractPathParam(path, '/api/artist/');
    if (artistId && request.method === 'GET') {
      const f = url.searchParams.get('f');
      const query = f ? `id=${encodeURIComponent(artistId)}&f=${encodeURIComponent(f)}` : `id=${encodeURIComponent(artistId)}`;
      return handleSimpleProxy('/artist/', query, env, corsHeaders);
    }

    const playlistId = extractPathParam(path, '/api/playlist/');
    if (playlistId && request.method === 'GET') {
      return handleSimpleProxy('/playlist/', `id=${encodeURIComponent(playlistId)}`, env, corsHeaders);
    }

    if (path === '/api/recommendations' && request.method === 'GET') {
      const params = new URLSearchParams(url.searchParams);
      if (url.searchParams.get('limit') && !url.searchParams.get('li')) {
        params.set('li', url.searchParams.get('limit') || '');
      }
      if (url.searchParams.get('li') && !url.searchParams.get('limit')) {
        params.set('limit', url.searchParams.get('li') || '');
      }
      const apis = shuffleArray(getApis(env));
      const remote = await fetchRecommendations(apis, params.toString());
      if (!remote) {
        return jsonResponse({ version: '2.4', data: { limit: 0, offset: 0, totalNumberOfItems: 0, items: [] } }, 200, corsHeaders);
      }
      const items = remote?.data?.items ?? remote?.items ?? remote?.data ?? [];
      if (Array.isArray(items)) {
        const normalizedItems = items.map((item: any) => {
          if (item && item.id == null && item.trackId != null) {
            return { ...item, id: item.trackId };
          }
          return item;
        });
        return jsonResponse({
          version: remote?.version || '2.4',
          data: {
            limit: Number(url.searchParams.get('limit') ?? url.searchParams.get('li')) || normalizedItems.length,
            offset: Number(url.searchParams.get('offset')) || 0,
            totalNumberOfItems: normalizedItems.length,
            items: normalizedItems
          }
        }, 200, corsHeaders);
      }
      return jsonResponse(remote, 200, corsHeaders);
    }

    if (path === '/api/lyrics' && request.method === 'GET') {
      return handleLyrics(url, env, corsHeaders);
    }

    if (path === '/api/cover' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      const q = url.searchParams.get('q');
      const query = id ? `id=${encodeURIComponent(id)}` : `q=${encodeURIComponent(q || '')}`;
      return handleSimpleProxy('/cover/', query, env, corsHeaders);
    }

    if (path === '/api/home' && request.method === 'GET') {
      const country = url.searchParams.get('country') || 'US';
      return handleSimpleProxy('/home/', `country=${encodeURIComponent(country)}`, env, corsHeaders, 7000);
    }

    if (path === '/api/trending' && request.method === 'GET') {
      const limit = Math.min(getQueryNumber(url.searchParams.get('limit'), 20), 50);
      const offset = Math.max(getQueryNumber(url.searchParams.get('offset'), 0), 0);

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
      await ensureTrendingItems(env, target);

      const items = trendingState.items.slice(offset, offset + limit);
      const hasMore = trendingState.seedCursor < trendingState.seeds.length && trendingState.items.length < TRENDING_TARGET;

      return jsonResponse({
        items,
        total: trendingState.items.length,
        limit,
        offset,
        hasMore,
        source: 'deezer+itunes'
      }, 200, corsHeaders);
    }

    const mixId = extractPathParam(path, '/api/mix/');
    if (mixId && request.method === 'GET') {
      const country = url.searchParams.get('country') || 'US';
      return handleSimpleProxy('/mix/', `id=${encodeURIComponent(mixId)}&country=${encodeURIComponent(country)}`, env, corsHeaders);
    }

    // Proxy to Node backend for auth/user/download/audio routes
    if (path.startsWith('/api/download') || path.startsWith('/api/audio/file') || path.startsWith('/api/user') || path.startsWith('/api/auth')) {
      return proxyToBackend(request, env, corsHeaders);
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
  }
};
