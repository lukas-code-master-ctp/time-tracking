# Spec — Varios dominios permitidos

Fecha: 2026-09-29 · Complementa `2026-09-29-time-tracking-extension.md`

## Contexto
El admin inicial es `lukas@impulseai.cl` y el equipo usa `@compratuparcela.cl`: dos organizaciones de Google Workspace distintas. Hoy el sistema admite un solo `allowedDomain`.

## Cambio
- `config/org.allowedDomain: string` se reemplaza por **`allowedDomains: string[]`** (1–10 dominios, normalizados en minúsculas, sin `@`, sin duplicados). No hay datos en producción: no se necesita migración, pero la lectura debe tolerar docs antiguos con `allowedDomain` (se leen como `[allowedDomain]`) para no romper emuladores con datos persistidos.
- Variable `ALLOWED_DOMAIN` (functions) y `VITE_ALLOWED_DOMAIN` (portal/extensión) aceptan **lista separada por comas**. Se mantienen los nombres. Default: `impulseai.cl,compratuparcela.cl`.
- `BOOTSTRAP_ADMINS` por defecto en el proyecto demo: `lukas@impulseai.cl` (reemplaza a `jefa@compratuparcela.cl` en emuladores, seed y e2e).
- `isAllowedEmail(email, domains: string | string[])`: coincidencia exacta con alguno (sigue rechazando subdominios y parecidos).
- `joinOrg`: valida contra `allowedDomains`. Mensaje de dominio: "Usa tu cuenta de la empresa (@impulseai.cl o @compratuparcela.cl)".
- Reglas Firestore: `config/org` exige `allowedDomains` lista de 1–10 strings en vez de `allowedDomain`; mismos 6 campos. La lista debe incluir el dominio del correo del propio admin que escribe (`users/{uid}.email`), para que no se deje fuera por error (también lo impide el portal).
- Portal:
  - Configuración: editor de lista de dominios (agregar/quitar, con advertencia al cambiar; no permite quitar el dominio del propio admin ni dejar la lista vacía).
  - Invitaciones: valida contra cualquiera de los dominios; el placeholder/ayuda los muestra.
  - Login prod: `signInWithPopup` sin `hd` fijo si hay más de un dominio (con uno solo, se mantiene `hd`).
- Extensión: mensajes de error de dominio con la lista.
- Seed: colaboradores de ejemplo en ambos dominios.

## Despliegue (README)
- Pantalla de consentimiento OAuth **Externa** (Interna solo admite la organización dueña del proyecto) y publicada en producción; con solo `openid email profile` no requiere verificación de Google.
- Chrome Web Store: **No listada** (no "Privada", que se limita a un dominio).
- Instalación forzada: se configura **en la consola de Workspace de cada organización**.
- Ejemplo `functions/.env.<proyecto>`: `ALLOWED_DOMAIN=impulseai.cl,compratuparcela.cl`, `BOOTSTRAP_ADMINS=lukas@impulseai.cl`.

## Criterios de aceptación
1. `x@impulseai.cl` y `y@compratuparcela.cl` invitados pueden entrar; `z@gmail.com` y `a@sub.impulseai.cl` no.
2. `lukas@impulseai.cl` entra como admin sin invitación en emuladores.
3. El admin puede editar la lista de dominios; las reglas rechazan lista vacía, >10 o tipos inválidos.
4. Todos los tests, typecheck, build y e2e en verde.
