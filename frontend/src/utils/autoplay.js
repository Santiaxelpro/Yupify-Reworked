// src/utils/autoplay.js
import { getArtistName } from './helpers';

const WEIGHTS = {
  similarity: 0.5,
  affinity: 0.3,
  trending: 0.05,
  popularity: 0.05,
  sameArtist: 0.9,
  sameAlbum: 0.25,
  sameGenre: 0.75,
  titleOverlap: 0.1,
  durationMatch: 0.05,
  favoriteBoost: 0.6,
  historyBoost: 0.5,
  trendingBoost: 0.12,
  genreBoost: 0.35,
  crossGenrePenalty: 0.5,
  unknownGenrePenalty: 0.25,
  skipPenalty: 0.7
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const hashSeed = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  const str = value != null ? value.toString() : '';
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const makeRng = (seed) => {
  if (seed == null || seed === '') return null;
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const getSessionJitter = (context) => {
  const raw = Number(context?.sessionJitter);
  if (!Number.isFinite(raw)) return 0.04;
  return clamp(raw, 0, 0.15);
};

export const normalizeText = (text) => {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u00ff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const tokenize = (text) => {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(' ') : [];
};

export const jaccard = (tokensA, tokensB) => {
  if (!tokensA?.length || !tokensB?.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
};

export const getTitleKey = (text) => normalizeText(text);

export const getArtistKey = (track) => normalizeText(getArtistName(track));

export const getAlbumKey = (track) => {
  if (!track) return '';
  const album = track.album?.title || track.album?.name || '';
  return normalizeText(album);
};

export const getGenreTerm = (track) => {
  if (!track) return '';
  if (typeof track.genre === 'string') return track.genre;
  if (track.genre?.name) return track.genre.name;
  if (track.genre?.title) return track.genre.title;
  if (track.album?.genre?.name) return track.album.genre.name;
  if (track.album?.genre?.title) return track.album.genre.title;
  if (Array.isArray(track.album?.genres) && track.album.genres.length > 0) {
    const firstAlbumGenre = track.album.genres[0];
    if (typeof firstAlbumGenre === 'string') return firstAlbumGenre;
    if (firstAlbumGenre?.name) return firstAlbumGenre.name;
  }
  if (Array.isArray(track.genres) && track.genres.length > 0) {
    const first = track.genres[0];
    if (typeof first === 'string') return first;
    if (first?.name) return first.name;
  }
  return '';
};

const buildGenreText = (track) => {
  if (!track) return '';
  const title = track.title || '';
  const artistName = getArtistName(track);
  const safeArtist = artistName && artistName !== 'Artista Desconocido' ? artistName : '';
  const album = track.album?.title || track.album?.name || '';
  const combined = [title, safeArtist, album].filter(Boolean).join(' ');
  return normalizeText(combined);
};

const inferGenreBucket = (track) => {
  const text = buildGenreText(track);
  if (!text) return '';

  const hasAny = (terms) => terms.some((term) => text.includes(term));

  if (hasAny(['phonk'])) return 'phonk_funk';
  if (hasAny(['funk', 'montagem', 'baile', 'mandelao'])) return 'phonk_funk';
  if (hasAny(['k pop', 'kpop', 'bts'])) return 'kpop';
  if (hasAny(['reggaeton', 'regueton'])) return 'reggaeton';
  if (hasAny(['trap'])) return 'trap';
  if (hasAny(['drill'])) return 'drill';

  return '';
};

export const getGenreBucket = (track) => {
  const raw = normalizeText(getGenreTerm(track));
  const inferred = inferGenreBucket(track);
  const base = raw || inferred;
  if (!base) return '';
  if (base.includes('phonk') || base.includes('funk')) return 'phonk_funk';
  if (base.includes('k pop') || base.includes('kpop')) return 'kpop';
  if (base.includes('reggaeton') || base.includes('regueton')) return 'reggaeton';
  return base;
};

export const getGenreKey = (track) => getGenreBucket(track);

export const getAlbumTerm = (track) => {
  if (!track) return '';
  return track.album?.title || track.album?.name || '';
};

export const getFirstWord = (text) => {
  const tokens = tokenize(text);
  for (const token of tokens) {
    if (token.length >= 3) return token;
  }
  return '';
};

export const getTrackKey = (track) => {
  if (!track) return '';
  const title = getTitleKey(track.title);
  const artist = getArtistKey(track);
  if (title || artist) return `t:${title}|a:${artist}`;
  if (track.id != null) return `id:${track.id}`;
  return '';
};

const buildTrackInfo = (track) => ({
  track,
  key: getTrackKey(track),
  titleTokens: tokenize(track?.title),
  artistKey: getArtistKey(track),
  albumKey: getAlbumKey(track),
  genreKey: getGenreKey(track),
  duration: toNumber(track?.duration)
});

const getAffinitySignals = (candidateInfo, context) => {
  const favoriteIds = context?.favoriteIds;
  const favoriteKeys = context?.favoriteKeys;
  const historyIndexById = context?.historyIndexById;
  const historyIndexByKey = context?.historyIndexByKey;
  const historyById = context?.historyById;
  const historyByKey = context?.historyByKey;
  const historyLength = context?.historyLength || 0;

  const id = candidateInfo.track?.id;
  const key = candidateInfo.key;

  const isFavorite = (id != null && favoriteIds?.has(id)) || (key && favoriteKeys?.has(key));

  let historyWeight = 0;
  let historyEntry = null;
  if (historyLength > 0) {
    let index = id != null ? historyIndexById?.get(id) : undefined;
    if (index == null && key) {
      index = historyIndexByKey?.get(key);
    }
    if (index != null) {
      const denom = Math.max(1, historyLength - 1);
      historyWeight = 1 - (index / denom);
    }

    if (historyById && id != null && historyById.has(id)) {
      historyEntry = historyById.get(id);
    } else if (historyByKey && key && historyByKey.has(key)) {
      historyEntry = historyByKey.get(key);
    }
  }

  let listenRatio = 1;
  if (historyEntry) {
    const ratio = Number(historyEntry.listenRatio);
    if (Number.isFinite(ratio)) {
      listenRatio = clamp(ratio, 0, 1);
    } else {
      const listenSeconds = Number(historyEntry.listenSeconds);
      const duration = Number(historyEntry.duration);
      if (Number.isFinite(listenSeconds) && Number.isFinite(duration) && duration > 0) {
        listenRatio = clamp(listenSeconds / duration, 0, 1);
      }
    }
  }

  const skipped = Boolean(historyEntry?.skipped);
  const skipPenalty = skipped
    ? WEIGHTS.skipPenalty * Math.max(0.35, 1 - listenRatio) * (0.6 + historyWeight * 0.4)
    : 0;

  const affinityScore = clamp(
    (isFavorite ? WEIGHTS.favoriteBoost : 0)
      + (historyWeight * WEIGHTS.historyBoost * listenRatio)
  );

  return {
    isFavorite,
    historyWeight,
    affinityScore,
    listenRatio,
    skipped,
    skipPenalty
  };
};

const scoreTrackInfo = (candidateInfo, context, currentInfo) => {
  if (!candidateInfo?.track || !currentInfo?.track) return 0;

  const sameArtist = candidateInfo.artistKey && candidateInfo.artistKey === currentInfo.artistKey ? 1 : 0;
  const sameAlbum = candidateInfo.albumKey && candidateInfo.albumKey === currentInfo.albumKey ? 1 : 0;
  const sameGenre = candidateInfo.genreKey && candidateInfo.genreKey === currentInfo.genreKey ? 1 : 0;
  const titleOverlap = jaccard(candidateInfo.titleTokens, currentInfo.titleTokens);

  let durationMatch = 0;
  if (candidateInfo.duration > 0 && currentInfo.duration > 0) {
    const diff = Math.abs(candidateInfo.duration - currentInfo.duration) / currentInfo.duration;
    durationMatch = diff <= 0.15 ? 1 : 0;
  }

  const similarityScore = clamp(
    (sameArtist * WEIGHTS.sameArtist)
      + (sameAlbum * WEIGHTS.sameAlbum)
      + (sameGenre * WEIGHTS.sameGenre)
      + (titleOverlap * WEIGHTS.titleOverlap)
      + (durationMatch * WEIGHTS.durationMatch)
  );

  const trendingIds = context?.trendingIds;
  const maxPlays = context?.maxPlays || 0;
  const id = candidateInfo.track?.id;
  const { affinityScore, skipPenalty } = getAffinitySignals(candidateInfo, context);

  const isTrending = id != null && trendingIds?.has(id);
  const trendingScore = sameGenre ? clamp(isTrending ? WEIGHTS.trendingBoost : 0) : 0;

  const plays = toNumber(candidateInfo.track?.plays);
  const popularityScore = sameGenre && maxPlays > 0 ? clamp(plays / maxPlays) : 0;

  let genreScore = 0;
  if (currentInfo.genreKey) {
    if (sameGenre) {
      genreScore = WEIGHTS.genreBoost;
    } else if (candidateInfo.genreKey) {
      genreScore = -WEIGHTS.crossGenrePenalty;
    } else if (!sameArtist) {
      genreScore = -WEIGHTS.unknownGenrePenalty;
    }
  }

  return (similarityScore * WEIGHTS.similarity)
    + (affinityScore * WEIGHTS.affinity)
    + (trendingScore * WEIGHTS.trending)
    + (popularityScore * WEIGHTS.popularity)
    + genreScore
    - skipPenalty;
};

export const scoreTrack = (candidate, context) => {
  const candidateInfo = buildTrackInfo(candidate);
  const currentInfo = buildTrackInfo(context?.currentTrack);
  return scoreTrackInfo(candidateInfo, context, currentInfo);
};

const similarityBetween = (aInfo, bInfo) => {
  if (!aInfo?.track || !bInfo?.track) return 0;
  let score = 0;
  if (aInfo.artistKey && bInfo.artistKey && aInfo.artistKey === bInfo.artistKey) {
    score += 0.55;
  }
  if (aInfo.albumKey && bInfo.albumKey && aInfo.albumKey === bInfo.albumKey) {
    score += 0.15;
  }
  if (aInfo.genreKey && bInfo.genreKey && aInfo.genreKey === bInfo.genreKey) {
    score += 0.2;
  }
  const titleOverlap = jaccard(aInfo.titleTokens, bInfo.titleTokens);
  score += titleOverlap * 0.1;
  return clamp(score);
};

export const rankWithMMR = (candidates, context, limit = 20, lambda = 0.7) => {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const rng = makeRng(context?.sessionSeed);
  const random = rng || Math.random;
  const jitterScale = getSessionJitter(context);

  const currentInfo = buildTrackInfo(context?.currentTrack);
  const relatednessFloor = Number.isFinite(context?.relatednessFloor)
    ? clamp(context.relatednessFloor, 0, 1)
    : 0.12;
  const minRelated = Number.isFinite(context?.minRelated)
    ? Math.max(0, context.minRelated)
    : Math.min(12, limit);
  const minSameGenreCandidates = Number.isFinite(context?.minSameGenreCandidates)
    ? Math.max(0, context.minSameGenreCandidates)
    : 8;

  let candidatePool = candidates;
  if (currentInfo?.genreKey) {
    const sameGenreCandidates = candidates.filter((track) => (
      getGenreKey(track) === currentInfo.genreKey
    ));
    if (sameGenreCandidates.length >= minSameGenreCandidates) {
      candidatePool = sameGenreCandidates;
    }
  }

  const scored = candidatePool
    .map((track) => {
      const info = buildTrackInfo(track);
      const jitter = jitterScale > 0 ? (random() - 0.5) * jitterScale : 0;
      const relatedness = similarityBetween(info, currentInfo);
      const { affinityScore } = getAffinitySignals(info, context);
      return {
        track,
        info,
        score: scoreTrackInfo(info, context, currentInfo),
        jitter,
        relatedness,
        affinityScore
      };
    })
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return (b.jitter || 0) - (a.jitter || 0);
    });

  const related = scored.filter((item) => (
    item.relatedness >= relatednessFloor || item.affinityScore > 0
  ));
  const useRelatedOnly = related.length >= Math.min(minRelated, limit);
  const pool = useRelatedOnly ? related.slice() : scored.slice();

  const selected = [];
  const selectedInfo = [];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    let bestBase = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const item = pool[i];
      let maxSim = 0;
      for (const chosen of selectedInfo) {
        const sim = similarityBetween(item.info, chosen);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = (lambda * item.score) - ((1 - lambda) * maxSim) + (item.jitter || 0);
      if (mmrScore > bestScore || (mmrScore === bestScore && item.score > bestBase)) {
        bestScore = mmrScore;
        bestBase = item.score;
        bestIndex = i;
      }
    }

    const [chosen] = pool.splice(bestIndex, 1);
    selected.push(chosen.track);
    selectedInfo.push(chosen.info);
  }

  if (context?.sessionSeed && selected.length > 1) {
    const chunkSize = 5;
    for (let start = 0; start < selected.length; start += chunkSize) {
      const end = Math.min(selected.length, start + chunkSize);
      for (let i = end - 1; i > start; i -= 1) {
        const j = start + Math.floor(random() * (i - start + 1));
        const temp = selected[i];
        selected[i] = selected[j];
        selected[j] = temp;
      }
    }
  }

  return selected;
};

export const buildCandidates = ({
  sources = [],
  currentTrack,
  queue = [],
  playedIds,
  playedTitleKeys,
  recentArtists = [],
  limit = 300
}) => {
  const byKey = new Map();
  const currentId = currentTrack?.id;
  const currentTitleKey = getTitleKey(currentTrack?.title);

  const queuedIds = new Set(queue.map((track) => track?.id).filter((id) => id != null));
  const queuedTitleKeys = new Set(
    queue
      .map((track) => getTitleKey(track?.title))
      .filter((key) => key)
  );

  const recentArtistSet = new Set(recentArtists.filter(Boolean));

  const shouldReplace = (incoming, existing) => {
    const incomingPlays = toNumber(incoming?.plays);
    const existingPlays = toNumber(existing?.plays);
    if (incomingPlays > existingPlays) return true;
    if (incomingPlays < existingPlays) return false;

    const incomingDuration = toNumber(incoming?.duration) > 0;
    const existingDuration = toNumber(existing?.duration) > 0;
    if (incomingDuration && !existingDuration) return true;
    if (!incomingDuration && existingDuration) return false;

    const incomingCover = Boolean(incoming?.cover || incoming?.album?.cover);
    const existingCover = Boolean(existing?.cover || existing?.album?.cover);
    if (incomingCover && !existingCover) return true;

    return false;
  };

  const maybeAdd = (track) => {
    if (!track) return;

    const key = getTrackKey(track);
    if (!key) return;

    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (shouldReplace(track, existing)) {
        byKey.set(key, track);
      }
      return;
    }

    if (byKey.size >= limit) return;

    if (currentId != null && track.id === currentId) return;

    if (track.id != null) {
      if (queuedIds.has(track.id)) return;
      if (playedIds?.has(track.id)) return;
    }

    const titleKey = getTitleKey(track.title);
    if (titleKey) {
      if (currentTitleKey && titleKey === currentTitleKey) return;
      if (queuedTitleKeys.has(titleKey)) return;
      if (playedTitleKeys?.has(titleKey)) return;
    }

    const artistKey = getArtistKey(track);
    if (artistKey && recentArtistSet.has(artistKey)) return;

    byKey.set(key, track);
  };

  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const track of source) {
      maybeAdd(track);
    }
  }

  return Array.from(byKey.values());
};
