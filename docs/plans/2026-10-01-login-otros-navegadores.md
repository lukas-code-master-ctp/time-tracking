# Plan — Login en otros navegadores Chromium

Spec: `docs/specs/2026-10-01-login-otros-navegadores.md`.

1. **Configuración en Google Cloud** (lo hago yo con Chrome): agregar la redirect URI `https://egaklokkbnbnccnjicaahaifnkaeobfj.chromiumapp.org/` al cliente web del proveedor Google y anotar su client ID en `extension/.env.production.local` (`VITE_GOOGLE_WEB_CLIENT_ID`).
2. **Implementación** (subagente):
   - `extension/src/background/auth.ts`: selección del método, `launchWebAuthFlow` con `nonce` y lectura del `id_token` desde el fragmento de la URL, verificación del `nonce` y errores en español;
   - variable de entorno, manifest sin cambios de permisos;
   - versión 0.2.1;
   - tests con mocks de `chrome.identity`;
   - README y `extension/README.md`.
3. **Revisión** (otro subagente).
4. **Verificación**: typecheck, test, test:emulator, build:qa, build prod con `--out-dir`, e2e:extension. Generar el `.zip` 0.2.1.
5. **Revisión y mejora** (subagente): resultado del último intento en `chrome.storage.session` mostrado al reabrir el popup, worker vivo durante la ventana de Google, token vacío de `getAuthToken` como fallo (no cancelación), `getRedirectURL` dentro del manejo de errores. Tests y verificación completa.
