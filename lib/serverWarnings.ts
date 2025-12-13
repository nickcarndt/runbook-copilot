// Suppress DEP0169 deprecation warnings (url.parse() from dependencies)
// Use global guard to prevent multiple handler registration in serverless/dev
declare global {
  var __rbcWarningHooked: boolean | undefined;
}

if (typeof process !== 'undefined' && !globalThis.__rbcWarningHooked) {
  globalThis.__rbcWarningHooked = true;
  process.on('warning', (w) => {
    const code = (w as any)?.code;
    if (code === 'DEP0169') return; // Ignore noisy dependency warning
    console.warn(w);
  });
}

