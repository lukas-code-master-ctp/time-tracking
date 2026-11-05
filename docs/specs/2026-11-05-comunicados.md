# Comunicados internos (2026-11-05)

Pedido de Lukas: RRHH publica avisos en el portal y llegan como notificación a la extensión, con confirmación de lectura.

## Datos

- `announcements/{autoId}`: `title` (1–120), `body` (1–4000, texto plano), `authorName` (1–80, por defecto "Recursos Humanos"), `createdAt`, `createdBy` (admin), `archivedAt` (null = visible).
- `announcementReads/{announcementId_uid}`: `announcementId`, `uid`, `readAt`. Lo escribe la persona una vez; no se cambia ni se borra.

## Reglas

- `announcements`: lee cualquier persona activa. Un admin activo publica (con `archivedAt: null` y `createdBy` propio), archiva o vuelve a mostrar (solo cambia `archivedAt`) y elimina. El texto publicado no se edita.
- `announcementReads`: la persona activa crea la suya si el comunicado existe; un reenvío idéntico se acepta. La persona lee las suyas; el admin lee todas.
- Sin índices nuevos (orden por `createdAt` y filtro por `uid` usan índices de un campo).

## Extensión (0.2.14)

- Lee los últimos 30 comunicados y las confirmaciones propias con `config/org` (cada 5 min en jornada, al iniciar el worker y la jornada) y al abrir el popup si el caché tiene más de 1 min.
- Una notificación por comunicado nuevo (o "Tienes N comunicados nuevos"), una sola vez por equipo, con botón que abre el popup.
- Popup: tarjeta "Comunicado" con el más antiguo sin confirmar, "1 de N", y "Confirmo que lo leí" (en línea, sin cola).
- Archivados no se muestran. Cerrar sesión borra el caché y las notificaciones.

## Portal

- Página `/comunicados` (menú "Comunicados"): formulario con confirmación ("llegará a N personas activas"), lista con "Leído por X de Y" (Y = personas activas), panel con el texto, quién leyó (con hora) y quién falta, Archivar / Mostrar de nuevo / Eliminar.

## Fuera de alcance

Editar un comunicado publicado, destinatarios por equipo, adjuntos, historial de comunicados leídos en la extensión.
