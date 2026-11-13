# Minuta desde el celular para personas en terreno (2026-11-13)

## Contexto

La minuta diaria (spec `2026-11-13-minuta-diaria.md`) se pedía desde la extensión
al cerrar la jornada. Lukas aclaró que las personas en terreno **no tienen
computador**, así que no tienen la extensión. Eligió una página web para el
celular (opción descartada por ahora: WhatsApp).

## Qué hace

- **`app.mipegahr.cl/terreno`** (portal, ruta pública fuera del área de administración):
  - Entra cualquier persona activa (no solo administradores), con Google o correo y contraseña.
  - Si está en un grupo de `config/org.dailyReportGroupIds` (con la minuta activa), ve un botón
    grande para grabar (hasta 4 min). El audio se convierte a WAV en el navegador
    (`recordingToWav`, ahora en `@timetracking/shared`) y va a `draftDailyReport`, la misma
    función de la extensión. La persona revisa la minuta y la envía a `dailyReports/{uid_fecha}`.
    También puede escribirla. Puede corregirla el mismo día.
  - Si no está en esos grupos: "No tienes minuta pendiente".
  - Se puede agregar a la pantalla de inicio como app "Minuta" (`terreno.webmanifest`,
    íconos en `public/terreno/`); la página muestra cómo hacerlo en Android y iPhone.
- **Recordatorio por correo** (`dailyReportReminders`, cada 15 minutos): a quien debe enviar
  la minuta, cuando terminó su horario (general o excepción personal) hace menos de 3 horas,
  no es feriado ni día libre, no tiene ausencia aprobada de día completo y aún no la envió.
  Un correo por persona y día (`dailyReportReminders/{uid_fecha}`, solo lo escribe la función;
  las reglas por defecto lo niegan a los clientes). Enlace: `PORTAL_URL` + `/terreno`
  (por defecto `https://app.mipegahr.cl`). Usa Resend como los otros correos.

## Sin cambios de reglas

Las reglas desplegadas ya permiten a una persona activa leer `config/org`, sus grupos y
escribir su propia minuta.

## Puesta en marcha

Desplegar functions (`npx firebase deploy --only functions --project prod`), que además
crea `dailyReportReminders` y pide `OPENROUTER_API_KEY` si aún no existe.

## Pendiente / ideas

- Notificaciones push en el celular (requiere Firebase Cloud Messaging y clave VAPID).
- Marcar inicio y cierre de jornada desde el celular.
- WhatsApp (nota de voz) como segunda vía.

## Oficina o terreno por persona (pedido de Lukas, mismo día)

- `users/{uid}.workplace`: `'office' | 'field'` (falta = oficina). Lo cambia un administrador en
  Colaboradores › Personas (selector "Oficina / Terreno", solo para colaboradores; nunca el propio).
  Reglas: el admin puede cambiar `role`, `status` y `workplace` de otros.
- Una persona de terreno entra por el login normal de `app.mipegahr.cl` y llega directo a su minuta
  (estado de sesión `field`). `/terreno` sigue funcionando (es el `start_url` del ícono).
- Con la minuta activa, las personas de terreno **siempre** la envían; los grupos quedan para pedírsela
  además a gente de oficina (se puede activar sin grupos). `requiresDailyReport(settings, grupos, perfil)`.
  El recordatorio por correo y `draftDailyReport` las incluyen.
- Requiere desplegar reglas (`firestore:rules`) y functions.
