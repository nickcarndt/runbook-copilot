import { tool } from 'llamaindex';
import { agent, agentStreamEvent, agentToolCallEvent } from '@llamaindex/workflow';
import { openai } from '@llamaindex/openai';
import { z } from 'zod';
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
async function searchRunbooks(queryText: string, topK: number = 5): Promise<Array<{ id: string; text: string; filename: string; chunkIndex: number; distance?: number; keywordScore?: number }>> {
  try {
    // Create embedding for query
    const queryEmbedding = await createEmbedding(queryText);

    // Pull more candidates for reranking
    const candidateK = Math.max(topK * 5, 25);

    // Vector similarity search - get candidateK candidates
    const result = await query(
      `SELECT 
         c.id,
         c.text,
         c.chunk_index,
         d.filename,
         (c.embedding <=> $1::vector) AS distance
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(queryEmbedding), candidateK]
    );

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
      topK
    }));
    throw error;
  }
}

// Create searchRunbooks tool
const searchRunbooksTool = tool(
  async (args: any) => {
    // Log args structure for debugging
    const argsType = typeof args;
    const argsKeys = argsType === 'object' && args !== null ? Object.keys(args) : [];
    
    // Robust argument extraction with priority order
    let q = '';
    if (typeof args === 'string') {
      q = args;
    } else if (args) {
      q = args.query 
        ?? (typeof args.input === 'string' ? args.input : args.input?.query)
        ?? args.text
        ?? args.q
        ?? args.args?.query
        ?? args.parameters?.query
        ?? '';
    }
    
    const topK = args?.topK ?? args?.k ?? 5;
    
    // If query is empty, return empty array and log
    if (!q.trim()) {
      console.log(JSON.stringify({
        tool: 'searchRunbooks',
        args_type: argsType,
        args_keys: argsKeys,
        extracted_query_preview: '',
        query_length: 0,
        topK,
        results_count: 0,
        note: 'Empty query string'
      }));
      return JSON.stringify([], null, 2);
    }
    
    const results = await searchRunbooks(q.trim(), topK);
    
    // Structured logging with full context
    console.log(JSON.stringify({
      tool: 'searchRunbooks',
      args_type: argsType,
      args_keys: argsKeys,
      extracted_query_preview: q.trim().substring(0, 60),
      query_length: q.trim().length,
      topK,
      results_count: results.length
    }));
    
    return JSON.stringify(results, null, 2);
  },
  {
    name: 'searchRunbooks',
    description: 'Search runbooks using vector similarity. Returns the most relevant chunk texts with their source document filenames.',
    parameters: z.object({
      query: z.string().describe('The search query to find relevant runbook content'),
      topK: z.number().optional().default(5).describe('Number of top results to return (default: 5)'),
    }),
  }
);

// System prompt for clear, numbered steps and source citations
const SYSTEM_PROMPT = `You are a runbook assistant that helps users resolve technical issues by providing clear, actionable steps from uploaded runbooks.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. You MUST call the searchRunbooks tool BEFORE providing any answer. Never answer without first calling searchRunbooks.
2. If searchRunbooks returns an empty array or no results, respond EXACTLY: "No relevant runbook content found." Do NOT provide generic advice or suggestions.
3. Every line of your answer that contains information from runbooks MUST include a citation in the format: [Source: filename]
4. Provide clear, numbered steps (1., 2., 3., etc.)
5. Be concise and actionable
6. Only use information from the searchRunbooks tool results - do not make up or infer information

When citing sources, use the filename from the search results. If a runbook has headings in the text, reference them when relevant.

Format your response with:
- Clear numbered steps
- Source citations on EVERY line that uses runbook information: [Source: filename]
- Brief explanations where needed

Example format:
1. First step based on runbook content [Source: database-troubleshooting.md]
2. Second step [Source: database-troubleshooting.md]
3. Third step [Source: memory-optimization.md]`;

// Create agent with OpenAI LLM
export const runbookAgent = agent({
  tools: [searchRunbooksTool],
  llm: openai({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }),
  systemPrompt: SYSTEM_PROMPT,
});

// Stream agent response and track retrieved chunks
export async function* generateResponse(
  userMessage: string
): AsyncGenerator<{ type: 'text' | 'sources'; data: string | Array<{ id: string; filename: string; chunkIndex: number }> }, void, unknown> {
  const workflowStream = runbookAgent.runStream(userMessage);
  const retrievedChunks: Array<{ id: string; filename: string; chunkIndex: number }> = [];

  for await (const event of workflowStream as unknown as AsyncIterable<any>) {
    if (agentToolCallEvent.include(event) && event.data.toolName === 'searchRunbooks') {
      // Parse tool result to extract chunk IDs
      try {
        const toolCall = event.data as any;
        const toolResult = JSON.parse(toolCall.result || toolCall.output || '[]');
        if (Array.isArray(toolResult)) {
          for (const chunk of toolResult) {
            if (chunk.id && chunk.filename !== undefined) {
              retrievedChunks.push({
                id: chunk.id,
                filename: chunk.filename,
                chunkIndex: chunk.chunkIndex,
              });
            }
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
    
    if (agentStreamEvent.include(event)) {
      yield { type: 'text', data: event.data.delta };
    }
  }

  // Yield sources at the end
  yield { type: 'sources', data: retrievedChunks };
}

// Export search function for direct use if needed
export { searchRunbooks };
