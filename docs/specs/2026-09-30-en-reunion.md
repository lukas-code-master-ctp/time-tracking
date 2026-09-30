# Spec — Tiempo "En reunión"

Fecha: 2026-09-30 · Complementa `2026-09-29-time-tracking-extension.md`

## Problema
En una videollamada web donde la persona solo escucha no hay teclado ni mouse, y el tiempo cuenta como inactivo. El % de actividad baja aunque la persona esté trabajando.

## Decisión del usuario
Todo el tiempo en **sitios web de reuniones** se registra como **"En reunión"**: una categoría aparte que **no sube ni baja** el % de actividad.

## Qué es "estar en reunión"
Un segundo cuenta como **en reunión** si **no** fue activo por teclado/mouse **y** en ese segundo hay una **reunión en curso** en alguna pestaña de una ventana de Chrome que no sea incógnito (normal, emergente o app web instalada, p. ej. Meet o Teams como PWA; nunca DevTools), esté o no al frente, siempre que esa pestaña tenga audio reciente (ver abajo). Con la pantalla bloqueada nunca hay reunión (la persona no está).

Una pestaña tiene una **reunión en curso** si su URL (sanitizada) coincide con el patrón de sala de una plataforma conocida:

| Plataforma | Patrón (host + ruta) |
|---|---|
| Google Meet | `meet.google.com/<código>` con código `xxx-xxxx-xxx` (letras) o `lookup/…` |
| Zoom web | `*.zoom.us/wc/<id>/…` o `*.zoom.us/wc/join/<id>` con `<id>` numérico (9–12 dígitos); no `app.zoom.us/wc/home`, `/wc/team-chat`, `/wc/leave`… (app web de Zoom Workplace) |
| Microsoft Teams | `teams.microsoft.com`, `teams.live.com` con ruta de llamada/reunión (`/_#/meetup-join`, `/l/meetup-join/`, `/v2/`, `/light-meetings/`), o cualquier ruta de `teams.cloud.microsoft` (cliente nuevo), **y** la pestaña está reproduciendo audio o lo hizo en los últimos 2 min |
| Webex | `*.webex.com/meet/<sala>`, `*.webex.com/wbxmjs/…`, `*.webex.com/webappng/sites/<sitio>/meeting/…` (no el resto del portal `webappng`: panel, grabaciones…) |
| Jitsi | `meet.jit.si/<sala>` |
| Whereby | `whereby.com/<sala>` |
| GoTo Meeting | `app.goto.com/meeting/…`, `meet.goto.com/…` |

Además de la URL de sala, se exige que la pestaña esté **reproduciendo audio o lo haya hecho en los últimos 2 min**, para todas las plataformas y **también con la pestaña al frente** (cambio del 2026-09-30, spec `2026-09-30-horarios.md`, aprobado por el usuario). Antes bastaba estar al frente para Meet, Zoom, Webex, Jitsi, Whereby y GoTo; eso contaba como reunión la sala de espera o la pantalla "Saliste de la reunión". En Teams siempre fue así, porque su URL no distingue bien una reunión del chat.

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
- La detección de reuniones solo se usa cuando la persona aceptó el aviso nuevo: una jornada abierta con 0.1.1 que se actualiza a 0.1.2 sigue midiendo como antes (sin "En reunión") hasta que acepte.
- Versión **0.1.2**. La 0.1.1 está en revisión en la tienda: la 0.1.2 se usa en QA (`build:qa`) y se sube a la tienda después de que aprueben la 0.1.1.

## Despliegue (orden obligatorio)
1. **Primero** desplegar `firestore.rules` (acepta `meetingSeconds`).
2. **Después** distribuir la extensión 0.1.2 (QA o tienda).

Si una 0.1.2 escribe contra reglas antiguas, Firestore rechaza el bloque con `permission-denied` por el campo desconocido. Como resguardo, el cliente reintenta de inmediato ese mismo bloque sin `meetingSeconds` (como la 0.1.1): no se pierde el bloque, solo el tiempo en reunión. Es un resguardo, no el camino previsto.

**Limitaciones conocidas:** una reunión en la que nadie habla por más de 2 min (o con el audio de la pestaña silenciado) deja de contar como reunión hasta que vuelve a sonar. Tras salir, la sala sigue contando hasta 2 min después del último audio. En Teams, como su URL no distingue la reunión del chat, un sonido de notificación da hasta 2 min de "reunión" si no hay teclado/mouse. El fin del período de gracia de 2 min se aplica en el siguiente pulso (hasta 30 s tarde).

## Criterios de aceptación
1. Meet en una sala, sin tocar nada por 5 min: el bloque queda con `meetingSeconds` ≈ lo medido y el portal lo muestra "En reunión" sin bajar el %.
2. Escribir en Docs con Meet en otra pestaña con audio: los segundos con teclado son activos y el resto reunión.
3. Sala de Meet sin audio por más de 2 min: no cuenta como reunión, esté al frente o en segundo plano.
4. Docs 0.1.1 sin `meetingSeconds` siguen válidos y se leen como 0.
5. Reglas: rechazan `meetingSeconds` negativo, no entero o que rompa la suma.
6. Todos los tests, typecheck, build y e2e en verde.

## Decisiones de implementación del portal (Tarea 2)
- Línea de tiempo: color `--lvl-meeting` (#b4a7f5 claro, #8b7fe0 oscuro; tinta sobre él 8,28:1 y 5,75:1, verificado en `portal/test/contrast.test.ts` leyendo `styles.css`) para bloques con reunión ≥ 50 % de lo medido; marcador (barra de tinta arriba a la izquierda, libre del % en celdas angostas de teléfono) en cualquier bloque con reunión. El % de la celda excluye la reunión; si todo fue reunión muestra "—".
- Detalle del bloque: "En reunión X min" y "Actividad: —" cuando no hay %. `ActivityMeter` muestra "—" (no "Sin datos") si hubo tiempo medido pero todo fue reunión.
- Equipo: columna "En reunión" entre "Estado" y "Fuera de Chrome" (mismo orden relativo que el CSV), total en el pie y tarjeta en los totales del periodo.
- Seed: daily 09:30–10:00 cada día hábil, una reunión de 1 h (15:00–16:00) por persona a la semana, videollamadas al azar con `meetingSeconds`, y los días más antiguos sin el campo (como la 0.1.1).
- `e2e` no puede entrar a una sala real: siembra dos bloques con `meetingSeconds` para el colaborador y verifica tabla y detalle.
