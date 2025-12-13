import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { searchRunbooks } from '@/lib/agents';
import { logQuery } from '@/lib/db';

const requestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().optional().default(5),
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
    const { query: queryText, topK } = requestSchema.parse(body);

    // Call searchRunbooks directly
    const results = await searchRunbooks(queryText, topK);

    // Format results with text preview
    const formattedResults = results.map(result => ({
      id: result.id,
      filename: result.filename,
      chunkIndex: result.chunkIndex,
      textPreview: result.text.substring(0, 200) + (result.text.length > 200 ? '...' : ''),
    }));

    const latency = Date.now() - startTime;

    // Log the retrieval
    const chunkIds = results.map(r => r.id);
    await logQuery(requestId, latency, 'success', undefined, chunkIds);

    return NextResponse.json({
      request_id: requestId,
      results: formattedResults,
      latency_ms: latency,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    // Log error (non-blocking)
    try {
      await logQuery(requestId, latency, 'error', errorMessage);
    } catch (logError) {
      // Ignore logging errors
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.errors, request_id: requestId },
        { status: 400 }
      );
    }

    // Return detailed error for debugging
    return NextResponse.json(
      { 
        error: errorMessage, 
        request_id: requestId,
        latency_ms: latency,
        stack: process.env.NODE_ENV === 'development' ? errorStack : undefined
      },
      { status: 500 }
    );
  }
}

