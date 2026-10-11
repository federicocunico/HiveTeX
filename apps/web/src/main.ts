import { mount } from 'svelte';
// Bundled fonts (no third-party font requests; the desktop app works offline). The display serif loads with the
// landing and sign-in screens only.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.svelte';
import { initBearer, isDesktop } from './lib/api.js';
import './lib/preferences.svelte.js';
import UpdateBadge from './components/UpdateBadge.svelte';
import { installTooltips } from './ui/tooltip.js';

installTooltips();

initBearer()
  .catch(() => {})
  .finally(() => mount(App, { target: document.getElementById('app') as HTMLElement }));

// Desktop only: announce a newer published release (the web app is always current).
if (isDesktop) {
  void import('@tauri-apps/api/app')
    .then(async ({ getVersion }) => {
      const current = await getVersion();
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      mount(UpdateBadge, { target: document.body, props: { current, open: (url: string) => openUrl(url) } });
    })
    .catch(() => {});
}
