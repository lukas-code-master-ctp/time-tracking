# Plan — Tiempo "En reunión"

Spec: `docs/specs/2026-09-30-en-reunion.md`.

## Tarea 1 — Núcleo (shared + reglas + extensión)
1. `packages/shared`:
   - `meetings.ts`: `meetingPlatformOf(url)` y `isMeetingUrl(url)` con la tabla del spec; tests por plataforma, con casos positivos y negativos (portada de Meet, chat de Teams, etc.).
   - `types.ts`: `ActivitySlot.meetingSeconds?: number`.
   - `accumulator.ts`: nuevo input `setMeeting(inMeeting: boolean, ms)`. Por segundo: activo si hay input (o por la regla de idle); si no, reunión si `inMeeting`. Invariantes y serialización, con tests.
   - `reports.ts`: % excluye la reunión; `meetingSeconds` en resúmenes y CSV (columna "En reunión"); bloques con denominador 0 fuera de promedios. Tests.
2. `firestore.rules` + tests: `meetingSeconds` opcional.
3. `extension`:
   - Tracker: estado de reunión desde `tabs` (URL, `audible`, pestaña activa); último audio por pestaña con marca de tiempo en estado persistido; se evalúa en eventos de `tabs.onUpdated` (`audible`/`url`), `onActivated`, `onRemoved`, foco y en cada pulso.
   - Sync: envía `meetingSeconds`.
   - Popup: "En reunión hoy" y "Qué se mide".
   - Aviso de consentimiento: texto nuevo y `CONSENT_VERSION` nueva.
   - Versión 0.1.2.
   - Tests.
4. Verificación: typecheck, test, test:emulator, build:qa, e2e:extension.

## Tarea 2 — Portal y textos
1. Detalle: tarjeta "En reunión", línea de tiempo (color, marcador, tooltip, leyenda), % con "—".
2. Equipo: columna "En reunión"; CSV.
3. `/privacidad`: sección actualizada.
4. README y spec original: nota.
5. Seed: bloques de ejemplo con reuniones.
6. Tests y e2e (`e2e:portal`, `e2e`).

Cada tarea la implementa un subagente y la revisa otro antes de seguir.
