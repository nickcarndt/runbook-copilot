import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { logUpload } from '@/lib/db';
import { demoRunbooks } from '@/lib/demo-runbooks';
import { extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk } from '@/lib/indexing';

// Demo safety gate
function checkDemoToken(request: NextRequest): boolean {
  const demoToken = process.env.RBC_DEMO_TOKEN;
  if (!demoToken) return true;
  const headerToken = request.headers.get('x-rbc-token');
  return headerToken === demoToken;
}

export const runtime = 'nodejs';

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
    // Demo safety gate
    if (!checkDemoToken(request)) {
      const latency = Date.now() - startTime;
      await logUpload(requestId, latency, 'error', 'Unauthorized');
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
          latency_ms: latency,
        },
        { status: 401 }
      );
    }

    let documentsIndexed = 0;
    let chunksIndexed = 0;

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
        chunksIndexed++;
      }

      documentsIndexed++;
    }

    const latency = Date.now() - startTime;

    // Log success
    await logUpload(
      requestId,
      latency,
      'success',
      null
    );

    return NextResponse.json({
      request_id: requestId,
      latency_ms: latency,
      documents_indexed: documentsIndexed,
      chunks_indexed: chunksIndexed,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = error instanceof Error && error.name ? error.name : 'INTERNAL_ERROR';

    await logUpload(requestId, latency, 'error', errorMessage);

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
