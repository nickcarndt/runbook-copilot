import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ensureUploadLogsStageTimingsColumn, logUpload, query } from '@/lib/db';
import { demoRunbooks } from '@/lib/demo-runbooks';
import { extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk, checkUniqueConstraint } from '@/lib/indexing';
import { checkRateLimit, getClientIP } from '@/lib/rateLimit';

export const runtime = 'nodejs';

function isMissingStageTimingsColumnError(error: unknown) {
  const err = error as { code?: string; message?: string };
  return err?.code === '42703' && typeof err?.message === 'string' && err.message.includes('stage_timings');
}

async function safeLogUpload(
  requestId: string,
  latencyMs: number,
  status: string,
  errorMessage?: string
) {
  try {
    await logUpload(requestId, latencyMs, status, errorMessage);
  } catch (logError) {
    if (isMissingStageTimingsColumnError(logError)) {
      try {
        await ensureUploadLogsStageTimingsColumn();
        await logUpload(requestId, latencyMs, status, errorMessage);
      } catch (retryError) {
        console.error('[seedDemo] failed to log upload after ensuring column', retryError);
      }
    } else {
      console.error('[seedDemo] failed to log upload', logError);
    }
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = uuidv4();

  // Early validation of required environment variables
  if (!process.env.OPENAI_API_KEY) {
    const latency = Date.now() - startTime;
    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: 'OPENAI_API_KEY environment variable is not set', code: 'CONFIG_ERROR' },
        latency_ms: latency,
      },
      { status: 500 }
    );
  }

  if (!process.env.DATABASE_URL) {
    const latency = Date.now() - startTime;
    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: 'DATABASE_URL environment variable is not set', code: 'CONFIG_ERROR' },
        latency_ms: latency,
      },
      { status: 500 }
    );
  }

  try {
    try {
      await ensureUploadLogsStageTimingsColumn();
    } catch (schemaError) {
      const latency = Date.now() - startTime;
      const errorMessage =
        schemaError instanceof Error
          ? schemaError.message
          : 'Failed to ensure upload_logs.stage_timings column';
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: errorMessage, code: 'SCHEMA_ERROR' },
          latency_ms: latency,
        },
        { status: 500 }
      );
    }

    // Rate limiting (public endpoint)
    const clientIP = getClientIP(request);
    const rateLimit = checkRateLimit(clientIP, 10, 60 * 1000); // 10 requests per minute
    if (!rateLimit.allowed) {
      const latency = Date.now() - startTime;
      await safeLogUpload(requestId, latency, 'error', 'Rate limit exceeded');
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT' },
          latency_ms: latency,
        },
        { status: 429 }
      );
    }

    // Check if UNIQUE constraint exists
    const hasConstraint = await checkUniqueConstraint();
    if (!hasConstraint) {
      const latency = Date.now() - startTime;
      await safeLogUpload(requestId, latency, 'error', 'Missing UNIQUE constraint on documents.filename');
      return NextResponse.json(
        {
          request_id: requestId,
          error: { 
            message: 'Database schema is missing UNIQUE constraint on documents.filename. Please run: npm run db:migrate', 
            code: 'SCHEMA_ERROR' 
          },
          latency_ms: latency,
        },
        { status: 500 }
      );
    }

    // Get demo filenames for idempotent deletion
    const demoFilenames = demoRunbooks.map(runbook => `${runbook.title.replace(/\s+/g, '-')}.md`);

    // Delete existing demo runbooks (idempotent)
    // Delete chunks first, then documents (FK cascade will handle chunks if we delete docs, but being explicit)
    let deletedChunks = 0;
    let deletedDocuments = 0;
    
    if (demoFilenames.length > 0) {
      // Delete chunks for demo documents and count
      const deleteChunksResult = await query(
        `DELETE FROM chunks 
         WHERE document_id IN (SELECT id FROM documents WHERE filename = ANY($1::text[]))
         RETURNING id`,
        [demoFilenames]
      );
      deletedChunks = deleteChunksResult.rowCount || 0;
      
      // Delete demo documents and count
      const deleteDocsResult = await query(
        `DELETE FROM documents WHERE filename = ANY($1::text[]) RETURNING id`,
        [demoFilenames]
      );
      deletedDocuments = deleteDocsResult.rowCount || 0;
    }

    let insertedDocuments = 0;
    let insertedChunks = 0;

    // Process each demo runbook
    for (const runbook of demoRunbooks) {
      const filename = `${runbook.title.replace(/\s+/g, '-')}.md`;
      
      // Extract text (markdown content is already text)
      const buffer = Buffer.from(runbook.content, 'utf-8');
      const text = extractTextFromMarkdown(buffer);

      // Create document record
      const documentId = await insertDocument(filename);

      // Chunk text (heading-aware for markdown)
      const chunks = chunkText(text, true);
      
      // Process chunks and create embeddings
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await createEmbedding(chunk);
        await insertChunk(documentId, i, chunk, embedding);
        insertedChunks++;
      }

      insertedDocuments++;
    }

    const latency = Date.now() - startTime;

    // Log success
    await safeLogUpload(
      requestId,
      latency,
      'success',
      null
    );

    return NextResponse.json({
      request_id: requestId,
      latency_ms: latency,
      deleted_documents: deletedDocuments,
      deleted_chunks: deletedChunks,
      inserted_documents: insertedDocuments,
      inserted_chunks: insertedChunks,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = error instanceof Error && error.name ? error.name : 'INTERNAL_ERROR';

    await safeLogUpload(requestId, latency, 'error', errorMessage);

    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: errorMessage, code: errorCode },
        latency_ms: latency,
      },
      { status: 500 }
    );
  }
}
