# Spec — Pausa activa

Fecha: 2026-10-21 · Extensión 0.2.7

## Qué pidió el usuario
- Una configuración por empresa, "Pausa activa", con notificaciones para que la persona tome un break y haga un ejercicio.
- La persona marca la pausa como tomada, y eso **aparece en la línea de tiempo** del portal.
- Cada persona **puede desactivarla** para sí misma.
- Se guarda cada respuesta (tomada, pospuesta, omitida) para una futura etapa de **gamificación**.

## Configuración (`config/org`, portal → Configuración → Pausa activa)
| Campo | Tipo | Valores | Por defecto |
|---|---|---|---|
| `activeBreaksEnabled` | bool | — | apagado (campo ausente) |
| `activeBreakIntervalMinutes` | int | portal: 45, 60, 90, 120 · reglas: 15–240 | 60 |
| `activeBreakMinutes` | int | portal: 3, 5, 10 · reglas: 1–15 | 5 |

Los tres son opcionales. El portal solo los escribe con la pausa activa encendida, así que guardar con ella apagada funciona con las reglas anteriores.

## Cuándo avisa (extensión)
- Después de `activeBreakIntervalMinutes` de **trabajo continuo**: con la jornada abierta, dentro del horario (no en la colación) y con uso de teclado o mouse.
- Si la persona estuvo **inactiva o con la pantalla bloqueada** el tiempo que dura la pausa, eso ya cuenta como pausa y la cuenta parte de cero. Lo mismo pasa con un hueco sin pulsos de esa duración, por ejemplo con el equipo suspendido.
- No avisa **durante una reunión web**: espera a que termine. Tampoco avisa mientras la persona está inactiva.
- Muestra un solo aviso a la vez. Si queda sin responder, el siguiente llega un intervalo completo después, lo reemplaza y el anterior se guarda como *omitido*.
- El ejercicio sugerido rota entre 8 opciones (`ACTIVE_BREAK_EXERCISES`).

Notificación: título "Pausa activa · 5 min", texto del ejercicio, botones **"Tomé la pausa"** y **"En 10 min"**, `requireInteraction: true`, para que la persona pueda volver del break y marcarlo. Al hacer clic en el cuerpo se abre el popup.

Popup: tarjeta "Pausa activa" con el aviso pendiente y los mismos botones, la hora aproximada de la próxima pausa y el interruptor **"Recordarme las pausas activas"**. La preferencia se guarda en ese equipo, por usuario.

## Datos (`breaks/{uid_promptedAt}`)
Hay un documento por cada aviso respondido, que se escribe una vez y no cambia:
`uid, sessionId, status ('taken' | 'postponed' | 'skipped'), promptedAt, answeredAt, start, end, exercise`.
- `taken`: `start..end` dura lo configurado y termina cuando la persona marca la pausa, pero nunca empieza antes del aviso. Este intervalo es el que se dibuja en la línea de tiempo.
- `postponed`: "En 10 min". `skipped`: la persona cerró el aviso o lo reemplazó el siguiente. En ambos casos `start = end = answeredAt`.
- Se sube por la cola persistente, como la actividad. Un `permission-denied` se reintenta 3 veces y luego se descarta, sin cerrar la jornada.
- Lectura: el dueño y los admins. Índice `uid + start`.

## Portal
- En Colaborador → día: un stat "Pausas activas" con las tomadas, pospuestas y omitidas, que se muestra si la empresa tiene la pausa activa encendida o si el día tiene pausas. En la línea de tiempo, una barra en la parte inferior del bloque marca los minutos de la pausa, y el detalle muestra "Pausa activa 10:32–10:37 · Estira el cuello".
- Si las reglas o el índice aún no están desplegados, la página funciona sin las pausas.

## Aviso / privacidad
Se agrega "Pausas activas, solo si tu empresa las activa" a lo que se mide, en `consent.html` y en la política de privacidad. Son respuestas que da la propia persona, así que **no se sube `CONSENT_VERSION`**.

## Despliegue
1. `npx firebase deploy --only firestore:rules,firestore:indexes --project prod` (manual, ni Vercel ni CI lo hacen).
2. Merge: el portal se publica en Vercel y la extensión 0.2.7 se sube a la tienda.
3. Activar la pausa activa en Configuración.

## Futuro (gamificación)
Rachas y metas personales en el popup, desafíos de equipo agregados y nada de rankings individuales visibles para la jefatura. Una pausa marcada con actividad durante su intervalo no suma puntos. Todo esto sale de `breaks`.
