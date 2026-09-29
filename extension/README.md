# Extensión de Chrome (MV3)

Mide la jornada del colaborador (spec `docs/specs/2026-09-29-time-tracking-extension.md` §3). Solo mide con la jornada iniciada y con sesión iniciada.

## Comandos (desde la raíz: `npm run <script> -w extension`)

| Script | Qué hace |
|---|---|
| `build` | Build **prod** → `extension/dist` (usa `.env.production`) |
| `build:dev` | Build **dev** → `extension/dist-dev` (emuladores en 127.0.0.1) |
| `dev` | Build dev en modo watch |
| `typecheck` / `test` | TypeScript estricto / Vitest (node, mocks de `chrome.*`) |
| `test:emulator` | `uploadToStorage()` contra los emuladores reales de Auth/Firestore/Storage y `storage.rules` (lo corre `npm run test:emulator` en la raíz) |
| `smoke` | Carga `dist-dev` en Chromium (Playwright) y verifica que el service worker arranca y responde al popup |
| `icons` | Regenera los PNG de `icons/` (reloj azul y variante verde "en jornada"); están versionados |

Prueba de extremo a extremo contra emuladores (auth, firestore, functions, storage): `npm run e2e:extension` en la raíz. Login dev → `joinOrg` → se abre sola la página del aviso → aceptar (verifica `consentVersion` en `users/{uid}`) → iniciar jornada → el "admin" activa capturas difuminadas en `config/org` → `debug.forcePulse` + `debug.forceScreenshot` → verifica el JPEG en Storage (tipo, tamaño < 1 MB, realmente difuminado) y el doc `screenshots` con los 7 campos → una segunda captura del mismo bloque es `duplicate` → cerrar jornada → cola vacía, `sessions`/`activity` en Firestore.

El build prod falla si su bundle contiene restos dev (login dev, mensajes `debug.*`, `127.0.0.1`…): ver `devLeftovers()` en `scripts/build.ts`.

`smoke` necesita el Chromium de Playwright (`npx playwright install chromium`), uno ya descargado en `ms-playwright/chromium-*` o `SMOKE_CHROMIUM=<ruta a chrome>`. Google Chrome de marca ignora `--load-extension` desde la v137.

## Cargar en Chrome

`chrome://extensions` → Modo desarrollador → **Cargar descomprimida** → `extension/dist-dev` (o `dist`).

- El build dev lleva `key` fija en el manifest (`build/manifest.ts`), así que su ID es siempre **`klmbbjhphdmmicdbbgkofkpgapcinbmd`**. La clave privada se descartó a propósito: una extensión descomprimida solo necesita la pública, y el ID de producción lo asigna Chrome Web Store (el manifest prod no lleva `key`).
- Para el login dev: `firebase emulators:start --only auth,firestore,functions,storage --project demo-timetracking` (tras `npm run build:functions`). Con el correo de `BOOTSTRAP_ADMINS` (`functions/.env.demo-timetracking`) o uno invitado.

## Configuración

- `.env.development`: valores del proyecto demo de emuladores; no hay que tocarlo.
- `.env.production`: configuración web del proyecto Firebase real, con placeholders `REEMPLAZAR_...` (no son secretos). Puedes dejar los valores reales en `.env.production.local` (no se versiona). Mientras queden placeholders el build avisa. `VITE_OAUTH_CLIENT_ID` agrega `oauth2` (scopes `openid email profile`) al manifest: sin él, "Iniciar sesión con Google" muestra que falta configurarlo. `VITE_ALLOWED_DOMAIN` (opcional) es la lista de dominios separados por coma que muestran los mensajes (por defecto `impulseai.cl,compratuparcela.cl`); quien decide qué cuentas entran es el servidor (`config/org.allowedDomains` o `ALLOWED_DOMAIN` de functions).

### Login con Google en producción (checklist)

1. **Firebase Auth → Sign-in method → Google: habilitado.**
2. **Pantalla de consentimiento OAuth** del proyecto de Google Cloud (el mismo proyecto de Firebase): tipo **Externo** y **publicada en producción** (hay usuarios de dos organizaciones de Google Workspace, `@impulseai.cl` y `@compratuparcela.cl`; *Interno* solo admite cuentas de la organización dueña del proyecto). Con solo estos scopes básicos normalmente no hace falta la verificación de Google (ver el README principal, paso 2); scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
3. **Cliente OAuth de tipo "Extensión de Chrome"** (Google Cloud → APIs y servicios → Credenciales) con el **ID del ítem de la Chrome Web Store**. Créalo **en el mismo proyecto de Google Cloud que Firebase**: así Firebase acepta el access token sin más. Si lo creas en otro proyecto, agrégalo en Firebase Auth → Google → *Safelist client IDs from external projects*; si no, `signInWithCredential` falla con `auth/invalid-credential` (la extensión lo muestra como "Google rechazó el acceso").
4. Pon ese client ID en `VITE_OAUTH_CLIENT_ID` y haz `npm run build`.

Notas:
- El flujo es `chrome.identity.getAuthToken` (access token, no ID token) → `GoogleAuthProvider.credential(null, accessToken)` → `signInWithCredential` de `firebase/auth/web-extension`. Firebase obtiene el perfil con ese token; con el scope `email` el usuario queda con `emailVerified: true` y el ID token de Firebase trae `email_verified: true` (lo exige `joinOrg`). Sin el scope `email` Firebase no recibe el correo y `joinOrg` rechaza con `no-email`.
- `getAuthToken` usa **siempre la cuenta principal del perfil de Chrome** (no hay selector de cuenta). El colaborador debe usar un perfil de Chrome con su cuenta de la empresa; con una cuenta personal verá "Esta cuenta no es de la empresa". Si el perfil no tiene cuenta, la extensión le pide iniciar sesión en Chrome.
- El client ID está atado al ID de la extensión: una copia descomprimida de `dist` tiene otro ID y el login falla. Para probar el build prod sin publicar, crea un segundo cliente OAuth con el ID de esa copia (o publícala como *no listada*; *privada* no sirve porque se limita a un solo dominio).

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
    auth.ts              AuthService: Google (chrome.identity) / login dev con emulador, joinOrg + mensajes de rechazo
    remote.ts            interfaz Remote (sync Backend + config/org, consentimiento, capturas)
    daily.ts             resumen local de hoy (horas y % actividad para el popup)
    screenshots.ts       plan aleatorio por bloque, captura, cola persistente y subida idempotente
    image.ts             OffscreenCanvas: redimensionar, difuminar, JPEG < 1 MB
  content/activity.ts    content script (IIFE): solo “hubo input” + timestamp
  popup/                 popup (estados: sin sesión / sin invitación / sin aviso / listo)
  consent/               página del aviso de medición (consent.html)
  ui/                    CSS común (claro/oscuro) y helpers de DOM
  messages.ts            tipos de mensajes entre partes
build/                   manifest y configs de Vite (3 builds: background ES, content IIFE, páginas)
scripts/                 build.ts, smoke.ts, icons.ts (Node ≥ 22.18, TypeScript sin compilar)
icons/                   PNG 16/32/48/128 (normal y "on")
```

### Login y aviso
- Prod: `chrome.identity.getAuthToken({ interactive: true })` → `GoogleAuthProvider.credential(null, token)` → `signInWithCredential` → `joinOrg`. Si Firebase rechaza el token (revocado/caducado en la caché de Chrome) se quita con `removeCachedAuthToken` y se reintenta una vez. Cancelar el diálogo de Google muestra un aviso, no un error. Los rechazos de `joinOrg` (`details.reason`) se muestran con mensajes claros: sin invitación / revocada ("Pide a tu administrador que te invite"), otro dominio ("Usa tu cuenta @impulseai.cl o @compratuparcela.cl", con la lista configurada), desactivada, correo no verificado.
- Cerrar sesión (solo sin jornada abierta) también quita el token de la caché de Chrome.
- Si Firebase termina la sesión con la jornada abierta (`onAuthStateChanged` → null, o al despertar con otro usuario), la jornada se cierra localmente y se encola el cierre (sale si ese usuario vuelve a entrar).
- Aviso (`consent.html`): se abre solo tras iniciar sesión si falta aceptar `CONSENT_VERSION`; "Aceptar" escribe `consentAcceptedAt` + `consentVersion` en `users/{uid}`. `session.start` lo exige.

### Capturas
- Por bloque de 10 min: instante aleatorio persistido (`tt.shotPlan`), un solo intento. En el pulso, si ya pasó el instante y hay jornada + `screenshotsEnabled` + ventana enfocada con pestaña http/https → `captureVisibleTab` → `image.ts` (≤ 1280 px, blur si `blurScreenshots`, JPEG < 1 MB). Fuera de Chrome o en páginas no http no se captura ni se registra nada.
- Cola persistente (máx. 20, se descartan las más antiguas; permiso `unlimitedStorage`): `tt.shots` guarda solo el índice (metadatos, intentos) y cada JPEG va en base64 en su propia clave `tt.shot.<id>`, que se escribe una vez, se lee solo al subir esa captura y se borra al terminar. Así despertar el SW o actualizar la cola no lee ni reescribe hasta ~20 MB de imágenes.
- Con difuminado activo, la imagen nítida solo existe en memoria durante el procesamiento; si por algún motivo no quedó difuminada, se descarta. Si la jornada se cerró mientras se capturaba, la captura no se encola. Id `{uid}_{slotStart}`: si el archivo ya existe (Storage no sobrescribe) se da por subido tras un GET de metadatos, y luego `setDoc(screenshots/{id})` con los 7 campos de las reglas.
- `config/org` (Firestore lite, cacheado en `tt.meta.org`): al iniciar jornada, al despertar (si tiene > 1 min) y cada 5 min desde el pulso.

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
| popup → SW | `status`, `session.start`, `session.stop`, `auth.signIn`, `auth.signOut`, `auth.refreshProfile`, `sync.now` | `{ ok: true, status }` o `{ ok: false, error, reason?, status? }` |
| consent → SW | `consent.accept {version}` | ídem |
| solo build dev | `auth.devSignIn {email}`, `debug.forcePulse`, `debug.forceScreenshot` (pulso inmediato / instante de captura = ahora; responde `debug`: `captured`, `duplicate`, `no-target`…) | ídem |

El SW distingue páginas de la extensión (URL `chrome-extension://<id>/…`, aunque estén abiertas en una pestaña) de content scripts; un content script no puede usar la API del popup.
