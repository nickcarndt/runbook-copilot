// Suppress DEP0169 deprecation warnings (url.parse() from dependencies)
// Use global guard to prevent multiple handler registration in serverless/dev
if (typeof process !== 'undefined') {
  const globalKey = '__rbcWarningHooked';
  if (!(globalThis as any)[globalKey]) {
    (globalThis as any)[globalKey] = true;
    process.on('warning', (w) => {
      const code = (w as any)?.code;
      if (code === 'DEP0169') return; // Ignore noisy dependency warning
      console.warn(w);
    });
  }
}

