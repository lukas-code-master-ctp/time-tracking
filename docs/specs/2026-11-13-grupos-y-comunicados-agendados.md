# Grupos de personas y comunicados programados

Pedido de Lukas (2026-11-13): "Avisos: poder agendar el aviso y asignar a grupos de personas".

## Grupos

- `groups/{autoId}`: `name` (1–60, único sin distinguir mayúsculas, lo revisa el portal), `memberUids` (1–500, sin repetidos), `createdAt/By`, `updatedAt/By`.
- Portal: **Colaboradores › Grupos** (`/colaboradores/grupos`). Crear, editar (nombre, personas con búsqueda y "Elegir todas") y eliminar. Las personas desactivadas quedan guardadas en el grupo aunque no se muestren.
- Reglas: el admin escribe; una persona activa lee solo los grupos donde está (`where('memberUids', 'array-contains', uid)`). Pensado para reutilizarse (minuta de terreno).

## Comunicados

Campos nuevos en `announcements` (faltan en los anteriores a 0.2.29):

- `publishAt`: cuándo llega a la extensión. `createdAt` si se envía ahora; una hora futura si se programa (hasta un año).
- `audience`: `['*']` (todo el equipo) o los uids de los grupos elegidos, copiados al guardar (máx. 500).
- `groupIds`: los grupos elegidos (`[]` = todo el equipo), para mostrarlos en el portal.

Portal (`/comunicados`):

- "Para quién": Todo el equipo / Algunos grupos (chips con el número de personas activas). "Cuándo": Enviar ahora / Programar (`datetime-local`, por defecto mañana 9:00).
- Sección **Programados**: editar (texto, hora, grupos), "Enviar ahora" y eliminar. Una vez enviado ya no se edita (solo archivar o eliminar), como antes.
- "Leído por X de Y" cuenta solo a los destinatarios activos.
- Al guardar un grupo, los comunicados programados a ese grupo copian de nuevo sus miembros. Los ya enviados no cambian.
- Al abrir la página, los comunicados antiguos reciben `publishAt = createdAt`, `audience = ['*']`, `groupIds = []` (una vez; la regla solo permite exactamente eso).

Extensión 0.2.29:

- Lee `where('audience', 'array-contains-any', ['*', uid]) orderBy('publishAt', 'desc') limit 30` (índice compuesto nuevo).
- Guarda los programados en el caché pero no los muestra ni notifica hasta su `publishAt`. Cada refresco (cada 5 minutos) revisa el caché aunque no vuelva a leer Firestore, así que llegan con hasta ~5 minutos de atraso.

Reglas:

- Lee un comunicado el admin, o una persona activa si `audience` tiene `'*'` o su uid. Sin `audience` (antiguos) solo el admin, hasta que el portal lo actualice: un respaldo para el campo faltante hacía que las reglas aceptaran consultas sin filtro.
- La consulta de las extensiones anteriores a 0.2.29 (sin filtro) queda rechazada: no ven comunicados hasta actualizarse, en vez de mostrar uno programado antes de tiempo o uno de otro grupo.
- Editar solo mientras `publishAt` es futuro (hora del servidor), y `publishAt >= createdAt` siempre.

Límite: la programación la cumple la extensión (no hay función en el servidor), y la regla de lectura no oculta el comunicado antes de su hora: alguien con acceso a la consola podría leerlo antes. Para avisos sensibles conviene enviarlos a la hora.
