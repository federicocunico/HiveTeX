import { mount } from 'svelte';
// Bundled fonts (no third-party font requests; the desktop app works offline). The display serif loads with the
// landing and sign-in screens only.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.svelte';
import { initBearer } from './lib/api.js';
import './lib/preferences.svelte.js';
import { installTooltips } from './ui/tooltip.js';

installTooltips();

initBearer()
  .catch(() => {})
  .finally(() => mount(App, { target: document.getElementById('app') as HTMLElement }));
