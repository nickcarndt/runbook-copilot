import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getRunbookAgentInstance } from '@/lib/agents';
import { logQuery } from '@/lib/db';
import { agentStreamEvent, agentToolCallEvent } from '@llamaindex/workflow';
import { checkRateLimit, getClientIP } from '@/lib/rateLimit';

const requestSchema = z.object({
  message: z.string().min(1),
});

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = uuidv4();

  try {
    // Rate limiting
    const clientIP = getClientIP(request);
    const rateLimit = checkRateLimit(clientIP, 10, 60 * 1000); // 10 requests per minute
    if (!rateLimit.allowed) {
      const latency = Date.now() - startTime;
      await logQuery(requestId, latency, 'error', 'Rate limit exceeded');
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT' },
          latency_ms: latency,
        },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { message } = requestSchema.parse(body);

    // Validate OPENAI_API_KEY at runtime (not build time)
    if (!process.env.OPENAI_API_KEY) {
      const latency = Date.now() - startTime;
      await logQuery(requestId, latency, 'error', 'OPENAI_API_KEY not set');
      return NextResponse.json(
        {
          request_id: requestId,
          error: { message: 'OPENAI_API_KEY environment variable is not set', code: 'CONFIG_ERROR' },
          latency_ms: latency,
        },
        { status: 500 }
      );
    }

    // Track retrieved chunks and tool calls
    const retrievedChunkIds: string[] = [];
    const sources: Array<{ id: string; filename: string; chunkIndex: number }> = [];
    let toolCallsCount = 0;

    // Get agent instance (lazy initialization)
    const runbookAgent = getRunbookAgentInstance();

    // Create streaming response using workflow agent
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          const workflowStream = runbookAgent.runStream(message);

          for await (const event of workflowStream as unknown as AsyncIterable<any>) {
            // Track tool calls to capture retrieved chunks
            if (agentToolCallEvent.include(event) && event.data.toolName === 'searchRunbooks') {
              toolCallsCount++;
              try {
                const toolCall = event.data as any;
                const toolResult = JSON.parse(toolCall.result || toolCall.output || '[]');
                if (Array.isArray(toolResult)) {
                  for (const chunk of toolResult) {
                    if (chunk.id) {
                      retrievedChunkIds.push(chunk.id);
                      sources.push({
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

            // Stream text tokens
            if (agentStreamEvent.include(event)) {
              controller.enqueue(encoder.encode(event.data.delta));
            }
          }

          // Send sources as final JSON event with debug info
          const sourcesEvent = {
            type: 'sources',
            request_id: requestId,
            sources: sources,
            tool_calls_count: toolCallsCount,
            retrieval_results_count: sources.length,
            ...(toolCallsCount === 0 ? { note: 'agent_did_not_call_tool' } : {}),
          };
          controller.enqueue(encoder.encode(`\n\n<SOURCES>${JSON.stringify(sourcesEvent)}</SOURCES>`));
          
          controller.close();

          // Log success with chunk IDs after streaming completes
          const latency = Date.now() - startTime;
          await logQuery(requestId, latency, 'success', undefined, retrievedChunkIds);
        } catch (error) {
          const latency = Date.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await logQuery(requestId, latency, 'error', errorMessage);
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Request-ID': requestId,
      },
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Log error
    await logQuery(requestId, latency, 'error', errorMessage);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { 
          request_id: requestId,
          error: { message: 'Invalid request body', code: 'VALIDATION_ERROR' },
          latency_ms: latency,
        },
        { 
          status: 400,
          headers: { 'X-Request-ID': requestId },
        }
      );
    }

    return NextResponse.json(
      { 
        request_id: requestId,
        error: { message: errorMessage, code: 'INTERNAL_ERROR' },
        latency_ms: latency,
      },
      { 
        status: 500,
        headers: { 'X-Request-ID': requestId },
      }
    );
  }
}
