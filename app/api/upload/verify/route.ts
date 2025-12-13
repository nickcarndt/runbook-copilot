import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { checkRateLimit, getClientIP } from '@/lib/rateLimit';

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
      return NextResponse.json(
        {
          request_id: requestId,
          valid: false,
          latency_ms: latency,
        },
        { status: 200 }
      );
    }

    const uploadToken = process.env.UPLOAD_TOKEN;
    const headerToken = request.headers.get('x-upload-token');

    if (!uploadToken) {
      // No token configured, allow all (for local dev)
      return NextResponse.json(
        {
          request_id: requestId,
          valid: true,
          latency_ms: Date.now() - startTime,
        },
        { status: 200 }
      );
    }

    const isValid = headerToken === uploadToken;

    return NextResponse.json(
      {
        request_id: requestId,
        valid: isValid,
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
        valid: false,
        error: { message: errorMessage, code: 'INTERNAL_ERROR' },
        latency_ms: latency,
      },
      { status: 200 }
    );
  }
}

