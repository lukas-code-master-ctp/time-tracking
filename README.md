# Registro de jornada y actividad

Herramienta interna, al estilo de Hubstaff pero más simple, para un equipo de unas 30 personas que trabaja con Google Workspace. Admite **varios dominios de Workspace** (hoy `@impulseai.cl` y `@compratuparcela.cl`, dos organizaciones distintas); la lista se edita en el portal (Configuración).

- La persona **admin** invita a los colaboradores por correo desde un **portal web**.
- Cada **colaborador** instala una **extensión de Chrome**, entra con su cuenta de la empresa y **abre y cierra su jornada**.
- Mientras la jornada está abierta, la extensión mide el nivel de actividad, los sitios usados y, si está activado, toma capturas de la pestaña visible.
- La persona admin ve todo en la **reportería del portal**: horas, % de actividad, sitios, línea de tiempo y capturas.

Documentos de diseño: [spec](docs/specs/2026-09-29-time-tracking-extension.md) · [plan](docs/plans/2026-09-29-time-tracking-extension.md) · [spec de varios dominios](docs/specs/2026-09-29-multi-dominio.md) · [detalles de la extensión](extension/README.md).

## Qué mide (y qué NO)

Solo mide **con la jornada iniciada** y con sesión iniciada en la extensión. Todo se agrupa en bloques de 10 minutos.

| Mide | NO mide |
|---|---|
| **Nivel de actividad**: % de segundos con uso de teclado o mouse (solo el *hecho* de que hubo uso). Fuera de Chrome usa el estado de inactividad del sistema (`chrome.idle`). | **Qué teclas** presionas, qué escribes, contraseñas, contenido de formularios ni de las páginas. |
| **Sitios**: tiempo por dominio y por URL de la pestaña activa, **sin parámetros ni `#`** (se descartan para no guardar datos sensibles). Hasta 20 URL por bloque. | El historial completo, pestañas en segundo plano, pestañas de **incógnito**. |
| **Tiempo fuera de Chrome**: cuando ninguna ventana de Chrome está enfocada. | **Qué** programa usas fuera de Chrome (Word, Excel, WhatsApp de escritorio…): solo se sabe que estuviste "fuera de Chrome". |
| **Capturas** (opcional, lo decide la admin): 1 por bloque de 10 min, en un instante al azar, **solo de la pestaña visible**, reducidas a ≤ 1280 px y **difuminadas en el computador** antes de subirlas (si el difuminado está activo). | La pantalla completa, otras ventanas, micrófono, cámara ni ubicación. Nada fuera de la jornada. |

La primera vez, la extensión muestra un **aviso** que explica esto y el colaborador debe aceptarlo. Durante la jornada el ícono muestra la insignia **ON** y el popup dice qué se está midiendo.

## Arquitectura

```
 Colaborador (Chrome)                      Google Cloud / Firebase                        Admin (navegador)
┌──────────────────────┐   Auth (Google)  ┌──────────────────────────────┐   Auth (Google) ┌──────────────────┐
│ Extensión MV3        │ ───────────────▶ │ Firebase Auth                │ ◀────────────── │ Portal React     │
│  - service worker    │   joinOrg        │ Cloud Functions (Santiago)   │   joinOrg       │ (Firebase        │
│  - content script    │ ───────────────▶ │  joinOrg · correo invitación │ ◀────────────── │  Hosting)        │
│  - popup / aviso     │   sessions,      │  purga capturas · auto-cierre│                 │  - Equipo        │
│                      │   activity       │ Firestore (reglas)           │   lectura       │  - Colaborador   │
│  cola offline en     │ ───────────────▶ │  config · invitations · users│ ──────────────▶ │  - Invitaciones  │
│  chrome.storage      │   capturas JPEG  │  sessions · activity ·       │   config,       │  - Colaboradores │
│                      │ ───────────────▶ │  screenshots                 │   invitaciones  │  - Configuración │
└──────────────────────┘                  │ Cloud Storage (capturas)     │ ◀────────────── └──────────────────┘
                                          └──────────────────────────────┘
                                                 │ correo (SMTP) ──▶ colaborador invitado
```

- **Sin servidor propio**: la extensión y el portal escriben/leen Firestore y Storage directamente; las **reglas de seguridad** deciden qué puede hacer cada uno (un colaborador solo escribe y lee lo suyo; nadie cambia su propio rol).
- **Cloud Functions** (región `southamerica-west1`): `joinOrg` (alta al primer login: valida dominio + invitación o admin inicial), `onInvitationWritten` (envía el correo de invitación), `purgeOldScreenshots` (diaria, borra capturas más antiguas que la retención) y `autoCloseStaleSessions` (cada hora, cierra jornadas sin señal hace más de 30 min o abiertas más de 16 h).
- Todos los tiempos se guardan como milisegundos epoch; los días se calculan en hora de Chile (`America/Santiago`).

## Estructura del repositorio

```
packages/shared/   tipos, bloques de 10 min, acumulador de actividad, reportes, CSV (TypeScript)
extension/         extensión de Chrome MV3 (Vite); build dev → dist-dev, prod → dist
portal/            portal de administración (React + Vite) → portal/dist (Hosting)
functions/         Cloud Functions (Node 22, esbuild → functions/lib)
tests/rules/       tests de firestore.rules y storage.rules contra el emulador
scripts/           seed, e2e integrado, arranque de emuladores y helpers comunes (scripts/lib)
docs/              spec y plan
firebase.json      Firestore, Storage, Functions, Hosting y puertos de emuladores
firestore.rules · storage.rules · firestore.indexes.json
```

## Requisitos

- **Node.js ≥ 22.18** (probado con Node 24) y npm.
- **Java 11+** (lo usa el emulador de Firestore).
- **Google Chrome** para usar la extensión a mano.
- Para los tests de navegador: **Chromium de Playwright** (`npx playwright install chromium`). Google Chrome de marca ignora `--load-extension` desde la v137, por eso los scripts usan Chromium. También puedes indicar otro con la variable `SMOKE_CHROMIUM` (en PowerShell: `$env:SMOKE_CHROMIUM="C:\ruta\chrome.exe"` antes del comando).
- Firebase CLI: viene como dependencia (`npx firebase …`); no hace falta instalarla global.

## Correr en local

Todo corre contra los **emuladores de Firebase** del proyecto demo `demo-timetracking` (no toca ningún proyecto real). Con la configuración dev, el login es un **correo simulado** (botón "Entrar (emulador)").

Abre una terminal (PowerShell en Windows) en la carpeta del proyecto para cada paso marcado como "Terminal"; las que quedan corriendo se detienen con Ctrl+C.

```bash
npm install
npx playwright install chromium        # solo la primera vez (tests de navegador y capturas del seed)

# Terminal 1: emuladores (Auth, Firestore, Functions, Storage + UI en http://127.0.0.1:4000)
npm run emulators                      # datos en blanco en cada arranque
# o bien
npm run emulators:persist              # importa .emulator-data/ si existe y la guarda al salir (Ctrl+C)

# Terminal 2: datos de ejemplo
npm run seed

# Terminal 3: portal dev → http://127.0.0.1:5173
npm run dev -w portal
```

`npm run seed` crea (y puede correrse varias veces; reemplaza los datos de los colaboradores de ejemplo):

- Admin inicial **`lukas@impulseai.cl`** (está en `BOOTSTRAP_ADMINS` de `functions/.env.demo-timetracking`, que también define `ALLOWED_DOMAIN=impulseai.cl,compratuparcela.cl`).
- 3 colaboradores de ambos dominios con invitación aceptada y aviso aceptado: `ana.rojas@compratuparcela.cl` (con una **jornada abierta ahora**), `beto.diaz@compratuparcela.cl`, `carla.soto@impulseai.cl`; y 1 invitación pendiente: `diego.munoz@impulseai.cl`.
- `config/org` con los dos dominios y capturas difuminadas activas (solo si no existe: si ya cambiaste la configuración en el portal, se respeta).
- Jornadas de los últimos 7 días hábiles en horario laboral de Chile (con pausa de almuerzo, un día libre y un cierre automático), actividad variable, sitios típicos (`mail.google.com`, `docs.google.com`, `sheets.google.com`, `drive.google.com`, `calendar.google.com`, `meet.google.com`…), tiempo fuera de Chrome y unas 20 capturas de ejemplo difuminadas en Storage.

El seed y los e2e **se niegan a correr** si las variables `*_EMULATOR_HOST` no apuntan a este computador o si el proyecto no es `demo-timetracking`: nunca escriben en un proyecto real.

Las cuentas se crean con el mismo token simulado que el login dev, así que puedes entrar como cualquiera de ellas en el portal o en la extensión. La jornada abierta de Ana se ve "En jornada" durante unos 30 minutos (después su último latido queda viejo); vuelve a correr `npm run seed` si la necesitas.

### Cargar la extensión dev en Chrome

1. `npm run build:dev -w extension` (o `npm run dev -w extension` para recompilar al guardar) → genera `extension/dist-dev`.
2. En Chrome abre `chrome://extensions`, activa **Modo desarrollador** (arriba a la derecha) → **Cargar descomprimida** → elige la carpeta `extension/dist-dev`.
   - La carga manual sí funciona en Chrome de marca; lo que Chrome ≥ 137 ignora es el flag `--load-extension` de la línea de comandos.
   - El build dev tiene una clave fija: su ID es siempre `klmbbjhphdmmicdbbgkofkpgapcinbmd`.
3. Con los emuladores arriba, abre el popup, escribe un correo invitado (por ejemplo `ana.rojas@compratuparcela.cl` después del seed, o uno que invites desde el portal) y pulsa **Entrar (emulador)**. Acepta el aviso e inicia la jornada.

## Cómo probar

| Script (raíz) | Qué hace |
|---|---|
| `npm run typecheck` | TypeScript estricto en todos los paquetes (incluye `scripts/`). |
| `npm test` | Tests unitarios (Vitest): shared, extensión, portal, functions y generador del seed. |
| `npm run test:emulator` | Reglas de Firestore/Storage, Cloud Functions y subida a Storage contra emuladores reales (`firebase emulators:exec`). |
| `npm run build` | Builds de producción: shared, extensión (`extension/dist`), portal (`portal/dist`), functions (`functions/lib`). Falla si el build prod contiene código dev. |
| `npm run e2e:extension` | Extensión dev en Chromium contra emuladores: login dev → aviso → jornada → captura difuminada → cierre; verifica Firestore y Storage. |
| `npm run e2e:portal` | Portal dev en Chromium con datos sembrados: tabla del equipo, detalle, lightbox, invitación, rol, configuración, CSV; capturas de pantalla en `%TEMP%/timetracking-portal-shots`. |
| `npm run e2e` | **Flujo completo en el orden real**: la admin activa capturas e invita desde el portal (UI) → el colaborador entra en la extensión, acepta el aviso, trabaja ~70 s en una página local, se fuerza una captura y cierra la jornada → la admin ve al colaborador con horas > 0, su actividad y su captura en el detalle. |
| `npm run seed` | Datos de ejemplo (con los emuladores ya levantados). |
| `npm run emulators` / `npm run emulators:persist` | Levanta los emuladores (sin / con datos persistentes en `.emulator-data/`, ignorada por git). |

Los tres `e2e*` levantan y apagan sus propios emuladores: no los corras con `npm run emulators` abierto (usan los mismos puertos).

## Despliegue paso a paso

> Desplegar crea recursos con costo en tu cuenta de Google Cloud. Revisa cada paso.

### 1. Proyecto de Firebase

1. Con una cuenta de la empresa (por ejemplo `lukas@impulseai.cl`, para que el proyecto quede dentro de una de las organizaciones de Google Workspace), en [console.firebase.google.com](https://console.firebase.google.com) crea un proyecto (por ejemplo `registro-jornada-cp`). Anota el **ID del proyecto**.
2. Cámbialo al plan **Blaze** (pago por uso): Cloud Functions y Cloud Storage lo exigen. Configura una **alerta de presupuesto** (p. ej. USD 10) en Google Cloud → Facturación → Presupuestos.
3. **Firestore Database** → Crear base de datos → modo producción → ubicación **`southamerica-west1` (Santiago)**. La ubicación no se puede cambiar después y debe ser esa: las Cloud Functions corren en `southamerica-west1` y el disparador de Firestore del correo de invitación (`onInvitationWritten`) no se despliega si la base está en otra región.
4. **Storage** → Comenzar → misma ubicación si está disponible (si no, la más cercana).
5. **Authentication** → Comenzar → Método de acceso → **Google: habilitar**. En **Configuración → Dominios autorizados** confirma que están `<proyecto>.web.app` y `<proyecto>.firebaseapp.com` (y agrega tu dominio propio si vas a usar uno en Hosting, o el de Vercel si alojas ahí el portal: ver paso 7b).
6. **Configuración del proyecto → Tus apps → Agregar app web** (sin Hosting todavía). Copia los valores de configuración (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `appId`, `messagingSenderId`). No son secretos.
7. En este repo, apunta la CLI al proyecto: `npx firebase login` y `npx firebase use --add <ID del proyecto>`.

### 2. Pantalla de consentimiento OAuth

En [Google Cloud Console](https://console.cloud.google.com) (mismo proyecto) → **APIs y servicios → Pantalla de consentimiento de OAuth** (en la consola nueva: **Google Auth Platform → Público / Branding**):

1. Tipo de usuario **Externo**. **Interno** no sirve aquí: solo admite cuentas de la organización de Google Workspace dueña del proyecto, y el equipo usa dos organizaciones distintas (`@impulseai.cl` y `@compratuparcela.cl`). Quién puede entrar de verdad lo deciden `joinOrg` y la lista de dominios permitidos, no esta pantalla.
2. Nombre de la app, correo de soporte, correo de contacto del desarrollador y solo los scopes básicos `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
3. **Publica la app** (estado de publicación **En producción**, botón "Publicar app"). Si queda en **Prueba**, solo pueden entrar los usuarios de prueba que agregues a mano (máximo 100) y las autorizaciones caducan cada pocos días.
4. Con solo esos scopes básicos (no sensibles), Google normalmente **no exige verificación** de la app para publicarla; a lo sumo puede pedir verificar la marca (nombre, logo, dominio) si agregas un logo o enlaces. Si la consola muestra un aviso de verificación, revisa qué dato lo provoca antes de seguir. Las políticas de Google cambian: confirma lo que muestre la consola en ese momento.

### 3. Publicar la extensión (no listada) para obtener su ID

1. Crea una cuenta de desarrollador de Chrome Web Store (pago único de USD 5), idealmente con una cuenta de la empresa.
2. Rellena `extension/.env.production` (o `extension/.env.production.local`, que no se versiona) con los valores de la app web del paso 1.6. Deja `VITE_OAUTH_CLIENT_ID` vacío por ahora.
3. `npm run build -w extension` → comprime el **contenido** de `extension/dist` en un .zip y súbelo en el [panel de desarrollador](https://chrome.google.com/webstore/devconsole) como ítem nuevo. Visibilidad: **No listada** (solo la encuentra quien tiene el enlace). No uses **Privada**: se limita a los usuarios de un solo dominio (o a testers con correo), y aquí hay dos organizaciones. Completa la ficha y la justificación de permisos (`tabs`, `idle`, `alarms`, `storage`, `unlimitedStorage`, `identity`, `scripting` y acceso a `<all_urls>`: medir la pestaña activa, guardar la cola sin conexión y capturar la pestaña visible).
4. Anota el **ID del ítem** (32 letras) y el **enlace de la ficha** (`https://chromewebstore.google.com/detail/.../<ID>`).

### 4. Cliente OAuth de la extensión

1. Google Cloud → **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth → tipo "Extensión de Chrome"**, con el **ID del ítem** del paso 3. Créalo en el **mismo proyecto** de Firebase (si no, agrégalo en Firebase Auth → Google → *Safelist client IDs from external projects*).
2. Pon el ID de cliente en `VITE_OAUTH_CLIENT_ID` de `extension/.env.production`, vuelve a correr `npm run build -w extension` y sube la nueva versión. Chrome Web Store exige un número de versión mayor en cada subida: súbelo en `"version"` de `extension/package.json` (el manifest se genera desde ahí) antes de compilar. Detalles y notas en [extension/README.md](extension/README.md#login-con-google-en-producción-checklist).

### 5. Configuración del portal y de functions

- `portal/.env.production` (o `.env.production.local`): los mismos valores de la app web, `VITE_ALLOWED_DOMAIN=impulseai.cl,compratuparcela.cl` y `VITE_EXTENSION_INSTALL_URL=<enlace de la ficha>`. Mientras el enlace sea un placeholder, la página Invitaciones muestra un aviso. Con más de un dominio, el login del portal no fija `hd` (el selector de cuentas de Google muestra todas); con uno solo, lo usa como sugerencia.
- `extension/.env.production`: `VITE_ALLOWED_DOMAIN` es opcional (solo cambia los mensajes; por defecto `impulseai.cl,compratuparcela.cl`).
- Crea `functions/.env.<ID del proyecto>` (no se versiona):

  ```
  ALLOWED_DOMAIN=impulseai.cl,compratuparcela.cl
  BOOTSTRAP_ADMINS=lukas@impulseai.cl
  EXTENSION_INSTALL_URL=https://chromewebstore.google.com/detail/.../<ID>
  ```

  - `ALLOWED_DOMAIN`: dominios permitidos separados por coma (de 1 a 10, sin `@`). Se usan hasta que exista `config/org`; el primer admin la crea con esta lista y desde entonces manda la lista de **Configuración → Dominios permitidos** del portal. Solo se aceptan correos exactos de esos dominios (no subdominios como `@sub.impulseai.cl`).
  - `BOOTSTRAP_ADMINS`: correos (separados por coma) que quedan como admin en su primer login sin invitación. Deben ser de un dominio permitido.

### 6. Secretos SMTP (correo de invitación)

Son **obligatorios para desplegar** (la función de invitación los declara). Opciones recomendadas:

- Una cuenta de Workspace dedicada (p. ej. `no-responder@compratuparcela.cl`) con verificación en dos pasos y una **contraseña de aplicación**: host `smtp.gmail.com`, puerto `465`.
- O el **SMTP relay** de Google Workspace (Consola de administración → Gmail → Enrutamiento → Servicio de relay SMTP): host `smtp-relay.gmail.com`, puerto `465` o `587`.

```bash
npx firebase functions:secrets:set SMTP_HOST     # smtp.gmail.com
npx firebase functions:secrets:set SMTP_PORT     # 465
npx firebase functions:secrets:set SMTP_USER     # no-responder@compratuparcela.cl
npx firebase functions:secrets:set SMTP_PASS     # contraseña de aplicación
npx firebase functions:secrets:set SMTP_FROM     # "Registro de jornada <no-responder@compratuparcela.cl>"
```

Aunque el correo falle, el portal permite **copiar el enlace de instalación** para enviarlo por otro medio.

### 7. Desplegar

```bash
npm run typecheck && npm test && npm run test:emulator && npm run build
npx firebase deploy --only firestore,storage,functions,hosting
```

El portal queda en `https://<proyecto>.web.app`. Entra con la cuenta de `BOOTSTRAP_ADMINS`, revisa **Configuración** (capturas sí/no, difuminado, retención y dominios permitidos) e invita al equipo (correos de cualquiera de los dominios de la lista).

### 7b. Alternativa: portal en Vercel en vez de Firebase Hosting

Vercel solo aloja el **portal**. Firebase (pasos 1, 5, 6 y 7 sin `hosting`) y la extensión (pasos 3 y 4) siguen siendo necesarios.

1. Despliega en Firebase todo menos el portal:

   ```bash
   npx firebase deploy --only firestore,storage,functions
   ```

2. En [vercel.com](https://vercel.com) → **Add New → Project** → importa `lukas-code-master-ctp/time-tracking`.
   - **Root Directory**: déjalo en la raíz del repo (no `portal`): el portal usa `packages/shared`.
   - Framework, instalación, build y carpeta de salida ya vienen en [`vercel.json`](vercel.json) (`npm ci`, `npm run build -w portal`, `portal/dist`, y la redirección de todas las rutas a `index.html`). No los cambies en el panel.
   - **Node.js Version** (Settings → General): 22.x o superior.
3. **Settings → Environment Variables** (entorno *Production*, y *Preview* si usarás vistas previas), con los valores de la app web del paso 1.6:

   | Variable | Valor |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` (`<proyecto>.firebaseapp.com`) |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
   | `VITE_FIREBASE_APP_ID` | `appId` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `VITE_ALLOWED_DOMAIN` | `impulseai.cl,compratuparcela.cl` |
   | `VITE_EXTENSION_INSTALL_URL` | enlace de la ficha de Chrome Web Store |

   Estas variables tienen prioridad sobre `portal/.env.production`, así que no hace falta versionar los valores reales (el repo es público). Si cambias una variable, vuelve a desplegar (**Deployments → Redeploy**): Vite las incrusta al compilar.
4. **Firebase → Authentication → Configuración → Dominios autorizados** → agrega el dominio de Vercel (`<tu-proyecto>.vercel.app` y tu dominio propio si configuras uno). Sin esto, "Iniciar sesión con Google" falla con `auth/unauthorized-domain`. Las vistas previas de Vercel usan otros dominios (`…-git-rama-….vercel.app`): agrégalos solo si necesitas iniciar sesión en ellas.
5. Despliega (**Deploy**). Cada push a `main` vuelve a publicar el portal. Los cambios en `firestore.rules`, `storage.rules` o `functions/` **no** se publican con Vercel: para esos corre `npx firebase deploy --only firestore,storage,functions`.

### 8. Instalación forzada en Google Workspace (en cada organización)

Cada organización de Google Workspace tiene su propia consola de administración, así que esto se hace **dos veces**: una con un admin de `impulseai.cl` y otra con un admin de `compratuparcela.cl` (y en cada organización que agregues después a la lista de dominios).

En [admin.google.com](https://admin.google.com) de esa organización → **Dispositivos → Chrome → Apps y extensiones → Usuarios y navegadores** → elige la unidad organizativa → **+ → Agregar desde Chrome Web Store** (o "Agregar app o extensión de Chrome por ID") con el ID del ítem → política **Forzar instalación**. Una extensión **no listada** se puede forzar por ID desde cualquier organización. Así se instala sola en los perfiles de Chrome con cuenta de la empresa, no se puede desinstalar y se actualiza sola. Recomendado: impedir perfiles personales o exigir inicio de sesión en Chrome con la cuenta de la empresa (la extensión usa la cuenta del perfil).

### Costos estimados (30 personas)

- **Chrome Web Store**: USD 5 una vez.
- **Firebase (Blaze)**: del orden de **USD 0–5/mes**. Escrituras: el bloque en curso y el latido cada ~60 s por persona en jornada (≈ 30 × 8 h × 60 × 2 ≈ 30 000 escrituras/día; la cuota gratis es 20 000/día y el excedente cuesta centavos). Lecturas: el portal lee ~48 docs por persona y día consultado (un mes de todo el equipo ≈ 30 000 lecturas). Storage: capturas de ~15–150 KB (las difuminadas pesan menos), ≤ 6 por hora por persona → unos pocos GB con 90 días de retención (≈ USD 0,03/GB-mes). Functions: muy pocas invocaciones.
- Revisa la facturación el primer mes y ajusta la retención o desactiva capturas si hace falta.

### Aviso legal (Chile)

Medir la actividad de las personas trabajadoras tiene implicancias legales (Código del Trabajo, derechos fundamentales, Ley 19.628 de protección de datos personales). Antes de usarlo: **informa con transparencia** qué se mide y qué no (el aviso de la extensión ayuda, pero no reemplaza la comunicación), incorpóralo al **Reglamento Interno de Orden, Higiene y Seguridad**, define quién accede a los datos y por cuánto tiempo, y **valídalo con un abogado laboral**. Esta sección no es asesoría legal.

## Solución de problemas

| Síntoma | Qué revisar |
|---|---|
| `los emuladores no responden` al correr `npm run seed` | Levanta antes `npm run emulators` en otra terminal. |
| Puerto ocupado (8080, 9099, 9199, 5001, 4000) | Otro emulador quedó abierto (o Docker usa el 8080). Ciérralo; en Windows, `Get-NetTCPConnection -LocalPort 8080` muestra el proceso. |
| `no se encontró Chromium de Playwright` | `npx playwright install chromium` o `SMOKE_CHROMIUM=<ruta>`. |
| El emulador de Firestore no arranca | Instala Java 11 o superior y revisa `java -version`. |
| Extensión dev: el login o el envío fallan | Los emuladores deben estar arriba en 127.0.0.1 (el popup muestra los envíos pendientes); recarga la extensión en `chrome://extensions`. |
| "Pide a tu admin que te invite" | El correo no tiene invitación pendiente/aceptada (o fue revocada). Invítalo desde el portal. |
| "Esta cuenta no es de la empresa" (prod) | El perfil de Chrome usa una cuenta personal (`getAuthToken` usa siempre la cuenta del perfil) o el dominio de la cuenta no está en **Configuración → Dominios permitidos** del portal. |
| "Google rechazó el acceso" (prod) | El cliente OAuth no corresponde al ID de la extensión o está en otro proyecto (ver paso 4). |
| El primer `firebase deploy` de functions falla con un error de permisos de Eventarc o de "service agent" | Es normal en proyectos nuevos: Google tarda unos minutos en crear los permisos de los disparadores. Espera 5–10 minutos y vuelve a correr el mismo `npx firebase deploy`. |
| `firebase deploy` pide valores de `SMTP_*` o falla por secretos | Faltan los secretos del paso 6 (`npx firebase functions:secrets:set …`). |
| No llegan correos de invitación | Revisa los secretos SMTP y los logs de `onInvitationWritten` (`npx firebase functions:log`). Mientras tanto, copia el enlace desde Invitaciones. |
| El portal no muestra capturas | Capturas desactivadas en Configuración, o el colaborador estaba fuera de Chrome / en una página que no es http(s) en el instante sorteado. |
| Jornada "En jornada" que ya terminó | Sin señal hace > 30 min el portal la muestra "Fuera"; el cierre automático la cierra en la próxima hora. |

## Limitaciones conocidas

- **Apps fuera de Chrome** (Word, Excel, WhatsApp de escritorio, Zoom…): solo se sabe que estuviste "fuera de Chrome"; la actividad ahí se estima con `chrome.idle` (umbral 15 s).
- **Otros navegadores** (Edge, Firefox, Safari) y **pestañas de incógnito** no se miden.
- **Capturas solo de la pestaña visible**, no de la pantalla completa ni de otras apps. Hay **un solo intento por bloque**: si en ese instante Chrome no está enfocado, la pantalla está bloqueada o la pestaña no es http(s), ese bloque queda sin captura (no se reintenta ni se registra).
- **Reloj adelantado > 15 min**: las reglas rechazan tiempos "del futuro"; un computador con la hora muy adelantada no podrá subir datos hasta corregirla.
- Las horas y el % que ve el colaborador en el popup son solo de **ese navegador** (no suma otros computadores).
- El service worker de Chrome puede dormirse: los datos se guardan localmente y se envían después; si el navegador se cierra con la jornada abierta, ese tiempo queda "sin datos" y la jornada se cierra automáticamente tras 30 min sin señal (o 16 h abierta).
- Sin conexión: la cola local guarda los bloques y hasta 20 capturas (se descartan las más antiguas).
- El login de producción usa la cuenta del **perfil de Chrome** (sin selector de cuenta).
- Rango personalizado del portal: máximo **93 días** por consulta (para acotar lecturas).
- Sin proyectos/tareas, pagos ni multiempresa (fuera del alcance del MVP).
