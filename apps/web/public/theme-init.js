// Applies the chosen theme before the first paint, so a reload never flashes the other theme. Kept as a tiny
// same-origin file because the Content-Security-Policy forbids inline scripts. Mirrors lib/preferences.svelte.ts.
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem('hivetex.prefs') || '{}');
    if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.setAttribute('data-theme', prefs.theme);
  } catch (e) {
    /* storage blocked or corrupt: follow the system theme */
  }
})();
