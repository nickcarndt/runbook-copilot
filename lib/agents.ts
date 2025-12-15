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

    // For demo/recruiter clarity: avoid mixing multiple runbooks in one answer.
    // Keep only chunks from the single best-matching filename (top result).
    const primaryFilename = results?.[0]?.filename;
    const filteredResults = primaryFilename
      ? results.filter((r: any) => r?.filename === primaryFilename)
      : results;
    
    // Structured logging with full context
    console.log(JSON.stringify({
      tool: 'searchRunbooks',
      args_type: argsType,
      args_keys: argsKeys,
      extracted_query_preview: q.trim().substring(0, 60),
      query_length: q.trim().length,
      topK,
      results_count: filteredResults.length,
      primary_filename: primaryFilename ?? null,
      unique_filenames: Array.from(new Set((filteredResults || []).map((r: any) => r?.filename))).filter(Boolean)
    }));
    
    return JSON.stringify(filteredResults, null, 2);
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
const SYSTEM_PROMPT = `You are a runbook assistant. Your job is to answer using ONLY the text returned by the searchRunbooks tool.

CRITICAL RULES — YOU MUST FOLLOW THESE:
1) You MUST call the searchRunbooks tool BEFORE answering. Never answer without calling searchRunbooks.
2) If searchRunbooks returns an empty array, respond EXACTLY: "No relevant runbook content found." (no extra text).
3) Output MUST be valid Markdown.
4) Output MUST be a numbered list ONLY. Every step MUST start with "1.", "2.", "3." etc. Do NOT use headings like "#" or "##" anywhere.
5) Do NOT insert line breaks inside sentences. Only use newlines to separate list items and code fences.
6) If you include shell commands, put them inside a fenced code block using bash. Do NOT show commands inline.
7) At the end of EVERY numbered step, append the citation EXACTLY like: Source: [FILENAME](#sources)
   - No trailing punctuation after the link.
   - Use the filename(s) from the search results.
8) Prefer a single cohesive runbook. Do not mix steps from different runbook files unless the user explicitly asks to compare.

FORMAT TEMPLATE (follow exactly):
1. One clear instruction sentence. Source: [example.md](#sources)

2. Another instruction sentence.

\`\`\`bash
command --flags
another_command
\`\`\`

Source: [example.md](#sources)

3. Final instruction sentence. Source: [example.md](#sources)`;

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
