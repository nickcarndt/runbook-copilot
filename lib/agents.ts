import { tool } from 'llamaindex';
import { agent, agentStreamEvent, agentToolCallEvent } from '@llamaindex/workflow';
import { openai as openaiFactory } from '@llamaindex/openai';
import { z } from 'zod';
import { searchRunbooks } from './retrieval';

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
3. Format the entire answer as Markdown.
4. Always return a numbered list (1., 2., 3., etc.). Do NOT use headings like # or ##.
5. Every command must be inside a fenced code block with language bash:

\`\`\`bash
command here
\`\`\`

6. Put citations at the end of each step exactly like: Source: [filename](#sources)
7. Only use information from the searchRunbooks tool results - do not make up or infer information

When citing sources, use the filename from the search results.

Example format:
1. First step based on runbook content

\`\`\`bash
ps aux
free -h
\`\`\`

Source: [database-troubleshooting.md](#sources)

2. Second step with explanation

Source: [database-troubleshooting.md](#sources)

3. Third step

Source: [memory-optimization.md](#sources)`;

// Lazy agent creation - only initialize at runtime, not at build time
let runbookAgentInstance: ReturnType<typeof agent> | null = null;

function getRunbookAgent() {
  if (!runbookAgentInstance) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    runbookAgentInstance = agent({
      tools: [searchRunbooksTool],
      llm: openaiFactory({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }),
      systemPrompt: SYSTEM_PROMPT,
    });
  }
  return runbookAgentInstance;
}

// Export getter function instead of direct agent instance
export function getRunbookAgentInstance() {
  return getRunbookAgent();
}

// Stream agent response and track retrieved chunks
export async function* generateResponse(
  userMessage: string
): AsyncGenerator<{ type: 'text' | 'sources'; data: string | Array<{ id: string; filename: string; chunkIndex: number }> }, void, unknown> {
  const runbookAgent = getRunbookAgent();
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
