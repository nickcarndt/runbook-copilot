import { Pool } from 'pg';

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
  errorMessage?: string,
  stageTimings?: Record<string, { ms: number; counts?: Record<string, number> }>
) {
  const stageTimingsJson = stageTimings ? JSON.stringify(stageTimings) : null;
  await query(
    `INSERT INTO upload_logs (request_id, latency_ms, status, error_message, stage_timings)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [requestId, latencyMs, status, errorMessage || null, stageTimingsJson]
  );
}

// Helper for updating upload log (for status updates)
export async function updateUploadLog(
  requestId: string,
  latencyMs: number,
  status: string,
  errorMessage?: string,
  stageTimings?: Record<string, { ms: number; counts?: Record<string, number> }>
) {
  const stageTimingsJson = stageTimings ? JSON.stringify(stageTimings) : null;
  await query(
    `UPDATE upload_logs 
     SET latency_ms = $2, status = $3, error_message = $4, stage_timings = $5::jsonb
     WHERE request_id = $1`,
    [requestId, latencyMs, status, errorMessage || null, stageTimingsJson]
  );
}

// Export pool for direct access if needed
export { pool };

