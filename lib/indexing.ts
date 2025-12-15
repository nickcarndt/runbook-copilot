import OpenAI from 'openai';
import { query } from './db';

// Declare require for Node.js runtime
declare const require: (id: string) => any;

// Lazy OpenAI client creation - only initialize at runtime, not at build time
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// Extract text from PDF buffer
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    // Validate buffer is present and not empty
    if (!buffer || buffer.length === 0) {
      throw new Error(`PDF buffer is empty or undefined (buffer.length: ${buffer?.length || 'undefined'}, buffer_type: ${typeof buffer}, buffer_constructor: ${buffer?.constructor?.name || 'undefined'})`);
    }
    
    // Ensure buffer is actually a Buffer instance
    if (!(buffer instanceof Buffer)) {
      throw new Error(`Buffer is not a Buffer instance (type: ${typeof buffer}, constructor: ${buffer.constructor.name})`);
    }
    
    // Validate PDF header
    const first4 = buffer.subarray(0, 4).toString('utf8');
    if (first4 !== '%PDF') {
      throw new Error(`Not a PDF header: "${first4}" (buffer.length: ${buffer.length}, buffer_type: ${typeof buffer}, buffer_constructor: ${buffer.constructor.name})`);
    }
    
    // Log what we're about to pass to pdf-parse
    console.log(`[extractTextFromPDF] About to call pdf-parse: length=${buffer.length}, type=${typeof buffer}, constructor=${buffer.constructor.name}, header="${first4}", isBuffer=${buffer instanceof Buffer}`);
    
    // Use require() instead of import() to ensure the patched version is used
    // and to prevent Next.js from bundling pdf-parse
    // Since we're in Node.js runtime, we can use require directly
    let mod: any;
    try {
      console.log(`[extractTextFromPDF] Starting require of pdf-parse...`);
      // Use require directly - this will use the patched version from node_modules
      // The webpack externals config ensures it's not bundled
      mod = require('pdf-parse');
      console.log(`[extractTextFromPDF] Require succeeded: mod type=${typeof mod}, mod keys=${Object.keys(mod || {}).join(',')}`);
    } catch (requireError: any) {
      console.error(`[extractTextFromPDF] Require failed: ${requireError.message}, stack=${requireError.stack?.substring(0, 300)}`);
      // Fallback to dynamic import if require fails
      try {
        console.log(`[extractTextFromPDF] Falling back to dynamic import...`);
        mod = await import('pdf-parse');
        console.log(`[extractTextFromPDF] Dynamic import succeeded: mod type=${typeof mod}, mod keys=${Object.keys(mod || {}).join(',')}`);
      } catch (importError: any) {
        console.error(`[extractTextFromPDF] Dynamic import also failed: ${importError.message}, stack=${importError.stack?.substring(0, 300)}`);
        throw new Error(`Failed to load pdf-parse: ${requireError.message}`);
      }
    }
  
  let pdfParse: any;
  
  // Try different ways pdf-parse might be exported
  if (typeof mod === 'function') {
    pdfParse = mod;
    console.log(`[extractTextFromPDF] Using mod as function directly`);
  } else if (mod.default && typeof mod.default === 'function') {
    pdfParse = mod.default;
    console.log(`[extractTextFromPDF] Using mod.default`);
  } else if (mod.pdfParse && typeof mod.pdfParse === 'function') {
    pdfParse = mod.pdfParse;
    console.log(`[extractTextFromPDF] Using mod.pdfParse`);
  } else {
    // Last resort: try the module itself
    pdfParse = mod;
    console.log(`[extractTextFromPDF] Using mod as fallback`);
  }
  
  // Ensure we're calling with the buffer
  if (!pdfParse || typeof pdfParse !== 'function') {
    console.error(`[extractTextFromPDF] Failed to extract pdf-parse function: mod type=${typeof mod}, mod.default=${typeof mod.default}, mod keys=${Object.keys(mod || {}).join(',')}, pdfParse type=${typeof pdfParse}`);
    throw new Error(`Failed to import pdf-parse (type: ${typeof pdfParse}, mod type: ${typeof mod})`);
  }
  
  console.log(`[extractTextFromPDF] Successfully imported pdf-parse: type=${typeof pdfParse}, isFunction=${typeof pdfParse === 'function'}, function.length=${pdfParse.length}`);
  
  // Create a defensive copy to ensure we're passing valid data
  // pdf-parse can accept Buffer or Uint8Array, so ensure we have a proper instance
  const bufferCopy = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : Buffer.from(buffer);
  
  // Final validation before calling
  if (!bufferCopy || bufferCopy.length === 0) {
    throw new Error(`Buffer copy is invalid: length=${bufferCopy?.length || 'undefined'}`);
  }
  
  console.log(`[extractTextFromPDF] Calling pdfParse with bufferCopy: length=${bufferCopy.length}, type=${typeof bufferCopy}, constructor=${bufferCopy.constructor.name}, isBuffer=${Buffer.isBuffer(bufferCopy)}`);
  
  // CRITICAL: Verify argument is defined right before calling
  if (!bufferCopy) {
    throw new Error(`CRITICAL: bufferCopy is undefined/null right before pdfParse call`);
  }
  if (bufferCopy.length === 0) {
    throw new Error(`CRITICAL: bufferCopy.length is 0 right before pdfParse call`);
  }
  
  // Try passing as Buffer first, fallback to Uint8Array if needed
  let parsed;
  try {
    // Double-check we're passing the buffer - log the actual argument
    const argToPass = bufferCopy;
    console.log(`[extractTextFromPDF] About to call pdfParse(argToPass) where argToPass.length=${argToPass.length}, argToPass type=${typeof argToPass}, argToPass constructor=${argToPass.constructor.name}, argToPass === bufferCopy=${argToPass === bufferCopy}`);
    
    // Verify the function signature - pdf-parse should accept buffer as first argument
    console.log(`[extractTextFromPDF] pdfParse function length (expected args): ${pdfParse.length}`);
    
    // Call with explicit argument to ensure it's passed
    // Try both direct call and .call() to ensure argument is passed
    if (pdfParse.length === 1) {
      // Function expects 1 argument - call directly
      parsed = await pdfParse(argToPass);
    } else {
      // Function might have different signature - try .call() to be explicit
      parsed = await pdfParse.call(null, argToPass);
    }
    
    console.log(`[extractTextFromPDF] pdfParse succeeded, parsed type=${typeof parsed}, parsed keys=${parsed ? Object.keys(parsed).join(',') : 'null'}`);
  } catch (parseError: any) {
    console.error(`[extractTextFromPDF] pdfParse failed: ${parseError.message}, code=${parseError.code}, stack=${parseError.stack?.substring(0, 200)}`);
    
    // If Buffer doesn't work, try Uint8Array
    if (parseError?.message?.includes('05-versions-space') || parseError?.code === 'ENOENT') {
      console.log(`[extractTextFromPDF] Buffer failed with ENOENT, trying Uint8Array...`);
      const uint8Array = new Uint8Array(bufferCopy);
      console.log(`[extractTextFromPDF] Calling pdfParse with Uint8Array: length=${uint8Array.length}, type=${typeof uint8Array}`);
      parsed = await pdfParse(uint8Array);
    } else {
      throw parseError;
    }
  }
  
  if (!parsed) {
    throw new Error(`pdf-parse returned null/undefined (buffer.length: ${buffer.length})`);
  }
  
  const text = parsed?.text ?? '';
  
    if (!text) {
      throw new Error(`PDF extraction returned empty text (buffer.length: ${buffer.length}, parsed: ${JSON.stringify(Object.keys(parsed || {}))})`);
    }
    
    return text;
  } catch (error: any) {
    // Catch any unexpected errors and log them with full context
    console.error(`[extractTextFromPDF] Unexpected error: ${error.message}, code=${error.code}, stack=${error.stack?.substring(0, 500)}`);
    console.error(`[extractTextFromPDF] Error context: buffer.length=${buffer?.length || 'undefined'}, buffer_type=${typeof buffer}`);
    throw new Error(`PDF extraction failed: ${error.message} (buffer.length: ${buffer?.length || 'undefined'})`);
  }
}

// Extract text from Markdown (just return as-is, it's already text)
export function extractTextFromMarkdown(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

// Chunk text with heading-aware chunking for markdown
export function chunkText(text: string, isMarkdown: boolean = false, maxChunkSize: number = 400, overlap: number = 50): string[] {
  if (!isMarkdown) {
    // Simple chunking for non-markdown (PDF text)
    return chunkTextSimple(text, maxChunkSize, overlap);
  }

  // Heading-aware chunking for markdown
  return chunkMarkdownWithHeadings(text, maxChunkSize, overlap);
}

// Simple chunking for non-markdown text
function chunkTextSimple(text: string, maxChunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    let chunk = text.slice(start, end);

    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = chunk.lastIndexOf('.');
      const lastNewline = chunk.lastIndexOf('\n');
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChunkSize * 0.5) {
        chunk = text.slice(start, start + breakPoint + 1);
        start = start + breakPoint + 1 - overlap;
      } else {
        start = end - overlap;
      }
    } else {
      start = end;
    }

    if (chunk.trim().length > 0) {
      chunks.push(chunk.trim());
    }
  }

  return chunks;
}

// Heading-aware chunking for markdown
function chunkMarkdownWithHeadings(text: string, maxChunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const lines = text.split('\n');
  const headingRegex = /^#{1,6}\s+/;

  let currentChunk: string[] = [];
  let currentSize = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = headingRegex.test(line);
    const lineSize = line.length + 1; // +1 for newline

    // If we hit a heading and current chunk has content, finalize it (create separate chunk per section)
    if (isHeading && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n').trim());
      // Start new chunk - include heading immediately, no overlap for section boundaries
      currentChunk = [line];
      currentSize = lineSize;
      continue;
    }

    // If adding this line would exceed max size, finalize current chunk
    if (currentSize + lineSize > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n').trim());
      // Start new chunk with overlap
      const overlapChars = Math.min(overlap, currentChunk.join('\n').length);
      const overlapText = currentChunk.join('\n').slice(-overlapChars);
      currentChunk = overlapText ? [overlapText] : [];
      currentSize = currentChunk.join('\n').length;
    }

    // Add line to current chunk
    currentChunk.push(line);
    currentSize += lineSize;
  }

  // Add final chunk if any remaining
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n').trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}

// Create embedding using OpenAI
export async function createEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAIClient();
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// Create embeddings in batch (more efficient)
export async function createEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const openai = getOpenAIClient();
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: texts,
  });
  return response.data.map(item => item.embedding);
}

// Insert document and return document ID (upsert to handle UNIQUE constraint)
export async function insertDocument(filename: string): Promise<string> {
  const result = await query(
    `INSERT INTO documents (filename) VALUES ($1)
     ON CONFLICT (filename) DO UPDATE SET filename = EXCLUDED.filename
     RETURNING id`,
    [filename]
  );
  return result.rows[0].id;
}

// Delete all chunks for a document (used when re-uploading same filename)
export async function deleteChunksForDocument(documentId: string): Promise<void> {
  await query(
    `DELETE FROM chunks WHERE document_id = $1`,
    [documentId]
  );
}

// Check if UNIQUE constraint exists on documents.filename
export async function checkUniqueConstraint(): Promise<boolean> {
  try {
    // Check for named constraint or unique index on filename column
    const result = await query(
      `SELECT 1 FROM pg_constraint 
       WHERE conrelid = 'documents'::regclass 
       AND conname = 'documents_filename_unique'
       UNION
       SELECT 1 FROM pg_index 
       WHERE indrelid = 'documents'::regclass 
       AND indisunique = true
       AND array_length(indkey, 1) = 1
       AND (SELECT attname FROM pg_attribute WHERE attrelid = 'documents'::regclass AND attnum = indkey[0]) = 'filename'`
    );
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

// Insert chunk with embedding
export async function insertChunk(
  documentId: string,
  chunkIndex: number,
  text: string,
  embedding: number[]
): Promise<void> {
  await query(
    `INSERT INTO chunks (document_id, chunk_index, text, embedding)
     VALUES ($1, $2, $3, $4::vector)`,
    [documentId, chunkIndex, text, JSON.stringify(embedding)]
  );
}

// Bulk insert chunks with embeddings (single SQL statement)
export async function insertChunksBulk(
  documentId: string,
  chunks: Array<{ chunkIndex: number; text: string; embedding: number[] }>
): Promise<void> {
  if (chunks.length === 0) return;
  
  // Build VALUES clause with parameterized query
  // Format: ($1, $2, $3, $4::vector), ($1, $5, $6, $7::vector), ...
  // documentId ($1) is reused for all rows
  const values: string[] = [];
  const params: any[] = [documentId]; // $1 is documentId
  
  for (let i = 0; i < chunks.length; i++) {
    const paramOffset = 1 + i * 3; // Start from $2 (after documentId)
    values.push(`($1, $${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3}::vector)`);
    params.push(chunks[i].chunkIndex);
    params.push(chunks[i].text);
    params.push(JSON.stringify(chunks[i].embedding));
  }
  
  await query(
    `INSERT INTO chunks (document_id, chunk_index, text, embedding)
     VALUES ${values.join(', ')}`,
    params
  );
}
