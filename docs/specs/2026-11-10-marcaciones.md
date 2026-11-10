# Marcaciones de asistencia (tótem con RUT)

Pedido de Lukas (2026-11-10): una tabla con las entradas y salidas de cada persona, y dos formas de iniciar la jornada: el botón de la extensión (como hasta ahora) o una marcación externa, una web abierta en una tablet en la entrada de la oficina donde cada persona marca con su RUT. La empresa decide cómo marca cada persona (puede tener ambas).

## Decisiones

- **Un solo tipo de jornada.** La marca del tótem abre y cierra un documento `sessions` como el de la extensión, con `source: 'kiosk'` y `kioskId`. Así las horas, atrasos, salidas anticipadas, ausencias y el detalle del colaborador funcionan igual. El tótem solo registra asistencia: no mide actividad.
- **Sin latido.** Una jornada de tótem abierta dura hasta "ahora" para los reportes (`sessionEndAt` en `packages/shared/src/sessions.ts`) y sigue "en curso" hasta 16 h.
- **Salida olvidada.** `autoCloseStaleSessions` cierra una jornada de tótem abierta más de 16 h a la hora de salida de su horario de ese día (`forgottenExitEnd`). Sin horario ese día, se cierra en la misma entrada: 0 h y la tabla dice "No marcó salida". Si la persona marca entrada al día siguiente, la del día anterior se cierra igual antes de abrir la nueva.
- **Modo por persona** en `attendanceSettings/{uid}`: `{ rut, mode: 'extension' | 'kiosk' | 'both', updatedAt, updatedBy }`, escrito solo por un admin. Sin documento = `extension`. El RUT se guarda normalizado (`12345678-K`) y es único (el portal lo valida; la función rechaza duplicados).
  - `kiosk`: la extensión (0.2.20) no muestra "Iniciar jornada" ni recordatorios de inicio, y las reglas impiden crear `sessions` desde la extensión.
  - `both`: puede usar cualquiera. Si ya tiene una jornada abierta (de la extensión o del tótem), el tótem responde "Ya marcaste tu entrada a las…". La salida en el tótem cierra la jornada abierta de hoy, sea cual sea su origen (`closedByKioskId`).
- **Tótem autorizado por token.** En el portal (Colaboradores › Marcaciones › Tótems) un admin crea un tótem: el navegador genera un token aleatorio, guarda solo su SHA-256 como id de `kiosks/{hash}` y muestra una vez el enlace `https://app.mipegahr.cl/marcar#<token>`. Al abrirlo en la tablet, el token queda en `localStorage` y se borra de la barra de direcciones. Un tótem se puede desactivar (`revokedAt`) y no se reactiva.
- **Función `kioskPunch`** (callable, sin login, `southamerica-west1`): `{ token, rut, action: 'in' | 'out' }`. Valida el tótem, el RUT (dígito verificador), que la persona esté activa y que su modo permita el tótem, y abre o cierra la jornada en una transacción. Errores con `details.reason`: `kiosk-unknown`, `kiosk-revoked`, `rut-invalid`, `rut-unknown`, `rut-duplicated`, `user-disabled`, `kiosk-not-allowed`, `already-in`, `not-in`.

## Límites conocidos

- Con solo el RUT, alguien podría marcar por otra persona en el tótem. Una mejora posible: PIN o foto.
- Una persona con `both` que marca entrada en el tótem y además inicia la jornada en la extensión queda con dos jornadas superpuestas; el cumplimiento las une, pero "Horas" del Equipo las suma.
- El tótem no mide actividad en el computador (ver decisión pendiente con Lukas sobre activar la extensión al marcar).
