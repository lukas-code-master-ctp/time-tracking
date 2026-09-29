/**
 * Starts the Firebase emulators for local development (Auth, Firestore,
 * Functions, Storage + Emulator UI at http://127.0.0.1:4000).
 *
 *   npm run emulators           → empty data on every start.
 *   npm run emulators:persist   → imports `.emulator-data/` if it exists and
 *                                 exports back into it on exit (Ctrl+C).
 *
 * `.emulator-data/` is git-ignored. Functions must be built first (the root
 * scripts run `npm run build:functions`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, '.emulator-data');
const persist = process.argv.includes('--persist');
const firebase = join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');

const args = [firebase, 'emulators:start', '--only', 'auth,firestore,functions,storage', '--project', 'demo-timetracking'];
if (persist) {
  if (existsSync(join(DATA, 'firebase-export-metadata.json'))) {
    args.push('--import', DATA);
    console.log(`Importando datos de ${DATA}`);
  } else {
    console.log(`Sin datos previos en ${DATA}: se crearán al salir (Ctrl+C).`);
  }
  args.push('--export-on-exit', DATA);
}

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
// Ctrl+C reaches both processes: let firebase export and exit on its own.
const ignore = (): void => undefined;
process.on('SIGINT', ignore);
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
