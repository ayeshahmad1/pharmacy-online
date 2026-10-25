// Applies the saved theme before first paint so dark mode does not flash.
// Loaded as a blocking classic script from index.html; it is a file rather
// than inline so the Content-Security-Policy can forbid inline scripts.
// Keep the key in sync with src/components/theme-provider.tsx.
(function () {
  var theme = 'system';
  try {
    theme = localStorage.getItem('pharmacy-theme') || 'system';
  } catch {
    // Storage blocked (private mode): follow the system theme.
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
