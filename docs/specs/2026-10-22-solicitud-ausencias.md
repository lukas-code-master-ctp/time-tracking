# Spec — Solicitud de ausencias desde la extensión

Fecha: 2026-10-22 · Extensión 0.2.10, portal y reglas · Sigue a [Ausencias justificadas](2026-10-22-ausencias-justificadas.md)

## Qué se decidió
Lukas eligió "Trabajador solicita, admin aprueba": la persona pide la ausencia desde la extensión, queda **pendiente**, y un admin la **aprueba** o la **rechaza** en el portal. Solo lo aprobado justifica tiempo.

## Datos
`absences/{id}` gana `status: 'pending' | 'approved' | 'rejected'`. Un documento sin `status` (los creados antes) cuenta como aprobado.
- `absenceIntervalsForDay` ignora las pendientes y rechazadas, así que el cumplimiento solo usa las aprobadas.

## Reglas
- Crear: un admin activo (como antes), o la persona activa para sí misma con `createdBy == uid == auth.uid`, `status == 'pending'` y `updatedAt == createdAt`.
- Editar (incluye aprobar o rechazar): solo un admin.
- Borrar: un admin, o la persona dueña mientras la solicitud está pendiente ("Retirar").
- Leer: el admin o la persona dueña (sin cambios).

## Extensión
- Pie del popup: enlace "Solicitar ausencia" que abre `absences.html` en una pestaña.
- La página tiene un formulario (tipo, días completos o por horas, fechas, comentario) y la lista "Mis ausencias" con su estado; las pendientes se pueden retirar.
- Mensajes al service worker: `absences.list`, `absences.request`, `absences.cancel`. Exigen sesión iniciada, cuenta habilitada y aviso aceptado; los datos se validan con `validateAbsence`.

## Portal
- Equipo: sección "Solicitudes de ausencia" con las pendientes de todos, con Aprobar y Rechazar.
- Ficha del colaborador: estado de cada ausencia, Aprobar y Rechazar en las pendientes, y "Solicitada desde la extensión". La etiqueta del día muestra "(pendiente)"; las rechazadas no se muestran en el horario del día.
- Lo que crea un admin queda aprobado de inmediato.

## Despliegue
1. Reglas: `npx firebase deploy --only firestore:rules --project prod`. Sin índices nuevos (la consulta `status == 'pending'` usa un solo campo).
2. Merge: el portal se publica en Vercel y la extensión se sube a la Chrome Web Store.
