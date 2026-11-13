# Videos de la empresa en la pausa activa

Pedido de Lukas (2026-11-13): "Pausa activa: poder anclar videos personalizados".

## Qué hace

- En el portal, página **Pausa activa**, sección **Videos de la empresa**: el admin agrega hasta 10 videos (nombre + enlace https: YouTube, Vimeo, Google Drive, intranet…), los ordena y los quita. Se guardan con "Guardar cambios".
- **Cuándo mostrarlos** (decisión tomada por Claude, se puede cambiar): los videos **complementan** la biblioteca de 56 ejercicios.
  - `alternate` (por defecto): una pausa video, la siguiente ejercicio. Los ejercicios siguen recorriendo la biblioteca completa (a la mitad de velocidad).
  - `always`: todas las pausas son video, en el orden de la lista.
  - Con "Veces al día" y "A horas fijas" el plan sigue siendo el mismo para todos, y el portal lo muestra en "Plan de pausas".
- En la extensión, la pausa con video muestra la miniatura (solo YouTube tiene una pública) y "Ver video": se abre en una **pestaña nueva**. YouTube no reproduce videos incrustados en páginas de extensión (exige un referrer), y así también funcionan Vimeo, Drive y enlaces propios. Hacer clic en la notificación abre el video directamente. La pausa sigue pendiente para marcar "Tomé la pausa" o "En 10 min".

## Datos

- `config/breakVideos`: `{ videos: { id, title, url }[] (0–10), mode: 'alternate' | 'always', updatedAt, updatedBy }`. Lo escriben los admins y lo leen los miembros activos. Es un documento aparte porque validar 10 videos dentro de `config/org` (junto con los dominios) supera el límite de 1000 expresiones por solicitud de las reglas.
- `breaks/{id}.exercise` guarda `video:<id>` en las pausas con video. La línea de tiempo del portal lo muestra como "Video de la empresa".
- La extensión lee `config/breakVideos` junto con `config/org`. Si no puede leerlo, mantiene los videos que tenía.

## Versión

Extensión 0.2.31. Reglas nuevas (`config/breakVideos`): hay que desplegarlas. Antes de eso el portal no puede guardar videos (el resto de la configuración se guarda igual) y la extensión sigue solo con ejercicios.
