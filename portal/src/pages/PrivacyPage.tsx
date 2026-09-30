import { useEffect } from 'react';
import { Link } from 'react-router';
import { DEFAULT_SCREENSHOT_RETENTION_DAYS, FUNCTIONS_REGION, SCHEDULER_REGION } from '@timetracking/shared';

export const PRIVACY_PATH = '/privacidad';
export const PRIVACY_UPDATED_AT = '30 de septiembre de 2026';
export const PRIVACY_CONTACT = 'lukas@impulseai.cl';

export const PRIVACY_TITLE = 'Política de privacidad · Registro de jornada';

/**
 * Public privacy policy of the "Registro de jornada" extension and portal
 * (Chrome Web Store "privacy policy URL"). Rendered outside the session gate:
 * it needs no login and no Firebase. Same content as the extension's consent
 * notice (extension/consent.html), plus storage, retention and rights.
 */
export function PrivacyPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = PRIVACY_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  const mail = <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a>;

  return (
    <main className="privacy-page">
      <article className="privacy-doc">
        <header className="privacy-head">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Registro de jornada
          </span>
          <h1>Política de privacidad</h1>
          <p className="muted">
            Extensión de Chrome “Registro de jornada” y su portal de administración. Última actualización:{' '}
            <time dateTime="2026-09-30">{PRIVACY_UPDATED_AT}</time>.
          </p>
        </header>

        <section className="card" aria-labelledby="pp-responsable">
          <h2 id="pp-responsable">Quién es responsable</h2>
          <p>
            <strong>Impulse AI</strong> (<a href="https://impulseai.cl">impulseai.cl</a>) y{' '}
            <strong>Compra tu Parcela</strong> (<a href="https://compratuparcela.cl">compratuparcela.cl</a>) son
            responsables de los datos que se tratan con esta herramienta. Es de <strong>uso interno</strong>: solo la
            usan sus colaboradores, con su cuenta de Google de la empresa, para registrar la jornada laboral.
            No está dirigida al público general.
          </p>
          <p>Contacto para cualquier consulta sobre privacidad: {mail}.</p>
        </section>

        <section className="card" aria-labelledby="pp-cuando">
          <h2 id="pp-cuando">Cuándo se recogen datos</h2>
          <p>
            La extensión mide <strong>solo mientras tú tienes la jornada iniciada</strong>. Cuando cierras la jornada, no
            mide nada. Mientras está iniciada, el ícono de la extensión muestra la insignia “ON” y la ventana de la
            extensión indica qué se está midiendo. Antes del primer uso, la extensión te muestra un aviso con este mismo
            contenido y te pide aceptarlo.
          </p>
          <p>
            <strong>Horario laboral y colación:</strong> si tu empresa configuró un horario, la extensión{' '}
            <strong>no mide nada fuera de tu horario ni durante la colación</strong>, aunque tu jornada siga iniciada: ni
            actividad, ni sitios, ni reuniones, ni capturas. En ese tiempo solo queda registrado que la jornada estaba
            abierta: el <strong>inicio y el cierre de la jornada se guardan siempre</strong>, también fuera del horario,
            como registro de asistencia (por ejemplo, para las horas extra). La ventana de la extensión te muestra el
            horario de hoy y si en ese momento estás “En horario”, en “Colación” o “Fuera de horario”. Mientras la
            medición está en pausa, la extensión sigue viendo <strong>solo en tu computador</strong> qué pestaña está
            activa, si hay una reunión web abierta y si hay uso de teclado o mouse, únicamente para retomar la medición
            justo cuando vuelve tu horario: eso <strong>no se suma a ningún bloque ni se envía</strong>.
          </p>
        </section>

        <section className="card" aria-labelledby="pp-que">
          <h2 id="pp-que">Qué datos se recogen</h2>
          <ul className="privacy-list yes">
            <li>
              <strong>Datos de tu cuenta Google de la empresa:</strong> correo, nombre y foto de perfil, al iniciar
              sesión. También se guarda la fecha en que aceptaste el aviso de medición y su versión. Si un
              administrador te invita, tu correo queda en la lista de invitaciones del portal.
            </li>
            <li>
              <strong>Inicio y cierre de la jornada</strong>, su duración y una señal periódica de que la extensión
              sigue funcionando (para cerrar jornadas que quedaron abiertas). Se guardan siempre, también fuera del
              horario laboral.
            </li>
            <li>
              <strong>Tu horario laboral asignado, si tu empresa lo configura:</strong> el horario general de la empresa
              (entrada, salida y colación de cada día, feriados, margen de tolerancia y si hay recordatorios) y, si
              tienes un horario distinto al general, tu horario personalizado. Los define un administrador. Con ese
              horario y el inicio y cierre de tus jornadas, el portal calcula el cumplimiento: horas esperadas, tiempo
              en horario y fuera de horario, atrasos, salidas anticipadas y ausencias. La extensión guarda una copia del
              horario en tu computador para aplicarlo sin conexión.
            </li>
            <li>
              <strong>Nivel de actividad por bloques de 10 minutos:</strong> en Chrome, solo si hubo uso de teclado o
              mouse en cada segundo (el hecho de que hubo uso, nunca qué teclas ni qué contenido). Fuera de Chrome, solo
              si el computador estuvo en uso o inactivo, según el estado de inactividad del sistema.
            </li>
            <li>
              <strong>Sitios web de la pestaña activa de Chrome:</strong> el dominio y la dirección de la página, y
              cuánto tiempo estuviste en cada una. Las direcciones se guardan <strong>sin parámetros ni fragmentos</strong>{' '}
              (se descarta todo lo que va después de “?” o “#”).
            </li>
            <li>
              <strong>Reuniones web:</strong> si tienes abierta una reunión en Chrome (Google Meet, Zoom, Microsoft
              Teams, Webex, Jitsi, Whereby o GoTo Meeting), para no contar como inactividad el tiempo en que escuchas
              sin usar el teclado ni el mouse. Para saberlo, la extensión solo revisa la <strong>dirección</strong> de
              tus pestañas de Chrome (no las de incógnito) y <strong>si alguna está reproduciendo sonido</strong>. Se
              guarda únicamente cuánto tiempo de cada bloque estuviste “En reunión”; de las pestañas en segundo plano
              no se guarda la dirección. Ese tiempo no sube ni baja tu % de actividad. Las reuniones en aplicaciones de
              escritorio (fuera de Chrome) no se detectan.
            </li>
            <li>
              <strong>Tiempo fuera de Chrome:</strong> cuánto tiempo Chrome no estuvo en primer plano, sin saber qué
              aplicación usabas en ese tiempo.
            </li>
            <li>
              <strong>Capturas de pantalla, solo si el administrador de tu empresa las activa:</strong> como máximo una
              cada 10 minutos, en un momento al azar, solo de la <strong>pestaña visible de Chrome</strong> (nunca de la
              pantalla completa ni de otras aplicaciones). Si el administrador activa el difuminado, la imagen se
              difumina <strong>en tu computador antes de enviarse</strong>.
            </li>
          </ul>
          <p>
            <strong>Recordatorios:</strong> si tu empresa los activa, la extensión puede mostrarte una notificación de
            Chrome para que inicies tu jornada a la hora de entrada o la cierres a la hora de salida. Son{' '}
            <strong>notificaciones locales</strong>, generadas en tu computador: para mostrarlas no se envía ningún dato,
            y solo se guarda en tu computador que ya se mostraron ese día.
          </p>
        </section>

        <section className="card" aria-labelledby="pp-no">
          <h2 id="pp-no">Qué NO se recoge</h2>
          <ul className="privacy-list no">
            <li>
              <strong>Qué teclas presionas</strong> ni lo que escribes.
            </li>
            <li>
              <strong>El contenido</strong> de páginas, documentos, formularios, correos o mensajes.
            </li>
            <li>
              <strong>El audio ni el video</strong> de tus reuniones ni de ninguna página: nunca se escuchan, graban ni
              envían. Solo se sabe si una pestaña está sonando.
            </li>
            <li>
              <strong>Qué aplicaciones usas fuera de Chrome</strong> (Word, Excel, WhatsApp de escritorio, etc.): solo se
              sabe que estuviste “fuera de Chrome”.
            </li>
            <li>
              <strong>Pestañas de incógnito:</strong> la extensión no funciona en incógnito; ese tiempo cuenta como
              “fuera de Chrome”, sin registrar sitios ni capturas.
            </li>
            <li>
              <strong>Nada</strong> mientras tu jornada está cerrada.
            </li>
            <li>
              <strong>Nada fuera de tu horario ni en la colación</strong>, si tu empresa configuró un horario: ni
              actividad, ni sitios, ni reuniones, ni capturas (solo el inicio y el cierre de la jornada).
            </li>
          </ul>
        </section>

        <section className="card" aria-labelledby="pp-uso">
          <h2 id="pp-uso">Para qué se usan</h2>
          <p>
            Solo para generar <strong>reportes internos de jornada y actividad</strong> y, si hay horario configurado, de{' '}
            <strong>cumplimiento del horario</strong> (asistencia, atrasos y horas fuera de horario), que revisan los
            administradores de la empresa. Los datos <strong>no se venden</strong>, <strong>no se comparten con terceros</strong> y{' '}
            <strong>no se usan para publicidad</strong> ni para evaluar créditos o solvencia.
          </p>
        </section>

        <section className="card" aria-labelledby="pp-donde">
          <h2 id="pp-donde">Dónde se guardan</h2>
          <p>
            En <strong>Google Firebase</strong> (Google Cloud), en un proyecto de la empresa. La base de datos está en la
            región de <strong>Santiago de Chile</strong> ({FUNCTIONS_REGION}) y las capturas se guardan en Cloud Storage
            del mismo proyecto, también en Santiago. Las tareas automáticas de
            mantenimiento (borrar capturas antiguas y cerrar jornadas abandonadas) se ejecutan en {SCHEDULER_REGION}{' '}
            (São Paulo), porque esa programación no está disponible en Santiago.
          </p>
          <p>
            Mientras no hay conexión, la extensión guarda temporalmente en tu computador los bloques y capturas
            pendientes, y los envía al volver la conexión. El portal de administración se publica como un sitio
            estático: lee los datos directamente desde Firebase.
          </p>
        </section>

        <section className="card" aria-labelledby="pp-acceso">
          <h2 id="pp-acceso">Quién accede</h2>
          <ul className="privacy-list">
            <li>
              <strong>Tú:</strong> ves tus horas y tu actividad del día, y tu horario de hoy, en la extensión.
            </li>
            <li>
              <strong>Los administradores del portal</strong> (personas de Impulse AI o Compra tu Parcela designadas como
              administradoras): ven las jornadas, la actividad, los sitios, las capturas, los horarios y el cumplimiento
              del horario de todo el equipo, y son quienes definen los horarios.
            </li>
          </ul>
          <p>
            El acceso exige iniciar sesión con la cuenta de la empresa. Un colaborador no puede ver los datos de otros
            colaboradores. Google, como proveedor de la infraestructura (y, si se usa, el servicio de correo que envía las
            invitaciones), trata los datos solo para prestar ese servicio.
          </p>
        </section>

        <section className="card" aria-labelledby="pp-retencion">
          <h2 id="pp-retencion">Cuánto tiempo se conservan</h2>
          <ul className="privacy-list">
            <li>
              <strong>Capturas:</strong> se borran automáticamente al cumplirse el plazo que configura el administrador
              ({DEFAULT_SCREENSHOT_RETENTION_DAYS} días por defecto).
            </li>
            <li>
              <strong>Horarios:</strong> el horario vigente se reemplaza cuando un administrador lo cambia (no se guarda
              un historial de horarios anteriores) y tu horario personalizado se borra al volver al horario general.
            </li>
            <li>
              <strong>Jornadas, actividad y sitios:</strong> se conservan mientras dure la relación laboral o por el
              plazo que indique la empresa conforme a sus obligaciones legales. Puedes pedir su eliminación como se indica
              más abajo.
            </li>
          </ul>
        </section>

        <section className="card" aria-labelledby="pp-derechos">
          <h2 id="pp-derechos">Tus derechos</h2>
          <p>
            Puedes pedir <strong>acceso</strong> a tus datos, su <strong>rectificación</strong> o su{' '}
            <strong>eliminación</strong> escribiendo a {mail}. Atenderemos tu solicitud según la legislación chilena de
            protección de datos personales (Ley 19.628 sobre protección de la vida privada y Ley 21.719, que la
            modifica).
          </p>
        </section>

        <section className="card" aria-labelledby="pp-cambios">
          <h2 id="pp-cambios">Cambios a esta política</h2>
          <p>
            Si cambia lo que se mide, actualizaremos esta página y la fecha de arriba, y la extensión te volverá a
            mostrar el aviso para que lo aceptes.
          </p>
        </section>

        <footer className="privacy-foot small muted">
          <Link to="/">Ir al portal de administración</Link>
        </footer>
      </article>
    </main>
  );
}
