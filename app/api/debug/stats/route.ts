import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db';

// Demo safety gate
function checkDemoToken(request: NextRequest): boolean {
  const demoToken = process.env.RBC_DEMO_TOKEN;
  if (!demoToken) return true; // No token set, allow all
  
  const headerToken = request.headers.get('x-rbc-token');
  return headerToken === demoToken;
}

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const requestId = uuidv4();
  
  try {
    // Demo safety gate
    if (!checkDemoToken(request)) {
      return NextResponse.json(
        { error: 'Unauthorized', request_id: requestId },
        { status: 401 }
      );
    }

    // Get total documents count
    const docsResult = await query('SELECT COUNT(*) as count FROM documents');
    const totalDocuments = parseInt(docsResult.rows[0].count, 10);

    // Get total unique filenames count
    const uniqueFilenamesResult = await query('SELECT COUNT(DISTINCT filename) as count FROM documents');
    const totalUniqueFilenames = parseInt(uniqueFilenamesResult.rows[0].count, 10);

    // Get total chunks count
    const chunksResult = await query('SELECT COUNT(*) as count FROM chunks');
    const totalChunks = parseInt(chunksResult.rows[0].count, 10);

    // Get chunks per filename (aggregated by filename, not document_id)
    const chunksPerFilenameResult = await query(
      `SELECT 
         d.filename,
         COUNT(c.id) as chunks
       FROM documents d
       LEFT JOIN chunks c ON d.id = c.document_id
       GROUP BY d.filename
       ORDER BY d.filename`
    );

    const chunksPerFilename = chunksPerFilenameResult.rows.map(row => ({
      filename: row.filename,
      chunks: parseInt(row.chunks, 10),
    }));

    return NextResponse.json({
      total_documents: totalDocuments,
      total_unique_filenames: totalUniqueFilenames,
      total_chunks: totalChunks,
      chunks_per_filename: chunksPerFilename,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: errorMessage, request_id: requestId },
      { status: 500 }
    );
  }
}

