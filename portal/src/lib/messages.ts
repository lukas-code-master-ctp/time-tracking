/** User-facing Spanish messages for errors coming from Firebase. */
import { formatDomains } from '@timetracking/shared';

/** `joinOrg` rejection (`details.reason` of the HttpsError). */
export function joinErrorMessage(reason: string, domains: readonly string[]): string {
  switch (reason) {
    case 'no-invitation':
      return 'Tu cuenta no tiene acceso al portal. Pide a un administrador que te invite.';
    case 'invitation-revoked':
      return 'Tu invitación fue revocada. Habla con un administrador.';
    case 'domain-not-allowed':
      return `Esta cuenta no es de la empresa. Entra con tu cuenta ${formatDomains(domains)}.`;
    case 'user-disabled':
      return 'Tu cuenta está desactivada. Habla con un administrador.';
    case 'email-not-verified':
      return 'Tu correo no está verificado. Entra con tu cuenta Google de la empresa.';
    case 'no-email':
      return 'Tu cuenta de Google no tiene un correo asociado.';
    case 'unauthenticated':
      return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    default:
      return 'No se pudo validar tu cuenta con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
}

/** Sign-in errors (Google popup or email/password), in Spanish. */
export function authErrorMessage(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'El correo o la contraseña no coinciden. Si siempre entras con Google, usa ese botón o crea una contraseña con «¿Olvidaste tu contraseña?».';
    case 'auth/invalid-email':
      return 'Ese correo no es válido. Revísalo e inténtalo de nuevo.';
    case 'auth/email-already-in-use':
      return 'Ese correo ya tiene una cuenta. Inicia sesión, entra con Google o usa «¿Olvidaste tu contraseña?».';
    case 'auth/weak-password':
      return 'La contraseña es muy corta: usa al menos 8 caracteres.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos seguidos. Espera unos minutos o restablece tu contraseña.';
    case 'auth/user-disabled':
      return 'Tu cuenta está desactivada. Habla con un administrador.';
    case 'auth/operation-not-allowed':
      return 'El inicio de sesión con correo todavía no está activado. Entra con Google por ahora.';
    default:
      return errorMessage(err);
  }
}

/** Generic message for a failed read/write. */
export function errorMessage(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code.endsWith('permission-denied')) return 'No tienes permiso para hacer esto.';
  if (code.endsWith('unavailable') || code.endsWith('network-request-failed')) {
    return 'No hay conexión con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Cerraste la ventana de inicio de sesión antes de terminar.';
  }
  if (code === 'auth/popup-blocked') return 'El navegador bloqueó la ventana de inicio de sesión. Permite ventanas emergentes e inténtalo de nuevo.';
  if (code.startsWith('storage/')) return 'No se pudo cargar el archivo.';
  return 'Algo salió mal. Inténtalo de nuevo.';
}
