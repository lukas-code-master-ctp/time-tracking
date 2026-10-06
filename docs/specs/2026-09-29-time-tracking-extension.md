# Spec — Registro de jornada y actividad (extensión Chrome + portal admin)

Fecha: 2026-09-29 · Estado: en construcción (MVP, uso interno ~30 personas)

> **Actualización:** el dominio permitido único pasó a ser una **lista de dominios** (`allowedDomains`, hoy `impulseai.cl` y `compratuparcela.cl`) y el admin inicial es `lukas@impulseai.cl`. Ver [spec multi-dominio](2026-09-29-multi-dominio.md). Las secciones afectadas lo indican.

> **Actualización (horarios, 2026-09-30, extensión 0.2.0):** la admin puede configurar un **horario laboral** general con colación, feriados y excepción por persona. Fuera del horario y en la colación la extensión **pausa la medición** (sin actividad, sitios, reuniones ni capturas), pero el inicio y el cierre de la jornada se registran siempre; el portal muestra el cumplimiento. Ver [spec de horarios](2026-09-30-horarios.md). Las secciones afectadas lo indican.

## 1. Objetivo

Versión simple tipo Hubstaff para uso interno:

1. El **admin** invita colaboradores por correo desde un **portal web**.
2. El **colaborador** instala una **extensión de Chrome**, inicia sesión con su cuenta Google Workspace, **inicia y cierra jornada**.
3. Mientras la jornada está abierta la extensión mide:
   - **Nivel de actividad**: % del tiempo con uso de teclado/mouse.
   - **Sitios web**: tiempo por dominio/URL en Chrome (y tiempo "fuera de Chrome").
   - **Capturas de pantalla** opcionales de la pestaña visible, con difuminado opcional.
4. El admin ve todo en la **reportería del portal**.

> **Actualización (horarios):** con horario configurado, la medición del punto 3 ocurre solo dentro del horario y fuera de la colación; la jornada (inicio/cierre) se registra siempre. Ver [spec de horarios](2026-09-30-horarios.md).

### Fuera de alcance (MVP)
- Apps de escritorio (Word/Excel instalados, WhatsApp desktop, etc.): la extensión solo sabe que el usuario estuvo "fuera de Chrome".
- Captura de pantalla completa (requiere compartir pantalla); solo pestaña visible.
- Proyectos/tareas, presupuestos, pagos, facturación, multiempresa.
- Otros navegadores (Edge, Firefox).

## 2. Decisiones

| Tema | Decisión | Motivo |
|---|---|---|
| Backend | **Firebase** (Auth, Firestore, Cloud Storage, Cloud Functions, Hosting) en Google Cloud | Pedido del usuario; encaja con Google Workspace |
| Login | Google (Workspace) vía `chrome.identity.getAuthToken` en extensión y `signInWithPopup` en portal. Solo dominios permitidos (`ALLOWED_DOMAIN`, lista separada por comas; ver [spec multi-dominio](2026-09-29-multi-dominio.md)) | Ya usan Workspace; sin contraseñas |
| Invitación | Admin ingresa correo → doc `invitations/{email}` → Cloud Function envía correo (SMTP vía nodemailer, credenciales en Secret Manager). En emulador, el correo se registra en log. El portal además muestra un enlace copiable | "Admin manda la invitación" sin depender de un proveedor externo |
| Alta | Al primer login, callable `joinOrg` verifica invitación (o que el correo esté en `BOOTSTRAP_ADMINS`) y crea `users/{uid}` con su rol. El cliente nunca escribe su rol | Seguridad |
| Distribución extensión | Chrome Web Store "no listada" + instalación forzada por política de Google Workspace (en la consola de **cada** organización; ver [spec multi-dominio](2026-09-29-multi-dominio.md)) | No se puede desinstalar; se actualiza sola |
| Capturas | `chrome.tabs.captureVisibleTab`, 1 por bloque de 10 min en instante aleatorio, reducida a ≤1280 px ancho, JPEG, difuminado opcional hecho **en el dispositivo antes de subir** | "Todo vive en la extensión"; privacidad |
| Retención | Capturas se borran a los **90 días** (configurable en portal). Horas y actividad se conservan | Costo acotado |
| Stack | TypeScript. Extensión MV3 empaquetada con Vite. Portal React + Vite. Functions Node 22. Tests con Vitest + Emulator Suite | Un solo lenguaje |
| Monorepo | npm workspaces: `packages/shared`, `extension`, `portal`, `functions` | Tipos y lógica compartidos |

## 3. Cómo se mide

Todo se agrupa en **bloques de 10 minutos** (`slot`, alineados al reloj: 09:00, 09:10…).

> **Actualización (horarios):** fuera del horario y en la colación el acumulador está en **pausa** (`SlotAccumulator.setPaused`): el reloj avanza pero no se atribuye nada a `trackedSeconds`, actividad, reunión, fuera de Chrome ni sitios; la pausa se aplica en el instante exacto de cada límite del horario. Ver [spec de horarios](2026-09-30-horarios.md).

### 3.1 Actividad
- **Dentro de Chrome**: content script en todas las páginas escucha `keydown`, `mousedown`, `mousemove`, `wheel`, `touchstart` (solo el hecho, nunca qué tecla ni contenido) y avisa al service worker como máximo 1 vez por segundo. Se marca ese segundo como activo.
- **Fuera de Chrome o en páginas sin content script** (chrome://, Web Store, PDF): `chrome.idle` con umbral de 15 s. Mientras el estado es `active`, los segundos cuentan como activos; en `idle`/`locked` no.
- `activityPercent = segundosActivos / segundosMedidos` del bloque. Un segundo cuenta una sola vez aunque venga de ambas fuentes.
- **Actualización 2026-09-30 ("En reunión", extensión 0.1.2)**: los segundos sin teclado ni mouse con una reunión web en curso en Chrome (Meet, Zoom, Teams…) se guardan aparte en `meetingSeconds` y no cuentan para el %: `activityPercent = segundosActivos / (segundosMedidos − segundosEnReunión)`; si todo el bloque fue reunión, el % se muestra "—" y no entra en promedios. Las horas de jornada no cambian. Ver [spec "En reunión"](2026-09-30-en-reunion.md).

### 3.2 Sitios
- Se registra la pestaña activa de la ventana enfocada (`tabs.onActivated`, `tabs.onUpdated`, `windows.onFocusChanged`).
- Tiempo acumulado por **dominio** y por **URL sin query ni hash** (se descartan parámetros para no guardar datos sensibles). Top 20 URLs por bloque.
- Si ninguna ventana de Chrome está enfocada → `outsideChromeSeconds`.
- Pestañas de incógnito no se miden (la extensión no está habilitada en incógnito).

### 3.3 Capturas
- Si `screenshotsEnabled` y la ventana de Chrome está enfocada en el instante sorteado → captura. Si no, no se captura.
  - **Decisión (Tarea 5):** "sin captura" **no se registra**: el modelo (§5) no tiene campo para eso y `screenshots` exige un archivo. El portal simplemente no muestra captura para ese bloque.
- Instante: al ver un bloque por primera vez (pulso de 30 s con jornada abierta) se sortea un instante en `[ahora, fin del bloque − 30 s]` y se **persiste** (`chrome.storage.local`), así sobrevive al sueño del service worker. Hay **un solo intento por bloque**: el primer pulso en o después del instante decide (jornada abierta + `screenshotsEnabled` + ventana normal enfocada con pestaña http/https + pantalla no bloqueada). Nunca hay dos capturas del mismo bloque.
  - **Actualización (horarios):** si el instante sorteado cae fuera del horario o en la colación, el intento se consume sin capturar (`'paused'`). Ver [spec de horarios](2026-09-30-horarios.md).
- `chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg' })` → `createImageBitmap` + `OffscreenCanvas` en el service worker: ancho ≤ 1280 px, difuminado (`blurScreenshots`) con `ctx.filter = 'blur(≈ancho/100 px)'` (respaldo si el contexto no soporta `filter`: reducción fuerte + ampliación) antes de subir; JPEG `< 1 MB` bajando la calidad (0,7 → 0,25) y luego el tamaño.
- Subida a `screenshots/{uid}/{fecha}/{id}.jpg` en Storage + doc metadatos, con **id determinista** `{uid}_{slotStart}`. Cola offline persistente (JPEG en base64 en `chrome.storage.local`, permiso `unlimitedStorage`), máx. 20: se descartan las más antiguas. Como las reglas de Storage no permiten sobrescribir, un reintento rechazado cuyo archivo ya existe (GET de metadatos, el dueño puede leer) cuenta como subido; luego se escribe el doc (re-escribir los mismos datos está permitido).

### 3.4 Envío
- El bloque en curso se sube (upsert, id determinista `uid_slotStartMs`, idempotente) cada ~60 s y al cerrarse; el latido de la sesión (`lastHeartbeatAt`) se actualiza en el mismo ciclo. Así el admin ve casi en tiempo real.

### 3.5 Modo desarrollo
- Build `dev` apunta a los emuladores de Firebase y reemplaza `chrome.identity` por un login con correo simulado (credencial Google falsa aceptada por el emulador de Auth). El build `prod` no incluye ese código.

### 3.6 Robustez
- El service worker MV3 puede dormirse: estado en `chrome.storage.local`, `chrome.alarms` cada 30 s como pulso; al despertar reconstruye el estado.
- Sin conexión: los bloques cerrados y capturas quedan en cola local y se suben al volver.
- Si el navegador se cierra o el equipo se suspende (p. ej. se baja la tapa en la colación) con la jornada abierta, al volver la jornada sigue abierta; los minutos sin datos quedan como "sin datos" (no se inventan). Si pasaron más de 5 min sin pulso, la sesión se cierra en el último latido y se abre otra al instante, así el hueco no cuenta como conectado ni choca con el cierre automático del servidor (si ya la cerró, ese cierre se descarta). Si el hueco supera 4 h o cruza la medianoche, la jornada queda cerrada en el último latido con un aviso. Jornada abierta más de 16 h se cierra automáticamente en el último latido.

## 4. Transparencia (Chile)
- Primera vez: pantalla en la extensión que explica qué se mide y qué no; el colaborador debe aceptar (se guarda `consentAcceptedAt` y versión).
- Ícono con insignia "ON" durante la jornada; popup muestra qué se está midiendo (actividad, sitios, capturas sí/no, difuminado sí/no).
- Solo se mide con jornada iniciada.
  - **Actualización (horarios):** y, con horario, solo dentro de él y fuera de la colación; el aviso lo explica (`CONSENT_VERSION` subió a `2026-09-30.2`) y la extensión puede enviar **recordatorios** locales (permiso `notifications`) para iniciar o cerrar la jornada. El inicio y el cierre se guardan siempre (registro de asistencia y horas extra; validar con abogado laboral). Ver [spec de horarios](2026-09-30-horarios.md).
- El colaborador ve sus propias horas del día en el popup.
- Nota: validar con abogado laboral e incorporar al reglamento interno. No es asesoría legal.

## 5. Modelo de datos (Firestore)

```
config/org                 { allowedDomains, screenshotsEnabled, blurScreenshots,
                             screenshotRetentionDays, updatedAt, updatedBy }
invitations/{emailLower}   { email, invitedBy, invitedAt, status: pending|accepted|revoked, acceptedAt? }
users/{uid}                { email, displayName, photoURL, role: admin|member,
                             status: active|disabled, createdAt, consentAcceptedAt?, consentVersion? }
sessions/{sessionId}       { uid, startedAt, endedAt|null, endReason: manual|auto|null, lastHeartbeatAt }
activity/{uid_slotStartMs} { uid, sessionId, slotStart, trackedSeconds, activeSeconds,
                             outsideChromeSeconds, domains: {domain: seconds}, urls: [{url, seconds}] }
screenshots/{id}           { uid, sessionId, takenAt, storagePath, blurred, width, height }
```

> **Actualización (horarios):** colecciones nuevas `config/schedule` `{ week, holidays, toleranceMinutes, remindersEnabled, updatedAt, updatedBy }` (solo un admin activo la escribe o borra; la lee cualquier usuario activo) y `schedules/{uid}` `{ week, updatedAt, updatedBy }` (excepción por persona; solo un admin la escribe o borra; la leen la persona y los admins). `sessions` y `activity` no cambian de forma. Ver [spec de horarios](2026-09-30-horarios.md).

> **Actualización:** `config/org.allowedDomain: string` se reemplazó por `allowedDomains: string[]` (1–10 dominios normalizados, sin duplicados; las reglas exigen los mismos 6 campos). Los docs antiguos con `allowedDomain` se leen como `[allowedDomain]`. Ver [spec multi-dominio](2026-09-29-multi-dominio.md).

Reglas:
- Colaborador: lee `config/org` y su propio `users/{uid}`; crea/actualiza sus `sessions`, `activity`, `screenshots` (con `uid == auth.uid`, sin cambiar `uid`); lee lo suyo.
- Admin (`users/{uid}.role == 'admin'`, status active): lee todo; escribe `config/org`, `invitations`, cambia `role`/`status` de usuarios.
- Nadie escribe su propio `role`/`status`; `users` se crea solo desde Functions.
- Storage: colaborador sube solo a `screenshots/{suUid}/…`, `image/jpeg`, <1 MB; admin lee todo; colaborador lee lo suyo.

## 6. Cloud Functions
- `joinOrg` (callable): exige correo verificado, valida dominio (`config/org.allowedDomains` o `ALLOWED_DOMAIN`, lista; coincidencia exacta con alguno — ver [spec multi-dominio](2026-09-29-multi-dominio.md)) + invitación `pending|accepted` o bootstrap admin; crea `users/{uid}`, marca invitación `accepted`. Idempotente (si ya existe devuelve el perfil; si está `disabled` rechaza). Responde `{ profile }`; errores `HttpsError` en español con `details.reason` (`unauthenticated`, `no-email`, `email-not-verified`, `domain-not-allowed`, `no-invitation`, `invitation-revoked`, `user-disabled`).
- `onInvitationWritten` (trigger Firestore): envía correo con link de instalación cuando la invitación queda `pending` (creada, reinvitada desde otro estado o con `invitedAt` nuevo); si no hay SMTP configurado o corre en emulador, log.
  - **Nota (correo opcional):** el envío es opt-in con `INVITE_EMAIL_ENABLED` en `functions/.env.<proyecto>` (`true`/`false`, por defecto `false`), leído de `process.env` al cargar el módulo (el CLI carga los `.env` antes del análisis del deploy). Si no es `true`, no se declara ningún secreto SMTP (el deploy no los pide) y al crear/reenviar una invitación solo se registra con `logger.info` destinatario y asunto; la función sigue desplegada, así que activarlo es cambiar la variable a `true`, crear los secretos y desplegar. Con `true`, declara `SMTP_HOST/PORT/USER/PASS/FROM` y envía. En el emulador nunca se vinculan secretos ni se envía (log con cuerpo, como antes). El portal no sabe si el correo está activo: sus textos dicen "Invitación creada… Comparte el enlace de instalación" y mencionan el correo solo como condicional.
- `purgeOldScreenshots` (programada diaria): borra archivos y docs más antiguos que `screenshotRetentionDays`, incluidos archivos huérfanos en Storage (sin doc) creados antes del corte.
- `autoCloseStaleSessions` (programada cada hora): cierra jornadas sin latido hace >30 min o >16 h abiertas, `endedAt = lastHeartbeatAt`, `endReason = auto`.

## 7. Portal admin (React)
- **Login** con Google; si no es admin → "Sin acceso".
- **Equipo hoy / rango de fechas**: tabla por colaborador — estado (en jornada / fuera), horas, % actividad promedio, tiempo fuera de Chrome, última actividad.
- **Detalle de colaborador**: selector de fecha; jornadas del día; línea de tiempo de bloques de 10 min coloreada por % actividad; top dominios y URLs; galería de capturas (click para ampliar).
- **Invitaciones**: invitar por correo, ver pendientes/aceptadas, revocar, copiar enlace.
- **Colaboradores**: cambiar rol, desactivar.
- **Configuración**: capturas sí/no, difuminado sí/no, retención (días).
- Exportar CSV del resumen del equipo.

> **Actualización (horarios):** Configuración → **Horario** (semana, colación, tolerancia, recordatorios, feriados de Chile 2026–2027), horario **personalizado** por persona en Colaboradores, columnas de **cumplimiento** en Equipo y el CSV (esperadas, en horario, fuera de horario, atrasos, sin conexión, ausencias) y, en el detalle, tarjetas de cumplimiento y la línea de tiempo con fuera de horario, colación y marcas de entrada/salida. Ver [spec de horarios](2026-09-30-horarios.md).

### Decisiones de implementación (Tarea 6)
- **Acceso**: tras iniciar sesión el portal llama `joinOrg`; solo un perfil `admin` + `active` entra. Cualquier otro (colaborador, desactivado, sin invitación, otro dominio) ve "Sin acceso" con el motivo. Prod: `signInWithPopup` con `hd` = dominio (solo sugerencia; el dominio lo exige `joinOrg`). **Actualización:** con más de un dominio no se envía `hd`; con uno solo, sí (ver [spec multi-dominio](2026-09-29-multi-dominio.md)). Dev (`vite --mode development`): emuladores + login con correo simulado; ese código queda fuera del build prod (`scripts/check-build.ts` lo verifica).
- **Días y rangos** en America/Santiago (Hoy, Ayer, Esta semana lun–dom, Últimos 7 días, Este mes, Personalizado). El inicio de cada día se busca como el primer instante con esa fecha (en Chile el cambio de hora es a medianoche: hay días de 23 y 25 h).
- **Consultas**: `activity` por `slotStart ∈ [desde, hasta)` (y `uid` en el detalle); `sessions` con `startedAt ∈ [desde − 24 h, hasta)` más todas las abiertas (`endedAt == null`), para incluir jornadas que empezaron antes del rango; `screenshots` por `uid` + `takenAt`. Lectura paginada de 1000 en 1000. Usa los índices existentes.
- **"Horas"** = tiempo de jornada recortado al rango (abiertas hasta su último latido); debajo, "medidas" = suma de `trackedSeconds`. "En jornada" es el estado actual (`isSessionLive`), sin importar el rango. Colaboradores desactivados aparecen solo si tienen datos en el rango. Con el rango que incluye hoy se refresca cada 60 s mientras la pestaña está visible; cada refresco vuelve a leer `activity` solo desde el inicio de hoy y conserva los días anteriores ya cargados (un mes completo son ~30 000 lecturas para 30 personas). "Actualizar" relee todo el rango.
- **Niveles de actividad** (tabla, línea de tiempo y leyenda): baja < 40 %, media 40–69 %, alta ≥ 70 %. La línea de tiempo muestra filas por hora (6 bloques) desde la primera hasta la última hora con datos o captura.
- **Capturas**: miniaturas con `getDownloadURL` (las subidas por la API de Firebase Storage traen token de descarga) cargadas al entrar en pantalla; lightbox con hora, "Difuminada", anterior/siguiente y Esc.
- **Invitaciones**: pendiente → Reenviar (status `pending`, `invitedBy` = admin actual, `invitedAt` nuevo y siempre mayor que el anterior, sin `acceptedAt`) o Revocar; revocada → "Invitar de nuevo"; aceptada → se gestiona en Colaboradores. El formulario rechaza correos fuera de los dominios permitidos (acepta cualquiera de la lista), correos ya registrados o con invitación pendiente/aceptada. "Copiar enlace de instalación" usa `VITE_EXTENSION_INSTALL_URL`.
- **Configuración**: se guarda siempre el documento completo (6 campos, `updatedBy` = admin, `updatedAt` entero). ~~El dominio es de solo lectura hasta pulsar "Cambiar", que muestra una advertencia.~~ **Actualización:** la lista de dominios es de solo lectura hasta pulsar "Cambiar dominios", que permite agregar/quitar (con advertencia; no deja la lista vacía ni quitar el dominio del propio admin). Ver [spec multi-dominio](2026-09-29-multi-dominio.md).
- **Tema** claro/oscuro según el sistema, con botón para forzarlo (se recuerda en `localStorage` del navegador).

## 8. Extensión (popup)
- Sin sesión → "Iniciar sesión con Google".
- Sin consentimiento → pantalla de aviso + aceptar.
- Sin invitación → "Pide a tu admin que te invite".
- Normal → botón grande **Iniciar jornada / Cerrar jornada**, cronómetro de la jornada, horas de hoy, % actividad de hoy, qué se mide.
  - **Actualización (horarios, 0.2.0):** además el estado del horario ("En horario hasta 18:30", "Colación hasta 14:00", "Fuera de horario: no se mide", "Hoy es feriado", "Día libre") y el horario de hoy. Ver [spec de horarios](2026-09-30-horarios.md).

### Decisiones de implementación (Tarea 5)
- **Aviso**: página de la extensión `consent.html`. Se abre sola tras iniciar sesión si falta aceptar `CONSENT_VERSION`; `session.start` la exige (`consentVersion === CONSENT_VERSION`). Aceptar escribe `consentAcceptedAt` + `consentVersion` juntos en `users/{uid}`. Cambiar `CONSENT_VERSION` obliga a todos a aceptar de nuevo.
- **Horas y % de hoy**: se calculan solo con datos locales (resumen diario en `chrome.storage.local` alimentado por los snapshots del acumulador, día de America/Santiago como el portal). Solo cuentan lo medido en **este** navegador; no se lee Firestore.
- **`config/org`**: `getDoc` (Firestore lite) al iniciar jornada, al despertar el service worker (si tiene más de 1 min) y cada 5 min desde el pulso; se cachea. Sin leer o sin doc → capturas desactivadas.
- **Login prod**: `chrome.identity.getAuthToken` (cuenta de Google del perfil de Chrome) → `GoogleAuthProvider.credential(null, accessToken)`. Un token rechazado se quita de la caché de Chrome y se reintenta una vez. Cerrar sesión también quita el token en caché.
- **Sesión de Firebase terminada con la jornada abierta** (token revocado, usuario borrado): la jornada se cierra localmente y se **encola** el cierre; se envía si el mismo usuario vuelve a entrar (si entra otro, se descarta y el cierre automático del servidor la cierra en el último latido).
- **Íconos**: reloj azul; reloj verde + insignia "ON" durante la jornada.

### Decisiones de implementación (Tarea 7)
- **Rango personalizado**: máximo 93 días (`MAX_CUSTOM_RANGE_DAYS`). Si la URL pide más, se conserva la fecha final y se adelanta la inicial; si al elegir una fecha se pasa del tope, se mueve la otra. En ambos casos se muestra un aviso.
- **Enlace de instalación**: Invitaciones muestra una advertencia si `VITE_EXTENSION_INSTALL_URL` está vacío, es `REEMPLAZAR_…`, no es https o es el enlace falso de desarrollo.
- **Contraste**: el % dentro de las celdas de la línea de tiempo usa la tinta completa (sin opacidad): ≥ 4,5:1 en todos los niveles, claro y oscuro.
- **Seed** (`scripts/seed.ts`): cuentas de Auth creadas con el mismo token simulado del login dev (mismo uid al entrar desde portal o extensión); datos escritos con Admin SDK; idempotente reemplazando sesiones, actividad y capturas de los colaboradores de ejemplo. Capturas de ejemplo: maquetas HTML difuminadas renderizadas con Chromium (si no hay Chromium, se omiten con aviso).
- **E2E integrado** (`scripts/e2e.ts`): la admin activa capturas e invita desde la UI del portal; luego el colaborador usa la extensión (~70 s de actividad real para que el portal muestre ≥ 1 min); por último la admin ve horas, actividad y captura.
- **Helpers comunes** en `scripts/lib` (workspace `@timetracking/scripts`, con typecheck y tests): Chromium, REST de emuladores, navegador con la extensión, servidor Vite del portal.

## 9. Criterios de aceptación
1. Admin invita `x@dominio` (cualquiera de los dominios permitidos); se crea invitación y se envía (o registra) correo.
2. `x` inicia sesión en la extensión, acepta aviso, queda como `member`. Un correo sin invitación o de otro dominio es rechazado.
3. Iniciar jornada crea `sessions` abierta; cerrar la marca cerrada. Badge ON/OFF.
4. Con jornada abierta, cada 10 min aparece un doc `activity` con `activeSeconds ≤ trackedSeconds ≤ 600`, dominios y tiempo fuera de Chrome.
5. Con capturas activas, aparecen capturas (difuminadas si está activo) en Storage y en el portal.
6. Portal muestra horas y % actividad por colaborador y el detalle por día.
7. Un `member` no puede leer datos de otros ni cambiar su rol (tests de reglas).
8. Capturas más antiguas que la retención se borran.
9. Tests unitarios, de reglas y de functions pasan; typecheck y build de los 3 paquetes pasan.

## 10. Pasos que requieren al usuario (despliegue, fuera de este MVP local)
- Crear proyecto Firebase (plan **Blaze**, requerido por Storage y Functions; costo estimado para 30 personas: bajo, del orden de USD 0–5/mes).
- Crear cliente OAuth tipo "Extensión de Chrome" con el ID de la extensión.
- (Opcional) Configurar SMTP para correos (ej. cuenta Workspace con contraseña de aplicación) en Secret Manager y poner `INVITE_EMAIL_ENABLED=true`.
- Publicar extensión (cuenta de desarrollador Chrome, USD 5 único) y forzar instalación en la consola de Workspace (de cada organización; pantalla de consentimiento OAuth **Externa**; ver [spec multi-dominio](2026-09-29-multi-dominio.md)).
- Autorizar el despliegue (`firebase deploy`).
