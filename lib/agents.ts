import { tool } from '@llamaindex/core';
import { agent, agentStreamEvent, agentToolCallEvent } from '@llamaindex/workflow';
import { openai } from '@llamaindex/openai';
import { z } from 'zod';
import { query } from './db';
import { createEmbedding } from './indexing';

// Vector search in Postgres
async function searchRunbooks(queryText: string, topK: number = 5): Promise<Array<{ id: string; text: string; filename: string; chunkIndex: number }>> {
  // Create embedding for query
  const queryEmbedding = await createEmbedding(queryText);

  // Vector similarity search
  const result = await query(
    `SELECT 
       c.id,
       c.text,
       c.chunk_index,
       d.filename
     FROM chunks c
     JOIN documents d ON c.document_id = d.id
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [JSON.stringify(queryEmbedding), topK]
  );

  return result.rows.map(row => ({
    id: row.id,
    text: row.text,
    filename: row.filename,
    chunkIndex: row.chunk_index,
  }));
}

// Create searchRunbooks tool
const searchRunbooksTool = tool(
  async ({ query, topK = 5 }: { query: string; topK?: number }) => {
    const results = await searchRunbooks(query, topK);
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

Your responses must:
1. Provide clear, numbered steps (1., 2., 3., etc.)
2. Cite sources by runbook title/heading using format: [Source: filename]
3. Be concise and actionable
4. Only use information from the searchRunbooks tool results

When citing sources, use the filename from the search results. If a runbook has headings in the text, reference them when relevant.

Format your response with:
- Clear numbered steps
- Source citations in brackets: [Source: filename]
- Brief explanations where needed`;

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
  const events = runbookAgent.runStream(userMessage);
  const retrievedChunks: Array<{ id: string; filename: string; chunkIndex: number }> = [];

  for await (const event of events) {
    if (agentToolCallEvent.include(event) && event.data.toolName === 'searchRunbooks') {
      // Parse tool result to extract chunk IDs
      try {
        const toolResult = JSON.parse(event.data.result || '[]');
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
