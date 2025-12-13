// Suppress DEP0169 deprecation warnings (url.parse() from dependencies)
// This module should be imported once at server startup to avoid multiple handler registration
if (typeof process !== 'undefined') {
  process.on('warning', (w: Error & { code?: string }) => {
    if (w?.code === 'DEP0169') return; // Ignore noisy dependency warning
    console.warn(w);
  });
}

