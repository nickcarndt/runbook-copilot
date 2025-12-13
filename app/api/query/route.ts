import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { runbookAgent } from '@/lib/agents';
import { logQuery } from '@/lib/db';
import { agentStreamEvent, agentToolCallEvent } from '@llamaindex/workflow';

const requestSchema = z.object({
  message: z.string().min(1),
});

// Demo safety gate
function checkDemoToken(request: NextRequest): boolean {
  const demoToken = process.env.RBC_DEMO_TOKEN;
  if (!demoToken) return true; // No token set, allow all
  
  const headerToken = request.headers.get('x-rbc-token');
  return headerToken === demoToken;
}

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = uuidv4();

  try {
    // Demo safety gate
    if (!checkDemoToken(request)) {
      await logQuery(requestId, Date.now() - startTime, 'error', 'Unauthorized');
      return NextResponse.json(
        { error: 'Unauthorized', request_id: requestId },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { message } = requestSchema.parse(body);

    // Track retrieved chunks and tool calls
    const retrievedChunkIds: string[] = [];
    const sources: Array<{ id: string; filename: string; chunkIndex: number }> = [];
    let toolCallsCount = 0;

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
        { error: 'Invalid request body', details: error.errors, request_id: requestId },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: errorMessage, request_id: requestId },
      { status: 500 }
    );
  }
}
