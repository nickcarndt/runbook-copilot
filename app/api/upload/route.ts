import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { Buffer } from 'buffer';
import { logUpload, updateUploadLog } from '@/lib/db';
import { extractTextFromPDF, extractTextFromMarkdown, chunkText, createEmbeddingsBatch, insertDocument, deleteChunksForDocument, insertChunksBulk, checkUniqueConstraint } from '@/lib/indexing';
import { searchRunbooks } from '@/lib/retrieval';
import { put } from '@vercel/blob';

// Timeout helper for async operations
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`timeout at stage=${label} after ${ms}ms`)), ms)
    ),
  ]);
}

// Logging helper with request_id
function log(requestId: string, message: string, data?: Record<string, any>) {
  const logData = { request_id: requestId, ...data };
  console.log(`[upload] ${message}`, JSON.stringify(logData));
}

// Limits (tuned for 60-120s completion target)
const MAX_FILE_COUNT = 3;
const MAX_TOTAL_SIZE_MB = 10; // Reduced from 15MB for faster processing
const MAX_TOTAL_SIZE_BYTES = MAX_TOTAL_SIZE_MB * 1024 * 1024;
const MAX_EXTRACTED_CHARS_PER_FILE = 150000; // 150k chars (reduced from 200k)
const MAX_CHUNKS_PER_UPLOAD = 60; // Reduced from 80 for faster completion
const EMBEDDING_BATCH_SIZE = 100; // OpenAI supports up to 2048 inputs per request
const EMBEDDING_CONCURRENCY = 2; // Reduced from 3 for more predictable timing

// Stage timeout limits (ms)
const TIMEOUT_PARSE_FORM = 10000;
const TIMEOUT_READ_FILE = 30000;
const TIMEOUT_EXTRACT_TEXT = 60000; // PDF extraction can be slow
const TIMEOUT_CHUNK = 10000;
const TIMEOUT_EMBED = 120000; // 2min for batch embeddings
const TIMEOUT_DB_INSERT = 30000;
const TIMEOUT_VERIFY_SEARCH = 15000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// maxDuration: 300s (5min) is max for Pro plan with Fluid Compute enabled
// Typical uploads should complete in 60-120s with tuned caps
export const maxDuration = 300;

// Cache UNIQUE constraint check result per function instance (cold start)
let cachedHasConstraint: boolean | null = null;
let constraintCheckPromise: Promise<boolean> | null = null;

// Upload token gate
function checkUploadToken(request: NextRequest): boolean {
  const uploadToken = process.env.UPLOAD_TOKEN;
  if (!uploadToken) return false;
  const headerToken = request.headers.get('x-upload-token');
  return headerToken === uploadToken;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const stageTimings: Record<string, { ms: number; counts?: Record<string, number> }> = {};

  // Log start
  log(requestId, 'upload started');

  // Write initial upload_logs row with status='started'
  try {
    await logUpload(requestId, 0, 'started', null, {});
  } catch (logError) {
    // Log error but continue
    console.error(`[upload] failed to write initial log: ${logError}`);
  }

  // Early validation of required environment variables
  if (!process.env.OPENAI_API_KEY) {
    const latency = Date.now() - startTime;
    try {
      await updateUploadLog(requestId, latency, 'error', 'OPENAI_API_KEY not set', stageTimings);
    } catch {}
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
    try {
      await updateUploadLog(requestId, latency, 'error', 'DATABASE_URL not set', stageTimings);
    } catch {}
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
        await updateUploadLog(requestId, latency, 'error', 'Unauthorized', stageTimings);
      } catch {}
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Unauthorized', code: 'UPLOAD_LOCKED' },
          latency_ms: latency,
        },
        { status: 401 }
      );
    }

    // Check if UNIQUE constraint exists (cached per function instance)
    if (cachedHasConstraint === null) {
      if (!constraintCheckPromise) {
        constraintCheckPromise = checkUniqueConstraint();
      }
      cachedHasConstraint = await constraintCheckPromise;
      constraintCheckPromise = null; // Clear promise after use
    }
    
    if (!cachedHasConstraint) {
      const latency = Date.now() - startTime;
      try {
        await updateUploadLog(requestId, latency, 'error', 'Missing UNIQUE constraint on documents.filename', stageTimings);
      } catch {}
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

    // Stage: parse_form
    const parseFormStart = Date.now();
    let formData: FormData;
    try {
      formData = await withTimeout(
        request.formData(),
        TIMEOUT_PARSE_FORM,
        'parse_form'
      );
      const parseFormMs = Date.now() - parseFormStart;
      stageTimings.parse_form = { ms: parseFormMs };
      log(requestId, 'parse_form completed', { stage: 'parse_form', ms: parseFormMs });
    } catch (parseError) {
      const parseFormMs = Date.now() - parseFormStart;
      stageTimings.parse_form = { ms: parseFormMs };
      const latency = Date.now() - startTime;
      const errorMsg = parseError instanceof Error ? parseError.message : 'Invalid form data';
      try {
        await updateUploadLog(requestId, latency, 'error', errorMsg, stageTimings);
      } catch {}
      log(requestId, 'parse_form failed', { stage: 'parse_form', ms: parseFormMs, error: errorMsg });
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: errorMsg, code: 'PARSE_ERROR' },
          latency_ms: latency,
        },
        { status: 400 }
      );
    }

    // Extract files from FormData
    const files = formData.getAll('files') as File[];

    // Enforce max file count
    if (files.length === 0) {
      const latency = Date.now() - startTime;
      try {
        await updateUploadLog(requestId, latency, 'error', 'No files provided', stageTimings);
      } catch {}
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
        await updateUploadLog(requestId, latency, 'error', `Exceeds max file count: ${files.length} > ${MAX_FILE_COUNT}`, stageTimings);
      } catch {}
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
    const processedFiles: Array<{ filename: string; chunks: number; chunks_skipped?: number }> = [];
    const fileTexts: Map<string, string> = new Map();
    let totalChunksCreated = 0;

    for (const file of files) {
      try {
        const filename = file.name;
        const isMarkdown = filename.endsWith('.md') || filename.endsWith('.MD') || filename.endsWith('.markdown');
        const isPDF = filename.endsWith('.pdf') || filename.endsWith('.PDF');
        
        if (!isMarkdown && !isPDF) {
          throw new Error(`Unsupported file type: ${filename}`);
        }

        // Stage: read_file_or_download_blob
        const readFileStart = Date.now();
        let buffer: Buffer;
        try {
          const arrayBuffer = await withTimeout(
            file.arrayBuffer(),
            TIMEOUT_READ_FILE,
            'read_file_or_download_blob'
          );
          buffer = Buffer.from(arrayBuffer);
          const readFileMs = Date.now() - readFileStart;
          if (!stageTimings.read_file_or_download_blob) {
            stageTimings.read_file_or_download_blob = { ms: 0, counts: { files: 0 } };
          }
          stageTimings.read_file_or_download_blob.ms += readFileMs;
          stageTimings.read_file_or_download_blob.counts!.files = (stageTimings.read_file_or_download_blob.counts!.files || 0) + 1;
          log(requestId, 'read_file completed', { stage: 'read_file_or_download_blob', ms: readFileMs, filename });
        } catch (readError) {
          const readFileMs = Date.now() - readFileStart;
          const errorMsg = readError instanceof Error ? readError.message : 'Failed to read file';
          throw new Error(`Failed to read file ${filename}: ${errorMsg}`);
        }
        
        if (!buffer || buffer.length === 0) {
          throw new Error(`Empty buffer for ${filename}`);
        }
        
        totalSize += buffer.length;

        // Check total size limit
        if (totalSize > MAX_TOTAL_SIZE_BYTES) {
          const latency = Date.now() - startTime;
          try {
            await updateUploadLog(requestId, latency, 'error', `Total size exceeds limit: ${(totalSize / 1024 / 1024).toFixed(2)}MB > ${MAX_TOTAL_SIZE_MB}MB`, stageTimings);
          } catch {}
          return NextResponse.json(
            {
              request_id: requestId,
              error: { message: `Total file size exceeds ${MAX_TOTAL_SIZE_MB}MB limit`, code: 'VALIDATION_ERROR' },
              latency_ms: latency,
            },
            { status: 400 }
          );
        }

        // Optionally store to Blob if token exists (with timeout to prevent stalling)
        if (process.env.BLOB_READ_WRITE_TOKEN) {
          try {
            const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
            // Use unique key to avoid collisions/overwrites
            const blobKey = `${requestId}/${filename}`;
            await withTimeout(
              put(blobKey, arrayBuffer, {
                access: 'public',
                contentType: file.type || (isPDF ? 'application/pdf' : 'text/markdown'),
              }),
              8000,
              'blob_put'
            );
          } catch (blobError) {
            log(requestId, 'blob storage failed (non-fatal)', { filename, error: blobError instanceof Error ? blobError.message : String(blobError) });
          }
        }

        // Stage: extract_text
        const extractStart = Date.now();
        let text: string;
        try {
          if (isPDF) {
            const pdfHeader = buffer.slice(0, 4).toString();
            if (pdfHeader !== '%PDF') {
              throw new Error(`Not a PDF header: ${filename}`);
            }
            
            const bufferForPdf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            text = await withTimeout(
              extractTextFromPDF(bufferForPdf),
              TIMEOUT_EXTRACT_TEXT,
              'extract_text'
            );
          } else {
            text = extractTextFromMarkdown(buffer);
          }
          
          // Enforce max extracted characters per file
          if (text.length > MAX_EXTRACTED_CHARS_PER_FILE) {
            const originalLength = text.length;
            text = text.substring(0, MAX_EXTRACTED_CHARS_PER_FILE);
            log(requestId, 'text truncated', { filename, original_length: originalLength, truncated_to: MAX_EXTRACTED_CHARS_PER_FILE });
          }
          
          const extractMs = Date.now() - extractStart;
          if (!stageTimings.extract_text) {
            stageTimings.extract_text = { ms: 0, counts: { files: 0, chars: 0 } };
          }
          stageTimings.extract_text.ms += extractMs;
          stageTimings.extract_text.counts!.files = (stageTimings.extract_text.counts!.files || 0) + 1;
          stageTimings.extract_text.counts!.chars = (stageTimings.extract_text.counts!.chars || 0) + text.length;
          log(requestId, 'extract_text completed', { stage: 'extract_text', ms: extractMs, filename, chars: text.length });
        } catch (extractError) {
          const extractMs = Date.now() - extractStart;
          const errorMsg = extractError instanceof Error ? extractError.message : 'Failed to extract text';
          throw new Error(`Failed to extract text from ${filename}: ${errorMsg}`);
        }
        
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty text extracted from ${filename}`);
        }
        
        fileTexts.set(filename, text);

        // Create document record (upsert by filename)
        let documentId: string;
        try {
          documentId = await insertDocument(filename);
          log(requestId, 'document created', { filename, document_id: documentId });
          
          // Delete old chunks if re-uploading same filename
          await deleteChunksForDocument(documentId);
          log(requestId, 'old chunks deleted', { filename, document_id: documentId });
        } catch (docError) {
          const errorMsg = docError instanceof Error ? docError.message : String(docError);
          throw new Error(`Failed to create document record for ${filename}: ${errorMsg}`);
        }

        // Stage: chunk
        const chunkStart = Date.now();
        let chunks: string[];
        try {
          chunks = await withTimeout(
            Promise.resolve(chunkText(text, isMarkdown)),
            TIMEOUT_CHUNK,
            'chunk'
          );
          const chunkMs = Date.now() - chunkStart;
          if (!stageTimings.chunk) {
            stageTimings.chunk = { ms: 0, counts: { files: 0, chunks: 0 } };
          }
          stageTimings.chunk.ms += chunkMs;
          stageTimings.chunk.counts!.files = (stageTimings.chunk.counts!.files || 0) + 1;
          stageTimings.chunk.counts!.chunks = (stageTimings.chunk.counts!.chunks || 0) + chunks.length;
          log(requestId, 'chunk completed', { stage: 'chunk', ms: chunkMs, filename, chunks: chunks.length });
        } catch (chunkError) {
          const chunkMs = Date.now() - chunkStart;
          const errorMsg = chunkError instanceof Error ? chunkError.message : String(chunkError);
          throw new Error(`Failed to chunk text for ${filename}: ${errorMsg}`);
        }

        // Enforce max chunks per upload
        let chunksToProcess = chunks;
        let chunksSkipped = 0;
        if (totalChunksCreated + chunks.length > MAX_CHUNKS_PER_UPLOAD) {
          const allowed = MAX_CHUNKS_PER_UPLOAD - totalChunksCreated;
          chunksToProcess = chunks.slice(0, allowed);
          chunksSkipped = chunks.length - allowed;
          log(requestId, 'chunks truncated', { filename, original_chunks: chunks.length, allowed, skipped: chunksSkipped });
        }

        // Stage: embed (with batching)
        const embedStart = Date.now();
        const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
        log(requestId, 'embedding start', { filename, model: embeddingModel, chunks: chunksToProcess.length });
        
        let chunkCount = 0;
        const allEmbeddings: number[][] = [];
        
        try {
          // Process chunks in batches with concurrency control
          const batches: string[][] = [];
          for (let i = 0; i < chunksToProcess.length; i += EMBEDDING_BATCH_SIZE) {
            batches.push(chunksToProcess.slice(i, i + EMBEDDING_BATCH_SIZE));
          }
          
          // Process batches with limited concurrency (simple approach: process in groups)
          for (let i = 0; i < batches.length; i += EMBEDDING_CONCURRENCY) {
            const concurrentBatches = batches.slice(i, i + EMBEDDING_CONCURRENCY);
            const batchResults = await Promise.all(
              concurrentBatches.map((batch, idx) =>
                withTimeout(
                  createEmbeddingsBatch(batch),
                  TIMEOUT_EMBED,
                  'embed'
                )
              )
            );
            
            // Flatten results maintaining order
            for (const embeddings of batchResults) {
              allEmbeddings.push(...embeddings);
            }
          }
          
          if (allEmbeddings.length !== chunksToProcess.length) {
            throw new Error(`Embedding count mismatch: expected ${chunksToProcess.length}, got ${allEmbeddings.length}`);
          }
          
          const embedMs = Date.now() - embedStart;
          if (!stageTimings.embed) {
            stageTimings.embed = { ms: 0, counts: { files: 0, chunks: 0, batches: 0 } };
          }
          stageTimings.embed.ms += embedMs;
          stageTimings.embed.counts!.files = (stageTimings.embed.counts!.files || 0) + 1;
          stageTimings.embed.counts!.chunks = (stageTimings.embed.counts!.chunks || 0) + allEmbeddings.length;
          stageTimings.embed.counts!.batches = (stageTimings.embed.counts!.batches || 0) + batches.length;
          log(requestId, 'embed completed', { stage: 'embed', ms: embedMs, filename, chunks: allEmbeddings.length, batches: batches.length });
        } catch (embedError) {
          const embedMs = Date.now() - embedStart;
          const errorMsg = embedError instanceof Error ? embedError.message : String(embedError);
          throw new Error(`Failed to create embeddings for ${filename}: ${errorMsg}`);
        }

        // Stage: db_insert (bulk insert - single SQL statement)
        const dbInsertStart = Date.now();
        try {
          // Prepare bulk insert data
          const chunksData = chunksToProcess.map((chunk, i) => ({
            chunkIndex: i,
            text: chunk,
            embedding: allEmbeddings[i],
          }));
          
          // Single bulk insert call
          await withTimeout(
            insertChunksBulk(documentId, chunksData),
            TIMEOUT_DB_INSERT,
            'db_insert'
          );
          
          chunkCount = chunksToProcess.length;
          totalChunksCreated += chunkCount;
          
          const dbInsertMs = Date.now() - dbInsertStart;
          if (!stageTimings.db_insert) {
            stageTimings.db_insert = { ms: 0, counts: { files: 0, chunks: 0 } };
          }
          stageTimings.db_insert.ms += dbInsertMs;
          stageTimings.db_insert.counts!.files = (stageTimings.db_insert.counts!.files || 0) + 1;
          stageTimings.db_insert.counts!.chunks = (stageTimings.db_insert.counts!.chunks || 0) + chunkCount;
          log(requestId, 'db_insert completed', { stage: 'db_insert', ms: dbInsertMs, filename, chunks: chunkCount });
        } catch (insertError) {
          const dbInsertMs = Date.now() - dbInsertStart;
          const errorMsg = insertError instanceof Error ? insertError.message : String(insertError);
          throw new Error(`Failed to insert chunks for ${filename}: ${errorMsg}`);
        }

        processedFiles.push({ 
          filename, 
          chunks: chunkCount,
          ...(chunksSkipped > 0 && { chunks_skipped: chunksSkipped })
        });
      } catch (fileError) {
        const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
        throw new Error(`Error processing file ${file.name}: ${errorMsg}`);
      }
    }

    const latency = Date.now() - startTime;
    const totalChunks = processedFiles.reduce((sum, f) => sum + f.chunks, 0);
    const insertedFilenames = processedFiles.map(f => f.filename);

    // Stage: verify_search (optional, non-blocking)
    let topRetrievalPreview: Array<{ filename: string; chunkIndex: number; textPreview: string; distance?: number; keywordScore?: number }> | null = null;
    let verifiedSearchable = false;
    
    // Only run verify search if explicitly enabled via env var (skip by default in production)
    if (process.env.ENABLE_VERIFY_SEARCH === 'true' && processedFiles.length > 0 && fileTexts.size > 0) {
      const verifyStart = Date.now();
      try {
        const firstFilename = processedFiles[0].filename;
        const firstText = fileTexts.get(firstFilename);
        const verificationQuery = firstText ? firstText.substring(0, 50).trim() : firstFilename.split('.')[0];
        
        const testResults = await withTimeout(
          searchRunbooks(verificationQuery, 3, { filenames: insertedFilenames }),
          TIMEOUT_VERIFY_SEARCH,
          'verify_search'
        );
        
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
        
        const verifyMs = Date.now() - verifyStart;
        stageTimings.verify_search = { ms: verifyMs, counts: { results: scopedResults.length } };
        log(requestId, 'verify_search completed', { stage: 'verify_search', ms: verifyMs, results: scopedResults.length });
      } catch (retrievalError) {
        const verifyMs = Date.now() - verifyStart;
        stageTimings.verify_search = { ms: verifyMs, counts: { results: 0 } };
        log(requestId, 'verify_search failed (non-fatal)', { stage: 'verify_search', ms: verifyMs, error: retrievalError instanceof Error ? retrievalError.message : String(retrievalError) });
      }
    }

    // Update upload log with success
    try {
      await updateUploadLog(requestId, latency, 'success', null, stageTimings);
    } catch (logError) {
      log(requestId, 'failed to update log (non-fatal)', { error: logError instanceof Error ? logError.message : String(logError) });
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
      stage_timings: stageTimings,
    };
    
    log(requestId, 'upload completed', { files: processedFiles.length, chunks: totalChunks, latency_ms: latency });
    
    return NextResponse.json(response);
  } catch (error) {
    const latency = Date.now() - startTime;
    let errorMessage = 'Unknown error';
    let errorCode = 'INTERNAL_ERROR';
    let errorStage = 'unknown';

    if (error instanceof Error) {
      errorMessage = error.message;
      errorCode = error.name || 'INTERNAL_ERROR';
      // Extract stage from error message if it's a timeout
      const stageMatch = errorMessage.match(/timeout at stage=([^\s]+)/);
      if (stageMatch) {
        errorStage = stageMatch[1];
      }
    } else {
      errorMessage = String(error);
    }

    // Update upload log with error
    try {
      await updateUploadLog(requestId, latency, 'error', errorMessage, stageTimings);
    } catch (logError) {
      log(requestId, 'failed to update error log', { error: logError instanceof Error ? logError.message : String(logError) });
    }

    log(requestId, 'upload failed', { error: errorMessage, code: errorCode, stage: errorStage, latency_ms: latency });

    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: errorMessage, code: errorCode, stage: errorStage },
        latency_ms: latency,
        stage_timings: stageTimings,
      },
      { 
        status: 500,
        headers: { 'X-Request-ID': requestId },
      }
    );
  }
}
