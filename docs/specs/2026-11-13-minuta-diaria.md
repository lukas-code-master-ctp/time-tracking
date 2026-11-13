# Minuta diaria para personas en terreno (2026-11-13)

Pedido de Lukas: "que ciertos grupos puedan ingresar al fin de su jornada con un recordatorio de que manden una minuta de su día (quizás manden un audio y que con IA se transcriba y se mande la minuta)".

## Decisiones

- **Quién**: los miembros de los grupos de personas (`groups`, spec 2026-11-13-grupos-y-comunicados-agendados) que el admin elige en el portal. Ajuste de empresa en `config/org`: `dailyReportEnabled` y `dailyReportGroupIds` (1–20 grupos). El portal escribe cada campo solo cuando tiene valor (así guardar funciona con reglas antiguas).
- **Cuándo se recuerda**: tras un cierre manual de jornada (popup o botón del recordatorio de salida), una vez al día por equipo, como el pulso de ánimo. Una notificación de Chrome "Envía tu minuta del día" (botón "Escribir minuta") y una tarjeta en el popup hasta enviarla o elegir "Ahora no". Los cierres automáticos y los del tótem no avisan. El pie del popup tiene siempre el enlace "Minuta del día" para quien está en esos grupos.
- **Página `minuta.html`** de la extensión (en una pestaña: el popup se cierra al perder el foco y no puede pedir el micrófono): texto libre (máx. 4.000 caracteres) o "Grabar audio" (máx. 4 min). La grabación (WebM/Opus de MediaRecorder) se convierte en el navegador a WAV mono 16 bits a 12 kHz (≈ 5,6 MB por 4 min) porque es el formato que todos los modelos de OpenRouter aceptan.
- **IA**: OpenRouter (decisión de Lukas). La Cloud Function callable `draftDailyReport` recibe el audio, revisa que la persona esté activa y en un grupo pedido, cuenta como máximo 10 borradores por persona y día (`dailyReportDrafts/{uid_fecha}`, solo la función lo escribe) y llama a `chat/completions` con el audio como `input_audio` y un esquema JSON `{ transcript, minuta }`. Modelo por defecto `google/gemini-2.5-flash` (env `DAILY_REPORT_MODEL` para cambiarlo); secreto `OPENROUTER_API_KEY`. El audio **no se guarda**. En el emulador responde un borrador fijo.
- **Revisión humana**: el borrador aparece en el cuadro de texto; la persona lo corrige y lo envía. La transcripción se guarda junto a la minuta ("Ver transcripción del audio").
- **Datos**: `dailyReports/{uid_YYYY-MM-DD}` `{ uid, date, text, source: 'text'|'audio', transcript, createdAt, updatedAt }`. La persona lo crea y lo puede corregir hasta 24 h después de crearlo; lo leen ella y los admins; no se borra.
- **Portal**: página "Minutas" (`/minutas`) con el interruptor, los grupos y las minutas de un día (por defecto hoy, con flechas y selector de fecha): quién la envió (hora, si fue por audio, texto y transcripción) y quién no.
- **Privacidad**: `/privacidad` lo explica. No cambia `CONSENT_VERSION` (no se mide nada nuevo de la jornada; la minuta la escribe la persona).

## Costo estimado

Con Gemini 2.5 Flash por OpenRouter, un audio de 3 minutos cuesta del orden de US$0,002–0,005. 20 personas con un audio diario: unos US$2–4 al mes más la comisión de OpenRouter por carga de saldo.

## Puesta en marcha

1. Lukas crea una clave en openrouter.ai (con saldo).
2. Despliegue de reglas (lo hace el hilo tras el merge).
3. Lukas despliega las functions: `npx firebase deploy --only functions --project prod`; la primera vez pide el valor de `OPENROUTER_API_KEY` (o antes: `npx firebase functions:secrets:set OPENROUTER_API_KEY --project prod`).
4. En el portal: Colaboradores › Grupos (crear "Terreno"), luego Minutas › activar y elegir el grupo.

## Versiones

Extensión 0.2.30.
