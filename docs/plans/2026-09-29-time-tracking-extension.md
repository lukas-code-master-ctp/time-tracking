# Plan — Registro de jornada y actividad

Spec: `docs/specs/2026-09-29-time-tracking-extension.md` (leer completo antes de cada tarea).

Ejecución: una tarea por subagente, en orden; cada tarea la revisa otro subagente antes de seguir. Cada tarea termina con sus tests/typecheck en verde y un commit.

## Convenciones globales
- TypeScript estricto en todo. Node 22 (Functions), ES2022.
- npm workspaces en la raíz: `packages/shared`, `extension`, `portal`, `functions`. Una sola `package-lock.json` en la raíz.
- Proyecto Firebase de emulador: `demo-timetracking` (prefijo `demo-` = no requiere proyecto real). Puertos: auth 9099, firestore 8080, storage 9199, functions 5001, hosting 5000, UI 4000.
- Región Functions: `southamerica-west1` (Santiago).
- Textos de UI en español neutro (tú).
- Scripts raíz: `npm run typecheck`, `npm test` (unit), `npm run test:emulator` (reglas + functions con `firebase emulators:exec`), `npm run build`.
- Variables de configuración en `packages/shared/src/config.ts` o `.env` por paquete (`VITE_*`): `ALLOWED_DOMAIN` (default `compratuparcela.cl`), `BOOTSTRAP_ADMINS` (lista de correos), `APP_ENV` (`dev`|`prod`).

## Tarea 1 — Monorepo, Firebase y `packages/shared`
- `package.json` raíz con workspaces y scripts; `tsconfig.base.json`; `.gitignore` (node_modules, dist, .firebase, *.log, emulator data).
- `firebase.json` (firestore rules/indexes, storage rules, functions source `functions`, hosting `portal/dist` con rewrite SPA, emulators con puertos arriba), `.firebaserc` con `demo-timetracking`, `firestore.rules` y `storage.rules` iniciales (deny all), `firestore.indexes.json`.
- `packages/shared/src`:
  - `types.ts`: `OrgConfig`, `Invitation`, `UserProfile`, `Role`, `Session`, `ActivitySlot`, `ScreenshotMeta` exactamente como el modelo de datos del spec §5 (timestamps como `number` ms en el cliente; se documenta conversión a Firestore Timestamp donde aplique — **decisión: guardar todos los tiempos como número ms epoch** para simplicidad y consultas por rango).
  - `collections.ts`: nombres de colecciones y helpers de ids (`activityDocId(uid, slotStart)`, `emailKey(email)` = lowercase trim).
  - `slots.ts`: `SLOT_MS = 600000`, `slotStartOf(ms)`, `slotsBetween(a,b)`.
  - `url.ts`: `sanitizeUrl(url)` (quita query y hash, descarta esquemas no http/https devolviendo `null`), `domainOf(url)`.
  - `accumulator.ts`: clase pura `SlotAccumulator` que recibe eventos con timestamp: `markActiveSecond(ms)`, `setIdleState('active'|'idle'|'locked', ms)`, `setFocus({url, measurable} | null, ms)` (null = fuera de Chrome; `measurable=false` = página sin content script, ej. chrome://, PDF). Un segundo cuenta activo si el content script lo marcó, **o** si el foco es `null`/no medible y el estado idle es `active` (spec §3.1), `tick(ms)`; produce `ActivitySlot` parciales/cerrados vía `flush(ms)` → `{ closed: ActivitySlot[], current: ActivitySlot | null }`. Reglas del spec §3.1–3.2: segundos activos únicos (set de segundos), tope 600, `activeSeconds ≤ trackedSeconds`, top 20 URLs, dominios, `outsideChromeSeconds`. Serializable (`toJSON`/`fromJSON`) para `chrome.storage`.
  - `domain.ts`: `isAllowedEmail(email, allowedDomain)`.
  - `reports.ts`: funciones puras para el portal: `summarizeMember(slots, sessions)` → horas, % actividad, fuera de Chrome, top dominios; `summarizeTeam(...)`; `toCsv(rows)`.
  - `index.ts` re-exporta.
- Vitest con tests exhaustivos de `slots`, `url`, `accumulator` (cruces de bloque, idle, fuera de Chrome, duplicados, serialización), `reports`.
- Verificación: `npm install`, `npm run typecheck`, `npm test`.

## Tarea 2 — Reglas de seguridad + tests
- `firestore.rules` y `storage.rules` según spec §5.
- `tests/rules/*.test.ts` (paquete `functions` o carpeta raíz `tests` con vitest + `@firebase/rules-unit-testing`), ejecutados con `firebase emulators:exec --only firestore,storage`.
- Casos mínimos: member lee/escribe lo suyo; no lee lo de otros; no crea `users`; no cambia `role`; no escribe `config/org`; admin lee todo y escribe config/invitations; usuario disabled no escribe; storage: tamaño/tipo/ruta.
- Verificación: `npm run test:emulator` verde.

## Tarea 3 — Cloud Functions
- `functions/src`: `joinOrg`, `onInvitationCreated`, `purgeOldScreenshots`, `autoCloseStaleSessions` (spec §6), Firebase Functions v2, región arriba. Lógica de negocio en funciones puras testeables separadas de los handlers.
- Correo: nodemailer con secretos `SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM` (defineSecret); si faltan o en emulador → `logger.info` con el contenido. Link de instalación configurable `EXTENSION_INSTALL_URL`.
- Config por defecto de `config/org` creada por `joinOrg` si no existe (primer admin bootstrap).
- Tests con emuladores (firestore, auth, storage, functions) llamando las funciones reales o sus núcleos con Admin SDK contra emulador.
- Verificación: build de functions + tests verdes.

## Tarea 4 — Extensión: núcleo de medición
- `extension/`: MV3 con Vite (build multi-entrada: `background` service worker módulo, `content`, `popup`, `consent`), `manifest.json` generado con permisos: `storage`, `alarms`, `idle`, `tabs`, `identity`, `activeTab` no basta → usar `<all_urls>` host permission para `captureVisibleTab` y content scripts. `incognito: "not_allowed"`.
- `src/background/`: `tracker.ts` (usa `SlotAccumulator`; escucha idle con `chrome.idle.setDetectionInterval(15)`, tabs, windows focus, mensajes del content script), `state.ts` (persistencia en `chrome.storage.local`, rehidratación al despertar), `sync.ts` (cola de subida con reintentos: upsert de `activity`, latido de `sessions`), `session.ts` (start/stop, badge ON/OFF), `firebase.ts` (inicialización; `firebase/auth/web-extension`; en `APP_ENV=dev` conecta a emuladores).
- `src/content/activity.ts`: listeners pasivos, throttle 1/s, `chrome.runtime.sendMessage({type:'activity', t})`. Nunca envía contenido de teclas.
- `chrome.alarms` de 30 s → `tick` + flush + sync cada ~60 s.
- Tests vitest con mocks de `chrome.*` para tracker/state/sync (fake timers).
- Verificación: typecheck, tests, `npm run build -w extension` (dev y prod) genera `extension/dist` cargable.

## Tarea 5 — Extensión: login, consentimiento, popup y capturas
- Login: prod `chrome.identity.getAuthToken({interactive:true})` → `GoogleAuthProvider.credential(null, token)` → `signInWithCredential`; dev: formulario de correo → credencial falsa del emulador. Luego callable `joinOrg`; manejar errores (sin invitación, dominio).
- Consentimiento (spec §4): página `consent.html`, guarda `consentAcceptedAt/consentVersion` en `users/{uid}` (ajustar reglas para permitir que el usuario escriba solo esos dos campos; agregar test de reglas).
- Popup: estados del spec §8, cronómetro, horas y % de hoy (del acumulador local + slots del día), qué se mide.
- Capturas (spec §3.3): scheduler aleatorio por bloque, `captureVisibleTab` JPEG, redimensionar/difuminar con `OffscreenCanvas`, subir a Storage + doc; cola offline (base64 en `chrome.storage.local`, máx 20 pendientes). Leer `config/org` (onSnapshot o refresco cada 5 min).
- Tests unitarios del scheduler y del procesamiento (lo que sea testeable sin navegador).
- Verificación: typecheck, tests, build.

## Tarea 6 — Portal admin
- `portal/`: React + Vite + React Router; Firebase web SDK; en dev conecta a emuladores (y login dev con correo simulado).
- Páginas del spec §7: Login, Equipo (rango de fechas, tabla, CSV), Colaborador (fecha, jornadas, línea de tiempo de bloques coloreada, top dominios/URLs, galería con lightbox), Invitaciones, Colaboradores, Configuración. Usa `reports.ts` de shared.
- Diseño limpio, responsive, claro/oscuro. Sin librerías de UI pesadas (CSS propio o similar liviano).
- Tests: vitest + testing-library para componentes clave y lógica de datos.
- Verificación: typecheck, tests, build.

## Tarea 7 — Integración, semillas y documentación
- `scripts/seed.ts`: carga en emuladores un admin, 3 colaboradores, invitaciones, jornadas y actividad de varios días con capturas de ejemplo.
- Prueba end-to-end (Playwright) con emuladores: cargar la extensión dev en Chromium, login dev, aceptar aviso, iniciar jornada, navegar a una página local, forzar tick/flush, cerrar jornada; verificar docs en Firestore; abrir portal como admin y ver al colaborador con actividad.
- `README.md` (español): qué es, cómo correr en local, cómo probar, y guía paso a paso de despliegue (spec §10).
- Verificación final: `npm run typecheck && npm test && npm run test:emulator && npm run build` + e2e.
