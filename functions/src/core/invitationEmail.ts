/**
 * Invitation email (spec section 6, `onInvitationWritten`): when to send it,
 * and what it says (delivered with Resend, see email.ts). Pure.
 */
import type { Invitation } from '@timetracking/shared';
import { escapeHtml, type EmailMessage } from './email.js';

/**
 * An email is sent when an invitation becomes pending:
 * - it is created with status `pending`, or
 * - it changes from another status (`revoked`, `accepted`) to `pending` (re-invite), or
 * - it stays `pending` but `invitedAt` changes (the admin pressed "re-send").
 * Deletions and any other change send nothing.
 */
export function shouldSendInvitationEmail(
  before: Partial<Invitation> | undefined,
  after: Partial<Invitation> | undefined,
): boolean {
  if (!after || after.status !== 'pending') return false;
  if (!before) return true;
  if (before.status !== 'pending') return true;
  return before.invitedAt !== after.invitedAt;
}

export function buildInvitationEmail(params: { to: string; installUrl: string }): EmailMessage {
  const { to, installUrl } = params;
  const subject = 'Invitación a Mi Pega HR';
  const text = [
    'Hola:',
    '',
    'Te invitaron a usar Mi Pega HR, el registro de jornada de la empresa.',
    '',
    'Para empezar:',
    `1. Instala la extensión de Chrome desde este enlace: ${installUrl}`,
    `2. Abre la extensión e inicia sesión con tu cuenta Google de la empresa (${to}).`,
    '3. Lee y acepta el aviso que explica qué se mide y qué no.',
    '4. Presiona "Iniciar jornada" al comenzar a trabajar y "Cerrar jornada" al terminar.',
    '',
    'Solo se mide mientras tienes la jornada iniciada.',
    '',
    'Si no esperabas este correo, puedes ignorarlo.',
  ].join('\n');

  const safeTo = escapeHtml(to);
  const safeUrl = escapeHtml(installUrl);
  const html = `<!doctype html>
<html lang="es">
<body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.5;">
  <p>Hola:</p>
  <p>Te invitaron a usar <strong>Mi Pega HR</strong>, el registro de jornada de la empresa.</p>
  <p>Para empezar:</p>
  <ol>
    <li>Instala la extensión de Chrome: <a href="${safeUrl}">${safeUrl}</a></li>
    <li>Abre la extensión e inicia sesión con tu cuenta Google de la empresa (<strong>${safeTo}</strong>).</li>
    <li>Lee y acepta el aviso que explica qué se mide y qué no.</li>
    <li>Presiona <em>Iniciar jornada</em> al comenzar a trabajar y <em>Cerrar jornada</em> al terminar.</li>
  </ol>
  <p>Solo se mide mientras tienes la jornada iniciada.</p>
  <p style="color: #6b7280; font-size: 12px;">Si no esperabas este correo, puedes ignorarlo.</p>
</body>
</html>`;
  return { to, subject, text, html };
}
