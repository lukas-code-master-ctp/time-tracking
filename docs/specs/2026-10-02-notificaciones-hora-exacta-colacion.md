# Spec — Notificaciones a la hora exacta y de colación

Fecha: 2026-10-02 · Modifica `2026-09-30-horarios.md` (§Extensión, recordatorios)

## Cambios pedidos por el usuario
1. Las notificaciones salen **justo a la hora** del horario. La tolerancia ya no se suma a los recordatorios; se sigue usando solo para calcular atrasos y salidas anticipadas en los reportes.
2. Notificaciones nuevas al **inicio** y al **término de la colación**.

## Recordatorios (extensión 0.2.2)
Todos salen una vez por evento y por día, en días laborales que no son feriado, con `remindersEnabled` y la sesión iniciada en la extensión:

| Evento | Hora | Condición | Texto | Botón |
|---|---|---|---|---|
| Entrada | `start` exacto | Sin jornada abierta | "Tu jornada empieza a las 09:00. ¿Iniciar jornada?" | Iniciar jornada |
| Inicio de colación | `lunchStart` exacto | Jornada abierta | "Es hora de tu colación (14:00–15:00). Durante la colación no se mide." | — |
| Término de colación | `lunchEnd` exacto | Jornada abierta | "Terminó tu colación. Se vuelve a medir desde las 15:00." | — |
| Término de colación | `lunchEnd` exacto | Sin jornada abierta (la cerraron para almorzar) | "Terminó tu colación. ¿Retomar la jornada?" | Iniciar jornada |
| Salida | `end` exacto | Jornada abierta | "Tu horario terminó a las 18:30. ¿Cerrar jornada?" | Cerrar jornada |

- Un día sin colación no tiene avisos de colación.
- Las notificaciones de colación no exigen interacción (`requireInteraction: false`): desaparecen solas. Las de entrada y salida mantienen el comportamiento actual.
- Si la extensión despierta tarde, por ejemplo con el computador suspendido, cada evento se evalúa una vez en el primer despertar posterior a su hora, como hoy. No se envía un aviso si ya pasó el siguiente evento del día, por ejemplo uno de colación después de la salida.
- Un botón de un aviso de otro día no actúa, solo abre el popup. Ya está así.

## Texto del aviso de consentimiento / privacidad
Los textos que hablen de "recordatorios de inicio y cierre" pasan a decir "recordatorios de inicio, colación y cierre". No cambia lo que se mide, así que **no se sube `CONSENT_VERSION`**.

## Despliegue
Extensión **0.2.2**. La 0.2.1 está en revisión en la tienda: se sube la 0.2.2 cuando aprueben la 0.2.1, o se cancela la revisión y se envía la 0.2.2 (decide el usuario). QA con `dist-qa`. No requiere reglas nuevas ni cambios en el portal, salvo los textos de ayuda que mencionen la tolerancia en los recordatorios.

## Criterios de aceptación
1. Con salida a las 18:30, el aviso de cierre sale a las 18:30:00, no a las 18:35.
2. Los avisos de inicio y término de colación salen a sus horas exactas, solo con la jornada abierta, salvo la variante "¿Retomar la jornada?".
3. Feriado o día libre: ningún aviso. Día sin colación: sin avisos de colación.
4. Una vez por evento y día.
5. Tests, typecheck, build:qa y e2e en verde.

## Segundo aviso de entrada (extensión 0.2.5, 2026-10-09)
Pedido del usuario: el aviso de entrada llega a la hora en punto (09:00) y, si la persona no inició la jornada, llega otro 10 minutos después.

| Evento | Hora | Condición | Texto | Botón |
|---|---|---|---|---|
| Entrada (repetición) | `start` + 10 min | Sin jornada abierta | "Aún no inicias tu jornada (empezaba a las 09:00). ¿Iniciar jornada?" | Iniciar jornada |

- Reemplaza la notificación del primer aviso (se borra) y queda hasta que la persona la atiende.
- No existe si la colación o la salida caen antes de ese minuto.
- Un despertar tardío muestra solo el primer aviso: el segundo no sale junto con el primero ni más de 15 minutos después de su hora. El segundo aviso no cuenta como "siguiente evento" para ocultar el primero.
- Solo cambia la extensión; no hay campos nuevos en Firestore ni reglas.

## Decisiones de implementación
- **Hora exacta**: `remindersForDay` (`extension/src/background/schedule.ts`) devuelve los eventos del día en orden (`start`, `lunchStart`, `lunchEnd`, `end`) con `at` = la hora exacta del horario (`planForDay`: `span.start`, `lunch.start`, `lunch.end`, `span.end`). La tolerancia ya no se usa en la extensión para los avisos; `EffectiveSchedule.toleranceMinutes` se mantiene (es parte del horario efectivo) y el portal la sigue usando para atrasos y salidas anticipadas.
- **Alarma `tt-schedule`**: `nextScheduleWake` ya tomaba el mínimo entre transiciones, recordatorios y medianoche; como ahora los recordatorios coinciden con las transiciones, la alarma queda a la hora exacta (09:00, 13:00, 14:00, 18:30). Hay tests de que no se programa 09:05 ni 18:35 y de que el aviso de salida sale a las 18:30:00 y no a las 18:29:59.
- **Condiciones**: entrada sin jornada abierta; inicio de colación y salida con la jornada abierta; término de colación con jornada abierta (texto "Se vuelve a medir desde las…", sin botón) o sin ella (variante `resume`, "¿Retomar la jornada?", botón **Iniciar jornada**). La variante se decide en el momento de evaluar el evento; la condición "sin jornada abierta" no exige que se haya abierto una jornada antes ese día (no hay registro local fiable de eso y el spec la define solo por el estado de la jornada).
- **Despertar tardío**: cada evento se marca atendido la primera vez que se evalúa desde su hora (pulso, alarma o despertar), avise o no. Se avisa solo si todavía no llega la hora del **siguiente evento del día** en la lista. Consecuencia: el aviso de entrada vale hasta el inicio de la colación (antes, hasta la salida); en un día sin colación, hasta la salida. La salida no tiene evento siguiente: se avisa en el primer despertar del mismo día si la jornada sigue abierta (como antes). Al pasar la medianoche el registro empieza de nuevo y los eventos del día anterior ya no se evalúan. El "siguiente evento" es el siguiente **estrictamente posterior**: una colación que empieza a la misma hora que la entrada (válida en el editor) no oculta el aviso de entrada; con la jornada abierta sale el de colación. Una colación que termina a la hora de salida no tiene aviso de término (no se vuelve a medir): solo el de salida. Los avisos **informativos** de colación (sin botón: inicio de colación, y término con la jornada abierta) solo se envían si se evalúan dentro de los **15 minutos** siguientes a su hora (`INFO_REMINDER_WINDOW_MS`); un despertar más tarde los marca atendidos sin notificar (p. ej. a las 16:00 no sale "Se vuelve a medir desde las 14:00"; a las 14:10 sí). "¿Retomar la jornada?" (con botón), la entrada y la salida siguen la regla anterior.
- **Compatibilidad**: `tt.meta.reminders` conserva el formato `{ date, done }` con las claves `start` y `end` de la 0.2.1; se agregan `lunchStart` y `lunchEnd`. Un registro de la 0.2.1 de hoy se lee igual (no repite la entrada ya mostrada). Al actualizar a mitad del día, los eventos aún no registrados se evalúan con la regla del despertar tardío. Los ids de notificación siguen siendo `tt-reminder:<evento>:<fecha>`, así las notificaciones de la 0.2.1 que quedaron en el centro de notificaciones se siguen reconociendo.
- **Notificaciones**: `reminderText` devuelve mensaje, botón (o ninguno) y `requireInteraction` (`false` para colación, `true` para entrada y salida). Sin botón no se pasa `buttons` a `chrome.notifications.create`. Se corrigió el texto de entrada a "Tu jornada empieza a las 09:00" (antes "empezó", porque salía con la tolerancia).
- **Botones** (`App.onReminderAction`): `start` y `lunchEnd` → `startWorkDay` (comprueba sesión, aviso vigente —si falta, abre `consent.html`— y relee el horario antes de abrir el acumulador); `end` → cerrar jornada; `lunchStart` no tiene botón (si llegara un clic, abre el popup). Un aviso de otro día solo abre el popup, como antes. Si la jornada ya se retomó desde el popup, el clic no hace nada.
- **Textos**: `extension/consent.html`, `/privacidad` (`PrivacyPage.tsx`, prerender verificado por `check-build`), la ayuda de Configuración → Horario (`ScheduleEditor.tsx`: "Recordatorios de inicio, colación y cierre, a la hora exacta…" y, en la tolerancia, "No retrasa los recordatorios"), `README.md` (incluida la justificación del permiso `notifications` para la tienda y el paso de despliegue de la 0.2.2) y `extension/README.md`. `CONSENT_VERSION` no cambia.
