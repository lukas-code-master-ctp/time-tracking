# Spec — Ausencias justificadas

Fecha: 2026-10-22 · Solo portal y reglas (la extensión no cambia)

## Qué pidió el usuario
Poder registrar comentarios, licencias, vacaciones, trámites, etc. para justificar la ausencia parcial o completa de un trabajador.

## Decisiones
- **Quién las registra:** un admin, desde la ficha del colaborador en el portal. Las personas no las crean ni las aprueban (el portal es solo para admins); el dueño sí puede leer las suyas, para un futuro uso en la extensión.
- **Tipos:** Vacaciones, Licencia médica, Trámite, Permiso, Otro. Comentario opcional, obligatorio en "Otro" (máx. 500 caracteres).
- **Duración:** días completos (`startDate..endDate`, inclusive, hasta 366 días) o por horas dentro de un día (`startTime < endTime`).

## Datos (`absences/{autoId}`)
`uid, type, startDate, endDate, startTime|null, endTime|null, note, createdAt, createdBy, updatedAt, updatedBy`. Fechas `YYYY-MM-DD` y horas `HH:MM` en America/Santiago.
- Reglas: crear, editar y borrar solo un admin activo; al editar no cambian `uid`, `createdAt` ni `createdBy`. Lee el admin o el dueño.
- Sin índices compuestos: el portal lee por `uid ==` (ficha) o por `endDate >=` (Equipo) y filtra el resto en el cliente.
- Si las reglas aún no están desplegadas, el portal funciona sin ausencias.

## Efecto en el cumplimiento (`complianceForDay`)
- El tiempo justificado cuenta como cubierto para "Sin conexión en horario".
- Una ausencia que cubre la entrada mueve la entrada usada para el atraso a su término (saltando la colación); una que cubre la salida mueve la salida usada para la salida anticipada a su inicio.
- Un día laboral con todas sus ventanas cubiertas es `justified` y nunca `absent`. Una justificación parcial en un día sin jornada sigue siendo ausencia.
- Nuevo: `justifiedSeconds` (tiempo de horario cubierto) y `justifiedDays`. Las horas medidas y de jornada no cambian.

## Portal
- Ficha del colaborador: sección "Ausencias justificadas" (agregar, editar, eliminar), etiqueta del tipo en "Horario del día", stat "Justificado" y bloques con borde punteado en la línea de tiempo.
- Equipo: columna "Justificado" y pista en el stat "Ausencias"; CSV con "Horas justificadas" y "Días justificados".

## Despliegue
1. `npx firebase deploy --only firestore:rules --project prod` (manual).
2. Merge: el portal se publica en Vercel.

## Futuro
Que la persona solicite la ausencia desde la extensión y un admin la apruebe; que la extensión no envíe recordatorios en días justificados.
