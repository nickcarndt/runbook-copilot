import { query } from './db';
import { createEmbedding } from './indexing';

// Extract keywords from query text
function extractKeywords(queryText: string): string[] {
  const tokens = queryText.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);
  const unique = Array.from(new Set(tokens));
  return unique.slice(0, 8);
}

// Compute keyword score for a text
function computeKeywordScore(text: string, keywords: string[]): number {
  const lowerText = text.toLowerCase();
  return keywords.filter(keyword => lowerText.includes(keyword)).length;
}

// Vector search in Postgres with hybrid reranking
// Optionally filter by filenames to scope results to specific documents
export async function searchRunbooks(
  queryText: string, 
  topK: number = 5,
  options?: { filenames?: string[] }
): Promise<Array<{ id: string; text: string; filename: string; chunkIndex: number; distance?: number; keywordScore?: number }>> {
  try {
    // Create embedding for query
    const queryEmbedding = await createEmbedding(queryText);

    // Pull more candidates for reranking
    const candidateK = Math.max(topK * 5, 25);

    // Build SQL query with optional filename filter
    let sql = `SELECT 
         c.id,
         c.text,
         c.chunk_index,
         d.filename,
         (c.embedding <=> $1::vector) AS distance
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE c.embedding IS NOT NULL`;
    
    const params: any[] = [JSON.stringify(queryEmbedding)];
    let paramIndex = 2;
    
    // Add filename filter if provided
    if (options?.filenames && options.filenames.length > 0) {
      sql += ` AND d.filename = ANY($${paramIndex}::text[])`;
      params.push(options.filenames);
      paramIndex++;
    }
    
    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${paramIndex}`;
    params.push(candidateK);

    // Vector similarity search - get candidateK candidates
    const result = await query(sql, params);

    // Extract keywords from query
    const keywords = extractKeywords(queryText);

    // Dedupe and compute keyword scores
    const seenIds = new Set<string>();
    const seenChunks = new Set<string>();
    const candidates: Array<{ id: string; text: string; filename: string; chunkIndex: number; distance: number; keywordScore: number }> = [];

    for (const row of result.rows) {
      const chunkKey = `${row.filename}:${row.chunk_index}`;
      
      // Skip if we've seen this id or this filename+chunkIndex combination
      if (seenIds.has(row.id) || seenChunks.has(chunkKey)) {
        continue;
      }

      seenIds.add(row.id);
      seenChunks.add(chunkKey);
      
      const keywordScore = computeKeywordScore(row.text, keywords);
      candidates.push({
        id: row.id,
        text: row.text,
        filename: row.filename,
        chunkIndex: row.chunk_index,
        distance: parseFloat(row.distance),
        keywordScore,
      });
    }

    // Rerank by keywordScore desc, then distance asc
    candidates.sort((a, b) => {
      if (b.keywordScore !== a.keywordScore) {
        return b.keywordScore - a.keywordScore;
      }
      return a.distance - b.distance;
    });

    // Return topK after rerank
    return candidates.slice(0, topK);
  } catch (error) {
    // Log error and rethrow (don't silently return empty)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log(JSON.stringify({
      tool: 'searchRunbooks',
      error: 'search_failed',
      error_message: errorMessage,
      query_preview: queryText.substring(0, 60),
      topK,
      filenames_filter: options?.filenames
    }));
    throw error;
  }
}

