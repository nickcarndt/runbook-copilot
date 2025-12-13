import OpenAI from 'openai';
import { query } from './db';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Extract text from PDF buffer
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Validate buffer is present and not empty
  if (!buffer || !buffer.length) {
    throw new Error(`PDF buffer is empty or undefined (buffer.length: ${buffer?.length || 'undefined'})`);
  }
  
  // Validate PDF header
  const header = buffer.slice(0, 4).toString();
  if (header !== '%PDF') {
    throw new Error(`Not a valid PDF file (header: ${header})`);
  }
  
  // Dynamic import with ESM/CJS interop handling
  const mod = await import('pdf-parse');
  const pdfParse = (mod as any).default ?? (mod as any);
  
  // Ensure we're calling with the buffer
  if (!pdfParse) {
    throw new Error('Failed to import pdf-parse');
  }
  
  const data = await pdfParse(buffer);
  return data.text ?? '';
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
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
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
