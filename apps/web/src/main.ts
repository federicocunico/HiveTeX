import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initBearer } from './lib/api.js';

initBearer()
  .catch(() => {})
  .finally(() => mount(App, { target: document.getElementById('app') as HTMLElement }));
