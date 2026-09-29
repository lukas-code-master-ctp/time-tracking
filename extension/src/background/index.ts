/**
 * Service worker entry (ES module). Listeners are registered synchronously in
 * the first turn; the persisted state is rehydrated lazily by the store.
 */
import { App } from './app';
import { createFirebaseAuthService } from './auth';
import { createFirestoreBackend, initFirebase } from './firebase';
import { createCanvasImageProcessor } from './image';
import { StateStore } from './state';

const firebase = initFirebase();
const app = new App({
  store: new StateStore(),
  backend: createFirestoreBackend(firebase),
  auth: createFirebaseAuthService(firebase.auth, firebase.functions),
  images: createCanvasImageProcessor(),
});
app.register();
void app.start();
