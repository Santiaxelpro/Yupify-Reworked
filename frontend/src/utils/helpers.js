// src/utils/helpers.js

/**
 * Formatear segundos a formato mm:ss
 */
export const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Formatear duración larga (horas, minutos)
 */
export const formatDuration = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0 min';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins} min`;
};

/**
 * Formatear número de reproducciones
 */
export const formatPlays = (plays) => {
  if (!plays) return '0';
  if (plays >= 1000000) {
    return `${(plays / 1000000).toFixed(1)}M`;
  }
  if (plays >= 1000) {
    return `${(plays / 1000).toFixed(1)}K`;
  }
  return plays.toString();
};

/**
 * Obtener URL de cover con fallback
 */
/**
 * Obtener URL de cover desde Tidal con fallback local
 */
/**
 * Obtener URL de cover desde TIDAL sin fallback externo
 */
export const getCoverUrl = (track, size = 1280) => {
  if (!track) return null;

  // Si ya viene una URL completa desde tu API
  if (track.cover && track.cover.startsWith("http")) {
    return track.cover;
  }

  // Si existe ID de portada de Tidal
  if (track.album?.cover) {
    const coverId = track.album.cover.replace(/-/g, "/");
    return `https://resources.tidal.com/images/${coverId}/${size}x${size}.jpg`;
  }

  // Si no existe portada, se retorna null sin fallback
  return null;
};



/**
 * Obtener nombre del artista (preferir múltiples artistas)
 */
export const getArtistName = (track) => {
  // Preferir array de múltiples artistas
  if (track.artists && Array.isArray(track.artists) && track.artists.length > 0) {
    return track.artists.map(a => a.name || a).join(', ');
  }
  // Fallback a artista singular
  if (track.artist?.name) return track.artist.name;
  if (typeof track.artist === 'string') return track.artist;
  return 'Artista Desconocido';
};

/**
 * Obtener calidad de audio formateada
 */
export const getAudioQuality = (quality) => {
  const qualities = {
    'HI_RES_LOSSLESS': '192kHz/24bit FLAC',
    'HI_RES': '96kHz/24bit MQA',
    'LOSSLESS': '44.1kHz/16bit FLAC',
    'HIGH': '320kbps AAC',
    'LOW': '96kbps AAC'
  };
  
  return qualities[quality] || quality;
};

/**
 * Barajar array (shuffle)
 */
export const shuffleArray = (array) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

/**
 * Debounce function
 */
export const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

/**
 * Validar email
 */
export const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

/**
 * Obtener color dominante de imagen (simplificado)
 */
export const getDominantColor = (imageUrl) => {
  // Retorna colores por defecto
  // En producción, usar una librería como color-thief
  const colors = [
    '#1db954', // green
    '#22c55e', // green light
    '#10b981', // green
    '#3b82f6', // blue
    '#f59e0b', // orange
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

/**
 * Copiar al portapapeles
 */
export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Error copiando al portapapeles:', err);
    return false;
  }
};

/**
 * Detectar si es dispositivo móvil
 */
export const isMobile = () => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
};

/**
 * Detectar si soporta notificaciones
 */
export const supportsNotifications = () => {
  return 'Notification' in window && 'serviceWorker' in navigator;
};

/**
 * Solicitar permiso de notificaciones
 */
export const requestNotificationPermission = async () => {
  if (!supportsNotifications()) return false;
  
  try {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  } catch (err) {
    console.error('Error solicitando permiso de notificaciones:', err);
    return false;
  }
};

/**
 * Mostrar notificación
 */
export const showNotification = (title, options = {}) => {
  if (!supportsNotifications() || Notification.permission !== 'granted') {
    return;
  }
  
  try {
    const notification = new Notification(title, {
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      ...options
    });
    
    return notification;
  } catch (err) {
    console.error('Error mostrando notificación:', err);
  }
};

/**
 * Guardar en localStorage de forma segura
 */
export const setLocalStorage = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error('Error guardando en localStorage:', err);
    return false;
  }
};

/**
 * Obtener de localStorage de forma segura
 */
export const getLocalStorage = (key, defaultValue = null) => {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (err) {
    console.error('Error leyendo de localStorage:', err);
    return defaultValue;
  }
};

/**
 * Eliminar de localStorage
 */
export const removeLocalStorage = (key) => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (err) {
    console.error('Error eliminando de localStorage:', err);
    return false;
  }
};

export default {
  formatTime,
  formatDuration,
  formatPlays,
  getCoverUrl,
  getArtistName,
  getAudioQuality,
  shuffleArray,
  debounce,
  validateEmail,
  getDominantColor,
  copyToClipboard,
  isMobile,
  supportsNotifications,
  requestNotificationPermission,
  showNotification,
  setLocalStorage,
  getLocalStorage,
  removeLocalStorage
};
