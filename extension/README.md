# Extensión de Chrome (MV3)

Mide la jornada del colaborador (spec `docs/specs/2026-09-29-time-tracking-extension.md` §3). Solo mide con la jornada iniciada y con sesión iniciada.

## Comandos (desde la raíz: `npm run <script> -w extension`)

| Script | Qué hace |
|---|---|
| `build` | Build **prod** → `extension/dist` (usa `.env.production`) |
| `build:dev` | Build **dev** → `extension/dist-dev` (emuladores en 127.0.0.1) |
| `dev` | Build dev en modo watch |
| `typecheck` / `test` | TypeScript estricto / Vitest (node, mocks de `chrome.*`) |
| `smoke` | Carga `dist-dev` en Chromium (Playwright) y verifica que el service worker arranca y responde al popup |

Prueba de extremo a extremo contra emuladores (login dev → `joinOrg` → iniciar/cerrar jornada → documentos en Firestore): `npm run e2e:extension` en la raíz.

`smoke` necesita el Chromium de Playwright (`npx playwright install chromium`), uno ya descargado en `ms-playwright/chromium-*` o `SMOKE_CHROMIUM=<ruta a chrome>`. Google Chrome de marca ignora `--load-extension` desde la v137.

## Cargar en Chrome

`chrome://extensions` → Modo desarrollador → **Cargar descomprimida** → `extension/dist-dev` (o `dist`).

- El build dev lleva `key` fija en el manifest (`build/manifest.ts`), así que su ID es siempre **`klmbbjhphdmmicdbbgkofkpgapcinbmd`**. La clave privada se descartó a propósito: una extensión descomprimida solo necesita la pública, y el ID de producción lo asigna Chrome Web Store (el manifest prod no lleva `key`).
- Para el login dev: `firebase emulators:start --only auth,firestore,functions,storage --project demo-timetracking` (tras `npm run build:functions`). Con el correo de `BOOTSTRAP_ADMINS` (`functions/.env.demo-timetracking`) o uno invitado.

## Configuración

- `.env.development`: valores del proyecto demo de emuladores; no hay que tocarlo.
- `.env.production`: configuración web del proyecto Firebase real, con placeholders `REEMPLAZAR_...` (no son secretos). Puedes dejar los valores reales en `.env.production.local` (no se versiona). Mientras queden placeholders el build avisa. `VITE_OAUTH_CLIENT_ID` (cliente OAuth "Extensión de Chrome") agrega `oauth2` al manifest para el login real (Tarea 5).

## Arquitectura

```
src/
  background/            service worker (módulo ES, un solo archivo)
    index.ts             entrada: registra listeners en el primer turno
    app.ts               cableado + router de mensajes + popup API
    tracker.ts           eventos de Chrome → SlotAccumulator (shared)
    session.ts           iniciar/cerrar jornada, pulso de 30 s, badge, alarmas
    state.ts             chrome.storage.local + mutex (escrituras serializadas)
    queue.ts             cola persistente con coalescencia
    sync.ts              motor de subida (Backend), reintentos, normalización
    firebase.ts          Firebase en el SW + Backend de Firestore + subida a Storage
    auth.ts              AuthService (login dev con emulador; Google en Tarea 5) + joinOrg
  content/activity.ts    content script (IIFE): solo “hubo input” + timestamp
  popup/main.ts          popup mínimo (se rediseña en Tarea 5)
  messages.ts            tipos de mensajes entre partes
build/                   manifest y configs de Vite (3 builds: background ES, content IIFE, popup)
scripts/                 build.ts, smoke.ts (Node ≥ 22.18, TypeScript sin compilar)
```

### Medición
- Foco = pestaña activa de la ventana enfocada; `WINDOW_ID_NONE` o incógnito = fuera de Chrome. `locked` también cuenta como fuera de Chrome.
- Pestaña **medible** = su content script ya hizo `hello` (o mandó actividad) desde el origen actual. Si no (chrome://, Web Store, visor PDF, página cargando) el acumulador usa `chrome.idle` como fuente de actividad.
- `chrome.alarms` cada 30 s: `tick` (un hueco > 90 s se descarta como "sin datos"), relectura de idle/foco, `flush`. Los bloques cerrados entran a la cola persistente **antes** de guardar el acumulador. El bloque en curso y el latido se encolan cada ~60 s. Al cerrar la jornada el bloque parcial se sube de inmediato y otra vez (idéntico) cuando cierra; después la alarma se apaga sola.

### Sincronización
- Cola FIFO en `chrome.storage.local`, coalescida por documento (el snapshot más nuevo de un bloque reemplaza al anterior; un latido por sesión). Idempotente: `activity/{uid_slotStart}` con `setDoc(..., { merge: true })` (nunca rutas con puntos: las claves de `domains` tienen puntos).
- Error transitorio (sin red, sin usuario, 503…) → backoff exponencial 5 s → 10 min; el evento `online` reintenta de inmediato. Error permanente → se descarta.
- `permission-denied` en el latido/cierre/creación de la sesión = la jornada ya está cerrada en el servidor (cierre automático, reglas la vuelven inmutable) o el usuario fue desactivado → se cierra localmente (badge OFF, aviso en el popup) y no se reintenta.

### Firebase en el service worker
- Auth: `firebase/auth/web-extension` con persistencia IndexedDB.
- Firestore: `firebase/firestore/lite` (REST sobre `fetch`). Sin caché offline: una escritura sin red falla rápido y la cola persistente reintenta (con el SDK completo quedaría pendiente en memoria y se perdería al dormirse el SW).
- Functions: `firebase/functions` (callables sobre `fetch`).
- Storage: el SDK modular sube con `XMLHttpRequest`, que no existe en service workers. `uploadToStorage()` (firebase.ts) sube con `fetch` al endpoint REST de Storage con el ID token; las reglas aplican igual. Lo usarán las capturas (Tarea 5). No hace falta documento offscreen.
- La prueba `smoke` verifica que en el SW `window`, `document` y `XMLHttpRequest` son `undefined` y que todo arranca igual.

## Mensajes

| De → a | Mensaje | Respuesta |
|---|---|---|
| content → SW | `{ type: 'hello' }` | — |
| content → SW | `{ type: 'activity', t }` (máx. 1/s) | — |
| popup → SW | `status`, `session.start`, `session.stop`, `auth.devSignIn {email}` (solo dev), `auth.signIn` (Tarea 5), `auth.signOut`, `auth.refreshProfile`, `sync.now` | `{ ok: true, status }` o `{ ok: false, error, reason?, status? }` |

El SW distingue páginas de la extensión (URL `chrome-extension://<id>/…`, aunque estén abiertas en una pestaña) de content scripts; un content script no puede usar la API del popup.
