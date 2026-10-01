# Spec — Login en navegadores Chromium distintos de Chrome

Fecha: 2026-10-01 · Complementa `2026-09-29-time-tracking-extension.md`

## Problema
`chrome.identity.getAuthToken` solo existe en Google Chrome. En Edge, Brave, Opera, Vivaldi y Arc la extensión se instala, pero el login falla.

## Solución
Un login alternativo con **`chrome.identity.launchWebAuthFlow`**, que sí existe en esos navegadores:
- Abre la ventana de cuentas de Google (OAuth 2.0, flujo implícito OpenID Connect):
  - `response_type=id_token`, `scope=openid email profile`, `prompt=select_account`;
  - `nonce` aleatorio por intento, que se verifica en el `id_token` recibido;
  - `redirect_uri = chrome.identity.getRedirectURL()`, es decir `https://<id-extensión>.chromiumapp.org/`.
- Usa el **cliente OAuth web que Firebase ya creó** para el proveedor Google (`VITE_GOOGLE_WEB_CLIENT_ID`). Como es el mismo cliente del proveedor, Firebase acepta el `id_token` sin configuración extra. En Google Cloud hay que agregar la redirect URI `https://egaklokkbnbnccnjicaahaifnkaeobfj.chromiumapp.org/` a ese cliente.
- Con el token: `GoogleAuthProvider.credential(idToken)` → `signInWithCredential` → `joinOrg`, igual que hoy.
- **Elección del método:**
  - si `getAuthToken` existe y funciona, se usa ese (Chrome, sin cambios);
  - si no existe, o falla por cualquier motivo que no sea una cancelación del usuario (función no soportada, perfil de Chrome sin cuenta Google, error de configuración OAuth como "Invalid OAuth2 Client ID", error desconocido), se usa `launchWebAuthFlow`. Los errores posteriores a `getAuthToken` (Firebase, red) no cambian de método.
  - Si el método alternativo también falla, el mensaje incluye entre paréntesis el texto técnico original de `getAuthToken`. Sin `VITE_GOOGLE_WEB_CLIENT_ID`, Chrome muestra su propio error (con ese texto) y los demás navegadores "Este navegador no es compatible todavía: usa Google Chrome".
  - Si el usuario cancela en cualquiera de los dos, no se reintenta con el otro.
- Si hay **un solo dominio permitido**, se envía `hd`. Con dos, no, y `joinOrg` sigue rechazando cuentas fuera de los dominios.
- **Cerrar sesión:** se cierra la sesión de Firebase. Con `launchWebAuthFlow` no hay token en caché de Chrome que borrar.
- **Sesión:** Firebase Auth (persistencia IndexedDB) renueva solo su sesión. El `id_token` de Google solo sirve para el primer ingreso. No hace falta guardar tokens de Google.

## Popup
Mismo botón "Iniciar sesión con Google". Si se usa el método alternativo, se abre la ventana de Google para elegir la cuenta, con la ayuda "Elige tu cuenta de la empresa".

Fuera de Chrome el popup se cierra al abrirse la ventana de Google y no recibe la respuesta. Por eso el service worker guarda el resultado del último intento en `chrome.storage.session` (`tt.signInResult`: `{ at, ok, message }`, con el mensaje en español y nunca un token). El popup lo muestra una vez al reabrirse (error en rojo o "Sesión iniciada como …"), abre el aviso si el ingreso lo pide y pide borrarlo con `auth.clearSignInResult`. Un intento nuevo y cerrar sesión también lo borran. Mientras la ventana de Google está abierta, el worker se mantiene vivo con una llamada trivial a la API cada 20 s (MV3 lo detiene tras 30 s sin eventos).

Nota de seguridad: no se envía `state`. El `nonce` ya liga el `id_token` (firmado por Google) a este intento, y `launchWebAuthFlow` solo devuelve la redirección de la ventana que abrió esta extensión, así que no hay un callback web donde se pueda inyectar una respuesta. Firebase valida firma, emisor, vencimiento y audiencia del `id_token`.

## Configuración y despliegue
- Variable nueva `VITE_GOOGLE_WEB_CLIENT_ID`, que va en `.env.production.local` y en la documentación. Si falta, el método alternativo muestra "Este navegador no es compatible todavía: usa Google Chrome".
- Extensión **0.2.1**. Hay que subirla a la tienda cuando se apruebe la 0.2.0, o cancelar esa revisión y enviar la 0.2.1.
- El README documenta los navegadores compatibles y cómo instalar desde Chrome Web Store en Edge ("Permitir extensiones de otras tiendas") y en Opera (complemento "Install Chrome Extensions").

## Criterios de aceptación
1. En Chrome el flujo no cambia: `getAuthToken`.
2. Sin `getAuthToken` (navegador simulado) se usa `launchWebAuthFlow` con los parámetros correctos, y el `nonce` se verifica.
3. Un `id_token` con `nonce` distinto, una respuesta con `error` o una cancelación dan un mensaje claro y no inician sesión.
4. Tests, typecheck, build y e2e en verde.
5. Prueba manual en Edge o Brave, que hace el usuario: inicia sesión, mide y aparece en el portal.
