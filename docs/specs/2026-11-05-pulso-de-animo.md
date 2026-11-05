# Pulso de ánimo (2026-11-05)

Pedido de Lukas (idea 4 de la lista de RRHH): al cerrar la jornada, una pregunta de un clic ("¿Cómo estuvo tu día?"); gerencia ve tendencias agregadas y anónimas en el portal.

## Decisiones

- **Ajuste de empresa**, apagado por defecto: `config/org.moodPulseEnabled` (opcional; el portal solo lo escribe cuando está activo, así guardar funciona con reglas antiguas).
- **Cuándo se pregunta**: tras un cierre manual (popup o botón del recordatorio de salida), si la empresa lo tiene activo y la persona no respondió ni omitió hoy en este equipo. La pregunta queda en el popup hasta responder u omitir, o hasta que cambie el día. Los cierres automáticos (servidor o sesión rechazada) no preguntan.
- **Escala**: 1–5 con caras (😣 Muy mal, 😕 Mal, 😐 Normal, 🙂 Bien, 😄 Muy bien). "Omitir" no envía nada.
- **Anonimato** (lo central):
  - `moodWeeks/{YYYY-Www}`: solo contadores `n1`…`n5` de la semana ISO (hora de Chile). Sin uid, sin día, sin hora. Lo leen los admins.
  - `moodVotes/{uid_YYYY-Www}`: `{ uid, week, dates[] }`, los días que respondió (nunca qué). Solo la propia persona lo lee; nadie lo lista.
  - La extensión escribe ambos en un **lote** (`arrayUnion(date)` + `increment(1)`). Las reglas aceptan que un contador suba en 1 solo si en el mismo lote el registro de la persona gana exactamente un día nuevo. Un segundo intento del mismo día es rechazado (`permission-denied`) y la cola lo descarta.
  - El portal oculta las semanas con menos de 3 respuestas (`MOOD_MIN_RESPONSES`). Es una regla de presentación: los contadores crudos siguen siendo legibles para un admin.
  - Límites conocidos: quien vea la consola de Firebase podría cruzar la hora de actualización del contador con el cierre de jornada de alguien; y las reglas no validan que la fecha pertenezca a la semana (una persona que manipule su extensión podría sumar hasta 7 respuestas por semana).
- **Sin conexión**: la respuesta va por la cola persistente (`kind: 'mood'`, una por persona y día).
- **Portal**: página "Pulso de ánimo" (`/animo`) con el interruptor, 3 tarjetas (promedio de las últimas 4 semanas, respuestas, diferencia con las 4 anteriores) y las últimas 12 semanas con barra de distribución y promedio.
- **Privacidad**: `/privacidad` lo explica. No cambia `CONSENT_VERSION` (no se mide nada nuevo de la jornada y es opcional).

## Versiones

Extensión 0.2.16. Reglas de Firestore nuevas (`moodWeeks`, `moodVotes`, campo `moodPulseEnabled`): hay que desplegarlas; antes de eso el portal muestra la página sin respuestas y la extensión descarta las respuestas tras 3 intentos.
