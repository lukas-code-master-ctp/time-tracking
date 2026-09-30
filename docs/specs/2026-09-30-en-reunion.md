# Spec — Tiempo "En reunión"

Fecha: 2026-09-30 · Complementa `2026-09-29-time-tracking-extension.md`

## Problema
En una videollamada web donde la persona solo escucha no hay teclado ni mouse, y el tiempo cuenta como inactivo. El % de actividad baja aunque la persona esté trabajando.

## Decisión del usuario
Todo el tiempo en **sitios web de reuniones** se registra como **"En reunión"**: una categoría aparte que **no sube ni baja** el % de actividad.

## Qué es "estar en reunión"
Un segundo cuenta como **en reunión** si **no** fue activo por teclado/mouse **y** en ese segundo hay una **reunión en curso** en alguna pestaña de una ventana normal (no incógnito) de Chrome, esté o no al frente.

Una pestaña tiene una **reunión en curso** si su URL (sanitizada) coincide con el patrón de sala de una plataforma conocida:

| Plataforma | Patrón (host + ruta) |
|---|---|
| Google Meet | `meet.google.com/<código>` con código `xxx-xxxx-xxx` (letras) o `lookup/…` |
| Zoom web | `*.zoom.us/wc/…` o `app.zoom.us/wc/…` |
| Microsoft Teams | `teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft` con ruta de llamada/reunión (`/_#/meetup-join`, `/l/meetup-join/`, `/v2/`, `/light-meetings/`), **y** la pestaña está reproduciendo audio o lo hizo en los últimos 2 min |
| Webex | `*.webex.com/meet/…`, `*.webex.com/wbxmjs/…`, `*.webex.com/webappng/…` |
| Jitsi | `meet.jit.si/<sala>` |
| Whereby | `whereby.com/<sala>` |
| GoTo Meeting | `app.goto.com/meeting/…`, `meet.goto.com/…` |

Para Meet, Zoom, Webex, Jitsi, Whereby y GoTo basta la URL de sala. Además se exige que la pestaña esté **al frente o haya reproducido audio en los últimos 2 min**, para no contar una sala que quedó abierta en segundo plano después de terminar. Teams siempre exige audio reciente, porque su URL no distingue bien una reunión del chat.

La lista vive en `packages/shared` (`meetings.ts`) con tests por patrón. No hay configuración desde el portal en esta versión.

**No detectable:** Zoom, Teams u otras apps **de escritorio** (fuera de Chrome). Siguen midiéndose con la inactividad del sistema, como hoy. Se documenta.

## Cálculo
- `ActivitySlot` suma el campo **`meetingSeconds`**: segundos del bloque en reunión. Invariantes: `meetingSeconds + activeSeconds ≤ trackedSeconds`, sin solaparse (un segundo con teclado/mouse es activo, no reunión).
- **% de actividad = activeSeconds ÷ (trackedSeconds − meetingSeconds)**. Si el denominador es 0 (bloque entero en reunión), el % no se muestra ("—") y no entra en promedios.
- Las **horas de jornada no cambian**.
- `outsideChromeSeconds` sigue igual: si la reunión está en una pestaña de fondo y la persona está en otra app, cuenta como fuera de Chrome **y** en reunión.
- Compatibilidad: docs sin `meetingSeconds` (extensión 0.1.1 de la tienda, datos previos) se leen como `0`.

## Reglas Firestore
`activity` acepta los 8 campos actuales **y opcionalmente** `meetingSeconds` (entero ≥ 0, `meetingSeconds + activeSeconds ≤ trackedSeconds`). Siguen rechazándose campos extra.

## Portal
- Tarjeta nueva **"En reunión"** (duración) en el detalle y columna en Equipo y en el CSV.
- Línea de tiempo: un bloque con reunión muestra un marcador; un bloque **mayormente en reunión** (≥ 50 % de lo medido) se pinta con un color propio de "reunión" (accesible en claro y oscuro) con su % o "—". El tooltip muestra "En reunión X min".
- Leyenda actualizada.

## Extensión
- Popup: "En reunión hoy" junto a horas y actividad; "Qué se mide" agrega "Reuniones web (Meet, Zoom, Teams…)".
- Aviso de consentimiento y política de privacidad: explican que se detecta si hay una reunión web abierta (por la dirección de la página y si la pestaña reproduce audio) para no contarla como inactividad; nunca se accede al audio ni al video. **`CONSENT_VERSION` sube**, así que cada persona vuelve a aceptar una vez.
- Versión **0.1.2**. La 0.1.1 está en revisión en la tienda: la 0.1.2 se usa en QA (`build:qa`) y se sube a la tienda después de que aprueben la 0.1.1.

## Criterios de aceptación
1. Meet en una sala, sin tocar nada por 5 min: el bloque queda con `meetingSeconds` ≈ lo medido y el portal lo muestra "En reunión" sin bajar el %.
2. Escribir en Docs con Meet en otra pestaña con audio: los segundos con teclado son activos y el resto reunión.
3. Sala de Meet abierta en segundo plano, sin audio más de 2 min y sin estar al frente: no cuenta como reunión.
4. Docs 0.1.1 sin `meetingSeconds` siguen válidos y se leen como 0.
5. Reglas: rechazan `meetingSeconds` negativo, no entero o que rompa la suma.
6. Todos los tests, typecheck, build y e2e en verde.
