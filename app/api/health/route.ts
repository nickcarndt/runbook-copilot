import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  let dbOk = false;
  let hasStageTimings = false;

  try {
    // Check if database is accessible
    await query('SELECT 1');
    dbOk = true;

    // Check if stage_timings column exists
    const result = await query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'upload_logs' AND column_name = 'stage_timings'`
    );
    hasStageTimings = result.rows.length > 0;
  } catch (error) {
    // dbOk remains false, hasStageTimings remains false
    console.error('[health] database check failed', error);
  }

  return NextResponse.json({
    ok: true,
    db_ok: dbOk,
    has_stage_timings: hasStageTimings,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
