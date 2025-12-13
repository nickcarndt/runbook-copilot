import { Pool } from 'pg';

// Suppress url.parse() deprecation warning from pg package (DEP0169)
// This is a known issue with pg@8.x using deprecated url.parse() internally
// The warning is harmless - pg will be updated to use WHATWG URL API in a future version
if (typeof process !== 'undefined') {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function(warning: any, type?: string, code?: string, ...args: any[]) {
    // Suppress DEP0169 (url.parse() deprecation) warnings
    if (code === 'DEP0169' || (typeof warning === 'string' && warning.includes('url.parse()'))) {
      return;
    }
    return originalEmitWarning.call(process, warning, type, code, ...args);
  };
}

// Single connection pool for serverless
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless-friendly settings
  max: 1, // Single connection per serverless function
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Basic query helper
export async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

// Helper for inserting query log
export async function logQuery(
  requestId: string,
  latencyMs: number,
  status: string,
  errorMessage?: string,
  chunkIds?: string[]
) {
  const chunkIdsJson = chunkIds && chunkIds.length > 0 ? JSON.stringify(chunkIds) : null;
  await query(
    `INSERT INTO query_logs (request_id, latency_ms, status, error_message)
     VALUES ($1, $2, $3, $4)`,
    [requestId, latencyMs, status, errorMessage || chunkIdsJson || null]
  );
}

// Helper for inserting upload log
export async function logUpload(
  requestId: string,
  latencyMs: number,
  status: string,
  errorMessage?: string
) {
  await query(
    `INSERT INTO upload_logs (request_id, latency_ms, status, error_message)
     VALUES ($1, $2, $3, $4)`,
    [requestId, latencyMs, status, errorMessage || null]
  );
}

// Export pool for direct access if needed
export { pool };

