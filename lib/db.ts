import { Pool } from 'pg';
import './serverWarnings'; // Initialize warning handler once (suppresses DEP0169 from pg)

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

