import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Launcher del Service Worker descifrador de Amazon Music.
// Solo intercepta /api/decrypt-stream para descifrar (CENC/AES-CTR) el
// stream en el navegador; no cachea HTML ni assets, así que no hay riesgo
// de servir HTML o JS viejos desde caché.
const SW_DECRYPTER = '/sw-amazon.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // Limpiar cachés y desregistrar SW viejos (p.ej. el de caching sw.js)
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
      const registrations = await navigator.serviceWorker.getRegistrations()
      const keep = registrations.filter(r =>
        r.active && String(r.active.scriptURL || '').endsWith('/sw-amazon.js')
      )
      await Promise.all(
        registrations.filter(r => !keep.includes(r)).map(r => r.unregister())
      )

      // Registrar/actualizar el SW descifrador
      const reg = await navigator.serviceWorker.register(SW_DECRYPTER, { scope: '/' })
      if (reg.active) await reg.active.postMessage?.({ type: 'SKIP_WAITING' })
      console.log('SW descifrador registrado:', SW_DECRYPTER)
    } catch (error) {
      console.log('No se pudo registrar el SW descifrador:', error)
    }
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
