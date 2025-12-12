import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { logUpload } from '@/lib/db';
import { extractTextFromPDF, extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk } from '@/lib/indexing';

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

  try {
    // Demo safety gate
    if (!checkDemoToken(request)) {
      await logUpload(requestId, Date.now() - startTime, 'error', 'Unauthorized');
      return NextResponse.json(
        { error: 'Unauthorized', request_id: requestId },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { blobUrls } = requestSchema.parse(body);

    // Enforce max file count
    if (blobUrls.length > MAX_FILE_COUNT) {
      await logUpload(requestId, Date.now() - startTime, 'error', `Exceeds max file count: ${blobUrls.length} > ${MAX_FILE_COUNT}`);
      return NextResponse.json(
        { error: `Maximum ${MAX_FILE_COUNT} files allowed`, request_id: requestId },
        { status: 400 }
      );
    }

    // Download and process files
    let totalSize = 0;
    const processedFiles: Array<{ filename: string; chunks: number }> = [];

    for (const blobUrl of blobUrls) {
      // Download file from blob
      const fileResponse = await fetch(blobUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to download file from ${blobUrl}`);
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      totalSize += buffer.length;

      // Check total size limit
      if (totalSize > MAX_TOTAL_SIZE_BYTES) {
        await logUpload(requestId, Date.now() - startTime, 'error', `Total size exceeds limit: ${(totalSize / 1024 / 1024).toFixed(2)}MB > ${MAX_TOTAL_SIZE_MB}MB`);
        return NextResponse.json(
          { error: `Total file size exceeds ${MAX_TOTAL_SIZE_MB}MB limit`, request_id: requestId },
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
    }

    const latency = Date.now() - startTime;
    const totalChunks = processedFiles.reduce((sum, f) => sum + f.chunks, 0);

    // Log success
    await logUpload(
      requestId,
      latency,
      'success',
      null
    );

    return NextResponse.json({
      request_id: requestId,
      files_processed: processedFiles.length,
      total_chunks: totalChunks,
      files: processedFiles,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await logUpload(requestId, latency, 'error', errorMessage);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.errors, request_id: requestId },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: errorMessage, request_id: requestId },
      { status: 500 }
    );
  }
}

