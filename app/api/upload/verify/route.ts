import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = uuidv4();

  try {
    const uploadToken = process.env.UPLOAD_TOKEN;
    const headerToken = request.headers.get('x-upload-token');

    if (!uploadToken) {
      // No token configured, allow all (for local dev)
      return NextResponse.json(
        {
          request_id: requestId,
          ok: true,
          latency_ms: Date.now() - startTime,
        },
        { status: 200 }
      );
    }

    if (!headerToken || headerToken !== uploadToken) {
      const latency = Date.now() - startTime;
      return NextResponse.json(
        {
          request_id: requestId,
          error: { code: 'INVALID_UPLOAD_CODE', message: 'Invalid upload code' },
          latency_ms: latency,
        },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        request_id: requestId,
        ok: true,
        latency_ms: Date.now() - startTime,
      },
      { status: 200 }
    );
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return NextResponse.json(
      {
        request_id: requestId,
        error: { message: errorMessage, code: 'INTERNAL_ERROR' },
        latency_ms: latency,
      },
      { status: 500 }
    );
  }
}

