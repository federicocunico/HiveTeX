import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initBearer } from './lib/api.js';
import { migrateLegacyStorage } from './lib/migrate-legacy.js';

// Data stored under the previous product name is carried over before anything opens storage.
migrateLegacyStorage()
  .catch((e) => console.warn('storage migration will be retried on the next start', e))
  .then(() => initBearer())
  .catch(() => {})
  .finally(() => mount(App, { target: document.getElementById('app') as HTMLElement }));
