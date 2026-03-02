# Yupify Reworked
Un stack completo para streaming de musica hi-fi: frontend web, backend propio y caminos a desktop.

**Que Hay**
- Frontend React + Vite + Tailwind en `frontend/`.
- Backend Node + Express con cache y auth en `backend/`.
- Desktop con Tauri (y soporte Electron definido en `package.json`).
- Scripts de build y empaquetado en la raiz y `scripts/`.

**Features**
- Busqueda, trending, recomendaciones y autoplay continuo.
- Player con cola, repeat/shuffle, control de calidad y descarga.
- Letras con multiples fuentes y cache (opcional).
- Favoritos, playlists, historial y stats de usuario.
- Auth con JWT y almacenamiento en PostgreSQL o memoria.
- Media Session + Discord Rich Presence cuando corre en Tauri.

**Arquitectura**
- Frontend consume `/api/*` y usa proxy Vite en dev.
- Backend agrega multiples instancias HiFi y normaliza respuestas.
- Persistencia opcional con PostgreSQL; si no hay `DATABASE_URL`, usa memoria.

**Inicio Rapido**
Requisitos:
- Node >= 18, npm >= 9.
- Opcional: PostgreSQL, FFmpeg, Rust + Tauri CLI.

Instalar deps:
```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

Desarrollo (web):
```bash
npm run dev
```

Abrir:
```bash
http://localhost:5173
```

**Scripts Utiles**
Raiz:
- `npm run dev` (frontend + backend)
- `npm run electron-dev`
- `npm run dist`

Backend (`backend/`):
- `npm run dev`
- `npm start`
- `npm run lint`

Frontend (`frontend/`):
- `npm run dev`
- `npm run build`
- `npm run dev:tauri`
- `npm run build:tauri`

**Env Frontend**
| Variable | Uso | Default |
| --- | --- | --- |
| `VITE_API_URL` | URL del backend | vacio (usa proxy a `http://localhost:3000`) |

Ver plantilla en `frontend/.env.example`.

**Env Backend Basico**
| Variable | Uso | Default |
| --- | --- | --- |
| `PORT` | puerto del backend | `3000` |
| `DATABASE_URL` | habilita PostgreSQL | sin DB (memoria) |
| `PGSSL` | fuerza SSL en PG | `false` |
| `JWT_SECRET` | firma JWT | `yupify_secret_key` |
| `CORS_ORIGIN` | origen permitido | lista interna o `*` |
| `SEARCH_API` | fuerza API HiFi | auto |
| `FFMPEG_PATH` | ruta ffmpeg | `ffmpeg` |
| `FFMPEG_PROBE` | valida ffmpeg al boot | `false` |

**Env Avanzado**
Cache/lyrics:
| Variable | Uso |
| --- | --- |
| `AUTH_KEY_CLIENT_ID` | OAuth Google Drive |
| `AUTH_KEY_CLIENT_SECRET` | OAuth Google Drive |
| `AUTH_KEY_REFRESH_TOKEN` | OAuth Google Drive |
| `GDRIVE_CACHED_TTML` | carpeta cache letras (apple) |
| `GDRIVE_CACHED_MUSIXMATCH` | carpeta cache letras (musixmatch) |
| `GDRIVE_CACHED_SPOTIFY` | carpeta cache letras (spotify) |
| `GDRIVE_USERTML_JSON` | carpeta cache letras (lyricsplus) |
| `GDRIVE_CACHED_LYRICS` | carpeta cache letras (default) |
| `GDRIVE_SONGS_FILE_ID` | archivo de canciones |
| `GDRIVE_CACHED_AUDIO` | carpeta cache audio |
| `GDRIVE_CACHED_SEARCH` | carpeta cache search |
| `LYRICS_CACHE_FOLDER_MODE` | `per-source` o `single` |
| `LYRICS_MULTI_PROVIDER` | fuerza proveedor letras |
| `AUDIO_CACHE_MODE` | `async` o `sync` |
| `AUDIO_CACHE_FALLBACK_LOSSLESS` | fallback lossless |
| `AUDIO_CACHE_WITH_METADATA` | embebe metadata |
| `AUDIO_CACHE_DASH` | cache DASH |
| `AUDIO_CACHE_READ` | lee cache |
| `ONLY_GOOGLE_DRIVE` | solo cache GDrive |
| `AUDIO_CACHE_DASH_USER_AGENT` | UA para DASH |
| `LYRICS_CACHE_DEBUG` | debug lyrics |
| `AUDIO_CACHE_DEBUG` | debug audio |
| `SEARCH_CACHE_DEBUG` | debug search |

**Endpoints**
Salud:
```bash
curl http://localhost:3000/health
```

Principales:
- `POST /api/auth/register`, `POST /api/auth/login`
- `GET /api/search`, `GET /api/trending`, `GET /api/recommendations`
- `GET /api/track/:id`, `GET /api/album/:id`, `GET /api/artist/:id`
- `GET /api/lyrics`, `POST /api/download/:id`
- `GET /api/home`, `GET /api/mix/:id`, `GET /api/cover`
- `GET/POST/DELETE /api/user/*` (playlists, favoritos, historial, stats)

**Builds**
Web:
```bash
npm run build:frontend
```

Tauri (desktop):
```bash
cd frontend
npm run build:tauri
```

Electron (desktop):
```bash
npm run dist
```

Android (ffi):
```bash
bash scripts/build-android-ffi.sh
```

**Estructura**
```text
.
|- backend/
|- frontend/
|  |- src/
|  `- src-tauri/
|- scripts/
|- package.json
`- README.MD
```

**Notas**
- El backend lee `.env` en `backend/` y tambien `/etc/secrets/.env` si existe.
- Si quieres Electron, crea los entrypoints `electron-main.js` y `electron-preload.js` o ajusta `package.json`.
- No hay `LICENSE` en el repo; en `package.json` raiz figura `Apache-2.0` y en `backend/package.json` `MIT`.
