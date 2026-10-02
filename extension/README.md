# Extensión de Chrome (MV3)

Mide la jornada del colaborador (spec `docs/specs/2026-09-29-time-tracking-extension.md` §3). Solo mide con la jornada iniciada y con sesión iniciada.

## Comandos (desde la raíz: `npm run <script> -w extension`)

| Script | Qué hace |
|---|---|
| `build` | Build **prod** → `extension/dist` (usa `.env.production`) |
| `build:dev` | Build **dev** → `extension/dist-dev` (emuladores en 127.0.0.1) |
| `build:qa` | Build **QA** → `extension/dist-qa`: el mismo bundle prod + la `key` del ítem de la tienda (mismo ID). Ver [QA sin la tienda](#qa-sin-la-tienda) |
| `dev` | Build dev en modo watch |
| `typecheck` / `test` | TypeScript estricto / Vitest (node, mocks de `chrome.*`) |
| `test:emulator` | `uploadToStorage()` contra los emuladores reales de Auth/Firestore/Storage y `storage.rules` (lo corre `npm run test:emulator` en la raíz) |
| `smoke` | Carga `dist-dev` en Chromium (Playwright) y verifica que el service worker arranca y responde al popup |
| `icons` | Regenera los PNG de `icons/` (reloj azul y variante verde "en jornada"); están versionados |

Prueba de extremo a extremo contra emuladores (auth, firestore, functions, storage): `npm run e2e:extension` en la raíz. Login dev → `joinOrg` → se abre sola la página del aviso → aceptar (verifica `consentVersion` en `users/{uid}`) → iniciar jornada → el "admin" activa capturas difuminadas en `config/org` → `debug.forcePulse` + `debug.forceScreenshot` → verifica el JPEG en Storage (tipo, tamaño < 1 MB, realmente difuminado) y el doc `screenshots` con los 7 campos → una segunda captura del mismo bloque es `duplicate` → cerrar jornada → cola vacía, `sessions`/`activity` en Firestore → el admin guarda un `config/schedule` que excluye la hora actual → jornada: el popup dice "Fuera de horario: no se mide", la captura forzada es `paused` y la sesión queda registrada sin `activity` medida → horario que incluye la hora actual → el popup dice "En horario hasta 23:59" y la jornada suma `trackedSeconds`.

Los builds prod y QA fallan si su bundle contiene restos dev (login dev, mensajes `debug.*`, `127.0.0.1`…): ver `devLeftovers()` en `scripts/build.ts`. El build prod además falla si `dist/manifest.json` trae `key` (Chrome Web Store lo rechaza). `node scripts/build.ts --mode production|development|qa --out-dir <carpeta>` genera en otra carpeta (útil si `dist` está bloqueada por otro proceso). Como esa carpeta se borra antes de compilar, dentro del repo solo se acepta `extension/dist*` (p. ej. `dist-prueba`), y fuera del repo una carpeta nueva, vacía o con un build anterior de la extensión; nunca `extension/` ni una carpeta que la contenga.

`smoke` necesita el Chromium de Playwright (`npx playwright install chromium`), uno ya descargado en `ms-playwright/chromium-*` o `SMOKE_CHROMIUM=<ruta a chrome>`. Google Chrome de marca ignora `--load-extension` desde la v137.

## Cargar en Chrome

`chrome://extensions` → Modo desarrollador → **Cargar descomprimida** → `extension/dist-dev` (o `dist`).

- El build dev lleva `key` fija en el manifest (`build/manifest.ts`), así que su ID es siempre **`klmbbjhphdmmicdbbgkofkpgapcinbmd`**. La clave privada se descartó a propósito: una extensión descomprimida solo necesita la pública, y el ID de producción lo asigna Chrome Web Store (el manifest prod no lleva `key`).
- El build QA (`dist-qa`) lleva la clave pública del ítem de la tienda: su ID es **`egaklokkbnbnccnjicaahaifnkaeobfj`**, el mismo que el publicado. Ver abajo.
- Para el login dev: `firebase emulators:start --only auth,firestore,functions,storage --project demo-timetracking` (tras `npm run build:functions`). Con el correo de `BOOTSTRAP_ADMINS` (`functions/.env.demo-timetracking`) o uno invitado.

## Configuración

- `.env.development`: valores del proyecto demo de emuladores; no hay que tocarlo.
- `.env.production`: configuración web del proyecto Firebase real, con placeholders `REEMPLAZAR_...` (no son secretos). Puedes dejar los valores reales en `.env.production.local` (no se versiona). Mientras queden placeholders el build avisa. `VITE_OAUTH_CLIENT_ID` agrega `oauth2` (scopes `openid email profile`) al manifest: sin él, "Iniciar sesión con Google" muestra que falta configurarlo. `VITE_ALLOWED_DOMAIN` (opcional) es la lista de dominios separados por coma que muestran los mensajes (por defecto `impulseai.cl,compratuparcela.cl`); quien decide qué cuentas entran es el servidor (`config/org.allowedDomains` o `ALLOWED_DOMAIN` de functions). `VITE_GOOGLE_WEB_CLIENT_ID` es el client ID del **cliente web** del proveedor Google de Firebase y habilita el login fuera de Chrome ([Otros navegadores](#otros-navegadores-chromium-021)); sin él el build prod avisa y el build QA falla.

### Login con Google en producción (checklist)

1. **Firebase Auth → Sign-in method → Google: habilitado.**
2. **Pantalla de consentimiento OAuth** del proyecto de Google Cloud (el mismo proyecto de Firebase): tipo **Externo** y **publicada en producción** (hay usuarios de dos organizaciones de Google Workspace, `@impulseai.cl` y `@compratuparcela.cl`; *Interno* solo admite cuentas de la organización dueña del proyecto). Con solo estos scopes básicos normalmente no hace falta la verificación de Google (ver el README principal, paso 2); scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
3. **Cliente OAuth de tipo "Extensión de Chrome"** (Google Cloud → APIs y servicios → Credenciales) con el **ID del ítem de la Chrome Web Store**. Créalo **en el mismo proyecto de Google Cloud que Firebase**: así Firebase acepta el access token sin más. Si lo creas en otro proyecto, agrégalo en Firebase Auth → Google → *Safelist client IDs from external projects*; si no, `signInWithCredential` falla con `auth/invalid-credential` (la extensión lo muestra como "Google rechazó el acceso").
4. Pon ese client ID en `VITE_OAUTH_CLIENT_ID` y haz `npm run build`.
5. Para Edge, Brave, Opera, Vivaldi y Arc: en el **cliente web** del proveedor Google (Google Cloud → Credenciales → *Web client (auto created by Google Service)*, el mismo que aparece en Firebase Auth → Google → *Configuración del SDK web*) agrega en **URI de redireccionamiento autorizados** `https://egaklokkbnbnccnjicaahaifnkaeobfj.chromiumapp.org/` (ya hecho para el ID de la tienda), y pon su client ID en `VITE_GOOGLE_WEB_CLIENT_ID` de `.env.production.local`. Ver [Otros navegadores](#otros-navegadores-chromium-021).

Notas:
- El flujo es `chrome.identity.getAuthToken` (access token, no ID token) → `GoogleAuthProvider.credential(null, accessToken)` → `signInWithCredential` de `firebase/auth/web-extension`. Firebase obtiene el perfil con ese token; con el scope `email` el usuario queda con `emailVerified: true` y el ID token de Firebase trae `email_verified: true` (lo exige `joinOrg`). Sin el scope `email` Firebase no recibe el correo y `joinOrg` rechaza con `no-email`.
- `getAuthToken` usa **siempre la cuenta principal del perfil de Chrome** (no hay selector de cuenta). El colaborador debe usar un perfil de Chrome con su cuenta de la empresa; con una cuenta personal verá "Esta cuenta no es de la empresa". Si el perfil no tiene cuenta (o `getAuthToken` falla por otro motivo que no sea una cancelación, p. ej. un paquete sin `oauth2`), desde la 0.2.1 se abre la ventana de Google para elegir la cuenta ([Otros navegadores](#otros-navegadores-chromium-021)); sin `VITE_GOOGLE_WEB_CLIENT_ID`, la extensión le pide iniciar sesión en Chrome.
- El client ID está atado al ID de la extensión: una copia descomprimida de `dist` tiene otro ID y el login falla. Para probar el build prod sin esperar a la tienda usa el build QA ([QA sin la tienda](#qa-sin-la-tienda)), que tiene el mismo ID que el ítem publicado. Lo mismo vale para la redirect URI del cliente web (`https://<ID>.chromiumapp.org/`).

## Otros navegadores Chromium (0.2.1)

`chrome.identity.getAuthToken` solo funciona en Google Chrome. Desde la 0.2.1, en los demás navegadores Chromium el login usa `chrome.identity.launchWebAuthFlow` ([spec](../docs/specs/2026-10-01-login-otros-navegadores.md)).

| Navegador | Instalar desde Chrome Web Store | Login |
|---|---|---|
| Google Chrome | Directo | `getAuthToken` (cuenta del perfil de Chrome) |
| Microsoft Edge | En la ficha de la tienda, pulsa **"Permitir extensiones de otras tiendas"** → *Permitir* y luego **Agregar a Chrome** (o activa *edge://extensions → Permitir extensiones de otras tiendas*) | Ventana de Google para elegir la cuenta |
| Brave | Directo | Ventana de Google para elegir la cuenta |
| Vivaldi | Directo | Ventana de Google para elegir la cuenta |
| Opera | Primero instala el complemento **"Install Chrome Extensions"** de addons.opera.com; después **Agregar a Opera** en la ficha | Ventana de Google para elegir la cuenta |
| Arc | Directo | Ventana de Google para elegir la cuenta |
| Firefox, Safari | No compatibles | — |

Cómo funciona:
- **Elección del método**: si `getAuthToken` existe y funciona, se usa (Chrome, sin cambios). Si no existe, o falla por **cualquier motivo que no sea una cancelación del usuario**, se usa `launchWebAuthFlow`: "no soportado" (Edge: *"This API is not supported on Microsoft Edge"* o, en versiones antiguas, *"OAuth2 request failed: Connection failed (-2)"*; Brave: *"The user turned off browser signin"*; cualquier *"not supported / is not available"*), perfil sin cuenta Google (*"The user is not signed in"*: Opera, Vivaldi o un perfil de Chrome sin cuenta; la persona elige la cuenta en la ventana de Google), configuración OAuth (*"Invalid OAuth2 Client ID"*, p. ej. un paquete sin `manifest.oauth2`) y errores desconocidos. Los errores después de obtener el token (Firebase, red) no cambian de método. Si el usuario **cancela** en cualquiera de los dos, no se prueba el otro. Si el método alternativo también falla, el mensaje termina con el texto técnico original, p. ej. *"Google no permitió iniciar sesión (invalid_client) (getAuthToken: Invalid OAuth2 Client ID.)."*. Sin `VITE_GOOGLE_WEB_CLIENT_ID`, en Google Chrome (marca de `navigator.userAgentData`) se muestra el error propio de Chrome con ese texto, y en los demás navegadores "Este navegador no es compatible todavía: usa Google Chrome".
- **Flujo alternativo** (OpenID Connect implícito): `https://accounts.google.com/o/oauth2/v2/auth?client_id=<VITE_GOOGLE_WEB_CLIENT_ID>&response_type=id_token&redirect_uri=<chrome.identity.getRedirectURL()>&scope=openid%20email%20profile&nonce=<aleatorio>&prompt=select_account`, más `hd=<dominio>` si hay **un solo** dominio permitido (con dos no se envía; `joinOrg` sigue rechazando otras cuentas). Del fragmento de la URL de vuelta se lee el `id_token`; `error=access_denied` o cerrar la ventana es una cancelación; otro `error` o la falta de `id_token` dan un mensaje claro.
- **`nonce`**: 128 bits aleatorios por intento; se compara con el del `id_token` decodificando su payload **sin verificar la firma**: la verifica Firebase Auth en `signInWithCredential` (firma de Google, emisor, audiencia = cliente del proveedor, vencimiento). Luego `GoogleAuthProvider.credential(idToken)` → `signInWithCredential` → `joinOrg`, igual que en Chrome.
- **Sesión y cierre de sesión**: Firebase Auth (IndexedDB) renueva solo su sesión; el `id_token` de Google solo sirve para entrar y no se guarda. Al cerrar sesión se cierra la de Firebase; `removeCachedAuthToken` solo se llama donde existe `getAuthToken`.
- **Sin `VITE_GOOGLE_WEB_CLIENT_ID`** (o sin `launchWebAuthFlow`), los navegadores distintos de Chrome muestran "Este navegador no es compatible todavía: usa Google Chrome." Chrome sigue funcionando con `getAuthToken`.
- El popup tiene el mismo botón; fuera de Chrome agrega "Se abrirá una ventana de Google: elige tu cuenta de la empresa." Al abrirse la ventana de Google el popup se cierra; el login termina en el service worker y al reabrir el popup ya aparece la sesión (o, si se canceló, el botón de nuevo).
- **Configuración en Google Cloud**: el cliente web del proveedor Google debe tener la redirect URI `https://egaklokkbnbnccnjicaahaifnkaeobfj.chromiumapp.org/` (ID de la tienda; ya agregada). Una copia descomprimida con otro ID necesita su propia `https://<ID>.chromiumapp.org/`. Como es el mismo cliente del proveedor de Firebase, Firebase acepta el `id_token` sin más configuración.

## QA sin la tienda

Para probar contra **producción** una versión que la tienda todavía está revisando (o antes de subirla):

1. `npm run build:qa -w extension` (o `npm run build:extension:qa` en la raíz) → `extension/dist-qa` (ignorada por git). Usa exactamente el mismo código y configuración que `npm run build` (`.env.production` + `.env.production.local`, incluido `VITE_OAUTH_CLIENT_ID` → `oauth2`) y pasa los mismos chequeos de restos dev. La única diferencia es que el manifest lleva `"key"` con la clave pública del ítem de la tienda (`build/store-key.ts`; no es secreta). El build imprime el ID y falla si no es `egaklokkbnbnccnjicaahaifnkaeobfj`.
2. A diferencia de `build`, que solo avisa, el build QA **falla** si falta `VITE_OAUTH_CLIENT_ID`, `VITE_GOOGLE_WEB_CLIENT_ID` o algún valor real de Firebase: un QA sin login no sirve.
3. `chrome://extensions` → **Modo de desarrollador** → **Cargar descomprimida** → `extension/dist-qa`.

Qué tener en cuenta:
- Como el ID coincide con el de la tienda, el cliente OAuth de la extensión lo acepta y "Iniciar sesión con Google" funciona.
- **Los datos van a producción** (Firestore, Storage y Functions reales): las jornadas, la actividad y las capturas de QA las ve el portal real. Usa una cuenta de prueba o avisa al equipo.
- No puedes tener instaladas a la vez la versión de la tienda y la de QA: tienen el mismo ID y Chrome usa solo una. Desinstala (o desactiva) una antes de cargar la otra; al volver a la de la tienda, quita la descomprimida.
- La política de Google Workspace puede bloquear las extensiones descomprimidas (o el Modo de desarrollador) en perfiles administrados; en ese caso usa un perfil donde esté permitido.
- **Nunca** subas `dist-qa` a la tienda: el paquete para Chrome Web Store es siempre `dist` (`npm run build`), que no lleva `key`.

## Permisos (justificación para Chrome Web Store)

| Permiso | Para qué |
|---|---|
| `tabs` | Saber cuál es la pestaña activa (sitio y página medidos) y detectar reuniones web (dirección de la pestaña y si está sonando). |
| `idle` | Saber si hay uso del computador (activo, inactivo, pantalla bloqueada) cuando la página no tiene content script. |
| `alarms` | Pulso de 30 s de la jornada y alarma exacta en las transiciones del horario (entrada, colación, salida) y los recordatorios. |
| `storage` | Estado local: jornada, bloques, cola de envíos, horario en caché. |
| `unlimitedStorage` | Cola de capturas sin conexión (hasta 20 JPEG superan los 10 MB por defecto). |
| `identity` | Iniciar sesión con la cuenta Google de la empresa (`chrome.identity.getAuthToken` en Chrome; `launchWebAuthFlow` en Edge, Brave, Opera, Vivaldi y Arc). |
| `scripting` | Inyectar el content script en las pestañas ya abiertas al instalar o actualizar. |
| `notifications` | Recordatorios de inicio, colación y cierre del horario (0.2.0; colación desde la 0.2.2), a la hora exacta: "¿Iniciar jornada?" a la entrada, avisos al inicio y al término de la colación ("¿Retomar la jornada?" si se cerró para almorzar) y "¿Cerrar jornada?" a la salida, con un botón que lo hace. |
| `<all_urls>` | Content script de actividad (solo "hubo input") y captura de la pestaña visible si el admin la activa. |

## Horario laboral (0.2.0)

Spec `docs/specs/2026-09-30-horarios.md`. Todo es local salvo dos lecturas; la lógica pura está en `src/background/schedule.ts` sobre `packages/shared/src/schedule.ts`.

- **Lectura y caché**: `config/schedule` y `schedules/{uid}` (Firestore lite `getDoc`) en los mismos momentos que `config/org` (al iniciar jornada, al despertar si tiene > 1 min, cada 5 min desde el pulso y al validar la cuenta), guardados en `tt.meta.schedule`. Documentos inválidos se ignoran. `schedules/{uid}` puede no existir, y si las reglas nuevas aún no están desplegadas su lectura rechazada cuenta como "sin excepción". Sin conexión se sigue usando la caché.
- **Sin horario** (no hay `config/schedule` válido ni excepción): todo igual que la 0.1.x, sin alarma ni nada nuevo en el popup. Con solo la excepción, vale su semana, sin feriados, tolerancia por defecto y sin recordatorios.
- **Pausa de la medición**: con la jornada abierta, si `classifyInstant(ahora)` no es `'work'` (colación, fuera de horario, día libre, feriado) el acumulador queda en pausa (`SlotAccumulator.setPaused`): no mide actividad, sitios, reunión ni `trackedSeconds`, y no se toman capturas (`'paused'`). La sesión y su latido siguen: el inicio y el cierre se registran siempre. Cada evento y cada pulso aplican primero la pausa en cada límite del horario desde el último evento (`Tracker.syncPause`), así la atribución es por segundo aunque el pulso llegue tarde; además una alarma `tt-schedule` (`when` exacto) despierta en la próxima transición, recordatorio o medianoche. Un acumulador guardado por la 0.1.x (sin `paused`) se lee como "no pausado".
- **Popup**: tarjeta con "En horario hasta 18:30", "Colación hasta 14:00", "Fuera de horario: no se mide", "Hoy es feriado" o "Día libre", y el horario de hoy.
- **Recordatorios de inicio, colación y cierre** (solo con `remindersEnabled`, cuenta validada y día laboral no feriado), **a la hora exacta** del horario (0.2.2; antes, entrada/salida + tolerancia; la tolerancia queda solo para el cumplimiento):
  - Entrada sin jornada abierta: "Tu jornada empieza a las 09:00. ¿Iniciar jornada?" con botón **Iniciar jornada** (si falta aceptar el aviso vigente, abre el aviso).
  - Inicio de colación con la jornada abierta: "Es hora de tu colación (14:00–15:00). Durante la colación no se mide." (sin botón).
  - Término de colación con la jornada abierta: "Terminó tu colación. Se vuelve a medir desde las 15:00." (sin botón); sin jornada abierta: "Terminó tu colación. ¿Retomar la jornada?" con botón **Iniciar jornada** (`App.startWorkDay`, igual que la entrada).
  - Salida con la jornada abierta: "Tu horario terminó a las 18:30. ¿Cerrar jornada?" con botón **Cerrar jornada**.

  Los de colación usan `requireInteraction: false` (desaparecen solos); entrada y salida, `true`. Un día sin colación no tiene avisos de colación. Cada evento (`start`, `lunchStart`, `lunchEnd`, `end`) se evalúa una sola vez por día (`tt.meta.reminders`; el registro de la 0.2.1, con solo `start`/`end`, se lee igual), la primera vez desde su hora exacta (pulso, alarma `tt-schedule` o despertar); si en ese momento no corresponde (estado de la jornada) o ya pasó el siguiente evento del día (p. ej. un despertar tardío después de la salida no muestra los de colación ni el de entrada), se da por atendido sin avisar. El botón de un aviso de otro día solo abre el popup. Clic en la notificación abre el popup (o `popup.html` en una pestaña).
- **Aviso**: `CONSENT_VERSION` `2026-09-30.2` agrega que fuera del horario y en la colación no se mide; hay que aceptarlo de nuevo para iniciar jornada. La detección de reuniones sigue activa con el aviso anterior (`2026-09-30`) para una jornada ya abierta.

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
    schedule.ts          horario efectivo en caché, pausa, estado del popup, recordatorios, próxima alarma
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
- Prod: `chrome.identity.getAuthToken({ interactive: true })` → `GoogleAuthProvider.credential(null, token)` → `signInWithCredential` → `joinOrg`. Si Firebase rechaza el token (revocado/caducado en la caché de Chrome) se quita con `removeCachedAuthToken` y se reintenta una vez. Cancelar el diálogo de Google muestra un aviso, no un error. Los rechazos de `joinOrg` (`details.reason`) se muestran con mensajes claros: sin invitación / revocada ("Pide a tu administrador que te invite"), otro dominio ("Usa tu cuenta @impulseai.cl o @compratuparcela.cl", con la lista configurada), desactivada, correo no verificado. Fuera de Chrome (o si `getAuthToken` no está soportado): `launchWebAuthFlow` con `id_token` y `nonce`, ver [Otros navegadores](#otros-navegadores-chromium-021).
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
