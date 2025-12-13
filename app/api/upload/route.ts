import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { Buffer } from 'buffer';
import { logUpload } from '@/lib/db';
import { extractTextFromPDF, extractTextFromMarkdown, chunkText, createEmbedding, insertDocument, insertChunk, checkUniqueConstraint } from '@/lib/indexing';
import { searchRunbooks } from '@/lib/retrieval';
import { put } from '@vercel/blob';

// Suppress DEP0169 deprecation warnings (url.parse() from dependencies)
if (typeof process !== 'undefined') {
  process.on('warning', (w) => {
    if (w?.code === 'DEP0169') return; // Ignore noisy dependency warning
    console.warn(w);
  });
}

// Timeout helper for async operations
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

// Build a deterministic verification query from extracted text
// Tries to extract: first heading (H1/H2), or first rare phrase, or first 6-10 unique tokens
function buildVerificationQuery(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Try to find first heading (H1/H2)
  for (const line of lines.slice(0, 20)) {
    if (/^#{1,2}\s+/.test(line)) {
      // Extract heading text (remove # and trim)
      const headingText = line.replace(/^#+\s+/, '').trim();
      if (headingText.length >= 10 && headingText.length <= 100) {
        return headingText;
      }
    }
  }
  
  // Try to find a unique phrase (3-5 words that appear early)
  for (const line of lines.slice(0, 10)) {
    const words = line.split(/\s+/).filter(w => w.length >= 4);
    if (words.length >= 3) {
      // Take first 3-5 words as a phrase
      const phrase = words.slice(0, Math.min(5, words.length)).join(' ');
      if (phrase.length >= 10 && phrase.length <= 80) {
        return phrase;
      }
    }
  }
  
  // Fallback: extract rare-ish tokens (longer words, unique)
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 5);
  const uniqueTokens = Array.from(new Set(tokens));
  if (uniqueTokens.length >= 3) {
    return uniqueTokens.slice(0, Math.min(8, uniqueTokens.length)).join(' ');
  }
  
  // Last resort: first 50 chars
  return text.substring(0, 50).trim();
}

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
export const dynamic = 'force-dynamic';

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
    const fileTexts: Map<string, string> = new Map(); // Store extracted text for verification query

    for (const file of files) {
      try {
        // Validate file type
        const filename = file.name;
        const isMarkdown = filename.endsWith('.md') || filename.endsWith('.MD') || filename.endsWith('.markdown');
        const isPDF = filename.endsWith('.pdf') || filename.endsWith('.PDF');
        
        if (!isMarkdown && !isPDF) {
          throw new Error(`Unsupported file type: ${filename}`);
        }

        // Read file into buffer with validation (must use arrayBuffer() with parentheses)
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Validate buffer is not empty
        if (!buffer || buffer.length === 0) {
          throw new Error(`Empty PDF buffer (file=${file.name}, size=${file.size}, buffer_len=${buffer?.length || 'undefined'}, buffer_type=${typeof buffer}, buffer_constructor=${buffer?.constructor?.name || 'undefined'})`);
        }
        
        // Debug log with type information
        console.log(`Processing file: ${filename}, type: ${file.type}, size: ${file.size}, buffer.length: ${buffer.length}, buffer_type: ${typeof buffer}, buffer_constructor: ${buffer.constructor.name}`);
        
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
          // Hard guard: validate buffer before parsing
          if (!buffer || !buffer.length) {
            throw new Error(`Empty PDF buffer: ${filename} size=${file.size} type=${file.type} buffer_len=${buffer?.length || 'undefined'}`);
          }
          
          // Hard guard: validate PDF header
          const pdfHeader = buffer.slice(0, 4).toString();
          if (pdfHeader !== '%PDF') {
            throw new Error(`Not a PDF header: ${filename} (header: ${pdfHeader}, size=${file.size}, buffer_len=${buffer.length})`);
          }
          
          // Log before calling extractTextFromPDF
          console.log(`[upload] About to call extractTextFromPDF: filename=${filename}, buffer.length=${buffer.length}, buffer_type=${typeof buffer}, buffer_constructor=${buffer.constructor.name}, header="${pdfHeader}"`);
          
          // Call extractTextFromPDF with validated buffer (ensure it's a Buffer)
          const bufferForPdf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          text = await extractTextFromPDF(bufferForPdf);
          
          if (!text || text.trim().length === 0) {
            throw new Error(`PDF extraction returned empty text: ${filename} (size=${file.size}, buffer_len=${buffer.length})`);
          }
          console.log(`[upload] pdf extracted: filename=${filename}, chars=${text.length}`);
        } else {
          text = extractTextFromMarkdown(buffer);
          console.log(`[upload] markdown extracted: filename=${filename}, chars=${text.length}`);
        }
        
        // Store extracted text for verification query
        fileTexts.set(filename, text);

        // Create document record
        let documentId: string;
        try {
          documentId = await insertDocument(filename);
          console.log(`[upload] document created: filename=${filename}, id=${documentId}`);
        } catch (docError) {
          const errorMsg = docError instanceof Error ? docError.message : String(docError);
          throw new Error(`Failed to create document record for ${filename}: ${errorMsg}`);
        }

        // Chunk text (heading-aware for markdown)
        let chunks: string[];
        try {
          chunks = chunkText(text, isMarkdown);
          console.log(`[upload] chunked: filename=${filename}, chunks=${chunks.length}`);
        } catch (chunkError) {
          const errorMsg = chunkError instanceof Error ? chunkError.message : String(chunkError);
          throw new Error(`Failed to chunk text for ${filename}: ${errorMsg}`);
        }

        // Process chunks and create embeddings with timeout
        const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
        const embeddingStartTime = Date.now();
        console.log(`[upload] embedding start: filename=${filename}, model=${embeddingModel}, chunks=${chunks.length}`);
        
        let chunkCount = 0;
        const embeddingPromises: Promise<void>[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkIndex = i;
          
          // Create embedding with timeout
          const embeddingPromise = (async () => {
            try {
              const embedding = await withTimeout(
                createEmbedding(chunk),
                30000, // 30s timeout per embedding
                `embedding chunk ${chunkIndex} for ${filename}`
              );
              
              // Insert chunk with timeout
              await withTimeout(
                insertChunk(documentId, chunkIndex, chunk, embedding),
                15000, // 15s timeout per insert
                `insert chunk ${chunkIndex} for ${filename}`
              );
              
              chunkCount++;
            } catch (chunkError) {
              const errorMsg = chunkError instanceof Error ? chunkError.message : String(chunkError);
              throw new Error(`Failed to process chunk ${chunkIndex} for ${filename}: ${errorMsg}`);
            }
          })();
          
          embeddingPromises.push(embeddingPromise);
        }

        // Wait for all embeddings and inserts to complete
        try {
          await Promise.all(embeddingPromises);
          const embeddingDuration = Date.now() - embeddingStartTime;
          console.log(`[upload] embedding done: filename=${filename}, count=${chunkCount}, ms=${embeddingDuration}`);
        } catch (embeddingError) {
          const errorMsg = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
          throw new Error(`Failed to process embeddings for ${filename}: ${errorMsg}`);
        }

        processedFiles.push({ filename, chunks: chunkCount });
      } catch (fileError) {
        // Include debug info in error message
        const debugInfo = `file.name=${file.name}, file.type=${file.type}, file.size=${file.size}`;
        const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
        throw new Error(`Error processing file ${file.name}: ${errorMsg} (${debugInfo})`);
      }
    }

    const latency = Date.now() - startTime;
    const totalChunks = processedFiles.reduce((sum, f) => sum + f.chunks, 0);
    const insertedFilenames = processedFiles.map(f => f.filename);

    // Run a test query to verify the content is searchable (scoped to inserted files)
    let topRetrievalPreview: Array<{ filename: string; chunkIndex: number; textPreview: string; distance?: number; keywordScore?: number }> | null = null;
    let verifiedSearchable = false;
    
    if (processedFiles.length > 0 && fileTexts.size > 0) {
      try {
        // Build deterministic verification query from first file's extracted text
        const firstFilename = processedFiles[0].filename;
        const firstText = fileTexts.get(firstFilename);
        const verificationQuery = firstText ? buildVerificationQuery(firstText) : firstFilename.split('.')[0];
        
        // Search scoped to only the inserted filenames
        const testResults = await searchRunbooks(verificationQuery, 3, { filenames: insertedFilenames });
        
        // Filter to only results from inserted files (double-check)
        const scopedResults = testResults.filter(result => insertedFilenames.includes(result.filename));
        
        if (scopedResults.length > 0) {
          verifiedSearchable = true;
          topRetrievalPreview = scopedResults.slice(0, 3).map(result => ({
            filename: result.filename,
            chunkIndex: result.chunkIndex,
            textPreview: result.text.substring(0, 150) + (result.text.length > 150 ? '...' : ''),
            distance: result.distance,
            keywordScore: result.keywordScore,
          }));
        }
      } catch (retrievalError) {
        // Log but don't fail - retrieval preview is optional
        console.warn('Failed to generate retrieval preview:', retrievalError);
      }
    }

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

    const response = {
      request_id: requestId,
      latency_ms: latency,
      files_processed: processedFiles.length,
      total_chunks: totalChunks,
      inserted_filenames: insertedFilenames,
      verified_searchable: verifiedSearchable,
      top_retrieval_preview: topRetrievalPreview,
      files: processedFiles,
    };
    
    console.log(`[upload] response sent: request_id=${requestId}, files=${processedFiles.length}, chunks=${totalChunks}, latency_ms=${latency}`);
    
    return NextResponse.json(response);
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

    // Return clean JSON error with request_id and debug info
    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: errorMessage, code: errorCode },
        latency_ms: latency,
      },
      { 
        status: 500,
        headers: { 'X-Request-ID': requestId },
      }
    );
  }
}
