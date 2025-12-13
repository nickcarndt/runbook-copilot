import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { logUpload } from '@/lib/db';
import { extractTextFromPDF, extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk, checkUniqueConstraint } from '@/lib/indexing';

const requestSchema = z.object({
  blobUrls: z.array(z.string().url()).min(1).max(10), // Max 10 files
});

// Demo safety gate
function checkDemoToken(request: NextRequest): boolean {
  const demoToken = process.env.RBC_DEMO_TOKEN;
  if (!demoToken) return true;
  const headerToken = request.headers.get('x-rbc-token');
  return headerToken === demoToken;
}

// Limits
const MAX_FILE_COUNT = 10;
const MAX_TOTAL_SIZE_MB = 100;
const MAX_TOTAL_SIZE_BYTES = MAX_TOTAL_SIZE_MB * 1024 * 1024;

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
      try {
        await logUpload(requestId, latency, 'error', 'Unauthorized');
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
          latency_ms: latency,
        },
        { status: 401 }
      );
    }

    // Check if UNIQUE constraint exists
    const hasConstraint = await checkUniqueConstraint();
    if (!hasConstraint) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', 'Missing UNIQUE constraint on documents.filename');
      } catch (logError) {
        // Ignore logging errors
      }
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

    // Parse request body with error handling
    let body: any;
    try {
      body = await request.json();
    } catch (parseError) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', 'Invalid JSON in request body');
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Invalid JSON in request body', code: 'PARSE_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    // Validate request body
    let blobUrls: string[];
    try {
      const validated = requestSchema.parse(body);
      blobUrls = validated.blobUrls;
    } catch (validationError) {
      const latency = Date.now() - startTime;
      const errorMessage = validationError instanceof z.ZodError 
        ? 'Invalid request body: ' + validationError.errors.map(e => e.message).join(', ')
        : 'Invalid request body';
      try {
        await logUpload(requestId, latency, 'error', errorMessage);
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: errorMessage, code: 'VALIDATION_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    // Enforce max file count
    if (blobUrls.length > MAX_FILE_COUNT) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', `Exceeds max file count: ${blobUrls.length} > ${MAX_FILE_COUNT}`);
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: `Maximum ${MAX_FILE_COUNT} files allowed`, code: 'VALIDATION_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    // Download and process files
    let totalSize = 0;
    const processedFiles: Array<{ filename: string; chunks: number }> = [];

    for (const blobUrl of blobUrls) {
      try {
        // Download file from blob
        const fileResponse = await fetch(blobUrl);
        if (!fileResponse.ok) {
          throw new Error(`Failed to download file from ${blobUrl}: ${fileResponse.status} ${fileResponse.statusText}`);
        }

        const buffer = Buffer.from(await fileResponse.arrayBuffer());
        totalSize += buffer.length;

        // Check total size limit
        if (totalSize > MAX_TOTAL_SIZE_BYTES) {
          const latency = Date.now() - startTime;
          try {
            await logUpload(requestId, latency, 'error', `Total size exceeds limit: ${(totalSize / 1024 / 1024).toFixed(2)}MB > ${MAX_TOTAL_SIZE_MB}MB`);
          } catch (logError) {
            // Ignore logging errors
          }
          return NextResponse.json(
            {
              request_id: requestId,
              error: { message: `Total file size exceeds ${MAX_TOTAL_SIZE_MB}MB limit`, code: 'VALIDATION_ERROR' },
              latency_ms: latency,
            },
            { status: 400 }
          );
        }

        // Extract filename from blob URL or use default
        const urlParts = blobUrl.split('/');
        const filename = urlParts[urlParts.length - 1] || `file-${Date.now()}`;

        // Determine file type and extract text
        const isMarkdown = filename.endsWith('.md') || filename.endsWith('.MD') || filename.endsWith('.markdown');
        const isPDF = filename.endsWith('.pdf') || filename.endsWith('.PDF');
        
        if (!isMarkdown && !isPDF) {
          throw new Error(`Unsupported file type: ${filename}`);
        }

        let text: string;
        if (isPDF) {
          text = await extractTextFromPDF(buffer);
        } else {
          text = extractTextFromMarkdown(buffer);
        }

        // Create document record
        const documentId = await insertDocument(filename);

        // Chunk text (heading-aware for markdown)
        const chunks = chunkText(text, isMarkdown);
        let chunkCount = 0;

        // Process chunks and create embeddings
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = await createEmbedding(chunk);
          await insertChunk(documentId, i, chunk, embedding);
          chunkCount++;
        }

        processedFiles.push({ filename, chunks: chunkCount });
      } catch (fileError) {
        // If processing a file fails, throw to outer catch
        throw new Error(`Error processing file ${blobUrl}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
      }
    }

    const latency = Date.now() - startTime;
    const totalChunks = processedFiles.reduce((sum, f) => sum + f.chunks, 0);

    // Log success
    try {
      await logUpload(
        requestId,
        latency,
        'success',
        null
      );
    } catch (logError) {
      // Ignore logging errors, but continue
    }

    return NextResponse.json({
      request_id: requestId,
      latency_ms: latency,
      files_processed: processedFiles.length,
      total_chunks: totalChunks,
      files: processedFiles,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    let errorMessage = 'Unknown error';
    let errorCode = 'INTERNAL_ERROR';

    if (error instanceof z.ZodError) {
      errorMessage = 'Invalid request body: ' + error.errors.map(e => e.message).join(', ');
      errorCode = 'VALIDATION_ERROR';
    } else if (error instanceof Error) {
      errorMessage = error.message;
      errorCode = error.name || 'INTERNAL_ERROR';
    } else {
      errorMessage = String(error);
    }

    // Try to log, but don't fail if logging fails
    try {
      await logUpload(requestId, latency, 'error', errorMessage);
    } catch (logError) {
      // Ignore logging errors
    }

    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: errorMessage, code: errorCode },
        latency_ms: latency,
      },
      { status: error instanceof z.ZodError ? 400 : 500 }
    );
  }
}
