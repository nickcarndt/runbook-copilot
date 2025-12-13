import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { logQuery } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rateLimit';
import OpenAI from 'openai';

const requestSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Generate Slack incident update
async function generateSlackSummary(question: string, answer: string): Promise<string> {
  const prompt = `Create a concise Slack incident update from this Q&A:

Question: ${question}

Answer: ${answer}

Format as a brief Slack message (2-3 sentences max). Use clear, professional tone. Include the key resolution steps.`;

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a technical writer creating concise incident updates for Slack.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3, // Low temperature for deterministic output
    max_tokens: 200,
  });

  return response.choices[0]?.message?.content || 'Unable to generate summary';
}

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
      await logQuery(requestId, latency, 'error', JSON.stringify({ type: 'slack_summary', error: 'Rate limit exceeded' }));
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
    const { question, answer } = requestSchema.parse(body);

    // Generate Slack summary
    const summary = await generateSlackSummary(question, answer);

    const latency = Date.now() - startTime;

    // Log with type indicator in error_message
    await logQuery(
      requestId,
      latency,
      'success',
      JSON.stringify({ type: 'slack_summary' })
    );

    return NextResponse.json({
      request_id: requestId,
      summary,
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await logQuery(
      requestId,
      latency,
      'error',
      JSON.stringify({ type: 'slack_summary', error: errorMessage })
    );

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

