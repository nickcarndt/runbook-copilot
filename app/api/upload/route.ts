import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { logUpload } from '@/lib/db';
import { extractTextFromPDF, extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk, checkUniqueConstraint } from '@/lib/indexing';
import { put } from '@vercel/blob';

// Upload token gate
function checkUploadToken(request: NextRequest): boolean {
  const uploadToken = process.env.UPLOAD_TOKEN;
  if (!uploadToken) return false; // Require token if set
  const headerToken = request.headers.get('x-upload-token');
  return headerToken === uploadToken;
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
    // Upload token gate
    if (!checkUploadToken(request)) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', 'Unauthorized');
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Unauthorized', code: 'UPLOAD_LOCKED' },
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

    // Parse FormData
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (parseError) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', 'Invalid form data');
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Invalid form data', code: 'PARSE_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    // Extract files from FormData (explicit field name 'files')
    const files = formData.getAll('files') as File[];

    // Enforce max file count
    if (files.length === 0) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', 'No files provided');
      } catch (logError) {
        // Ignore logging errors
      }
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'No files uploaded', code: 'VALIDATION_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    if (files.length > MAX_FILE_COUNT) {
      const latency = Date.now() - startTime;
      try {
        await logUpload(requestId, latency, 'error', `Exceeds max file count: ${files.length} > ${MAX_FILE_COUNT}`);
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

    // Process files
    let totalSize = 0;
    const processedFiles: Array<{ filename: string; chunks: number }> = [];

    for (const file of files) {
      try {
        // Validate file type
        const filename = file.name;
        const isMarkdown = filename.endsWith('.md') || filename.endsWith('.MD') || filename.endsWith('.markdown');
        const isPDF = filename.endsWith('.pdf') || filename.endsWith('.PDF');
        
        if (!isMarkdown && !isPDF) {
          throw new Error(`Unsupported file type: ${filename}`);
        }

        // Read file into buffer with validation
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Validate buffer is not empty
        if (!buffer.length) {
          throw new Error(`Empty upload: ${filename} (file.size: ${file.size}, buffer.length: ${buffer.length})`);
        }
        
        // Debug log (include in error if needed)
        console.log(`Processing file: ${filename}, type: ${file.type}, size: ${file.size}, buffer.length: ${buffer.length}`);
        
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

        // Optionally store to Blob if token exists (but don't require it)
        if (process.env.BLOB_READ_WRITE_TOKEN) {
          try {
            // Convert Buffer to ArrayBuffer for @vercel/blob put()
            const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            await put(filename, arrayBuffer, {
              access: 'public',
              contentType: file.type || (isPDF ? 'application/pdf' : 'text/markdown'),
            });
          } catch (blobError) {
            // Log but don't fail - Blob storage is optional
            console.warn('Failed to store file to Blob:', blobError);
          }
        }

        // Extract text (ensure buffer is passed correctly)
        let text: string;
        if (isPDF) {
          // Validate PDF header (optional sanity check)
          const pdfHeader = buffer.subarray(0, 4).toString();
          if (pdfHeader !== '%PDF') {
            throw new Error(`Not a valid PDF file: ${filename} (header: ${pdfHeader})`);
          }
          text = await extractTextFromPDF(buffer);
          if (!text || text.trim().length === 0) {
            throw new Error(`PDF extraction returned empty text: ${filename}`);
          }
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
        throw new Error(`Error processing file ${file.name}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
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

    if (error instanceof Error) {
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
      { status: 500 }
    );
  }
}
