# Comentarios anónimos (2026-11-13)

Pedido de Lukas: "que los colaboradores puedan dejar un comentario (anónimo) sobre algo ocurrido en su día (positivo o negativo)".

## Decisiones

- **Ajuste de empresa**, apagado por defecto: `config/org.feedbackEnabled` (opcional; el portal solo lo escribe cuando está activo, así guardar funciona con reglas antiguas). Se activa en la página nueva del portal "Comentarios" (`/comentarios`).
- **Dónde**: en el popup, una fila "¿Algo que contar de tu día?" que abre un formulario corto: "👍 Algo bueno" o "👎 Algo por mejorar" (obligatorio), texto de hasta 500 caracteres, Enviar / Cancelar. Se puede usar en cualquier momento del día, con o sin jornada abierta. El borrador sobrevive a los refrescos del popup (no a cerrarlo).
- **Uno por persona y día**. Tras enviar, la fila desaparece hasta el día siguiente.
- **Anonimato** (mismo esquema que el pulso de ánimo):
  - `feedback/{autoId}`: solo `{ week, tone, text }`. Sin uid, sin día, sin hora; el id es aleatorio. Lo leen y eliminan los admins (moderación); nadie lo edita.
  - `feedbackVotes/{uid_YYYY-Www}`: `{ uid, week, dates[] }`, los días que la persona dejó un comentario (nunca cuál). Solo la propia persona lo lee; nadie lo lista.
  - La extensión escribe ambos en un **lote**; las reglas aceptan el comentario solo si en el mismo lote el registro de la persona gana exactamente un día nuevo. Un segundo intento del mismo día es rechazado (`permission-denied`) y la cola lo descarta.
  - El portal agrupa por semana y, dentro de la semana, ordena por id (al azar), para que el orden no delate la hora.
  - Límites conocidos: Firestore guarda la hora de creación de cada documento (no la expone el SDK web, pero sí la consola/Admin SDK); el propio texto puede identificar a quien escribe (el popup lo advierte); las reglas no validan que la fecha pertenezca a la semana.
- **Sin conexión**: el comentario va por la cola persistente (`kind: 'feedback'`, uno por persona y día). Hasta subirse, el texto queda en el almacenamiento local de la extensión.
- **Portal**: interruptor, 3 tarjetas (comentarios de las últimas 4 semanas, cuántos "Algo bueno", cuántos "Algo por mejorar"), filtro Todos / Algo bueno / Algo por mejorar, y las últimas 12 semanas con sus comentarios. Cada uno tiene "Eliminar" (con confirmación).
- **Privacidad**: `/privacidad` lo explica. No cambia `CONSENT_VERSION` (es opcional y no mide nada de la jornada).

## Versiones

Extensión 0.2.27. Reglas de Firestore nuevas (`feedback`, `feedbackVotes`, campo `feedbackEnabled`): hay que desplegarlas; antes de eso el portal muestra la página sin comentarios, guardar el interruptor falla y la extensión descarta los comentarios tras 3 intentos.
