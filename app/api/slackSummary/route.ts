import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { logQuery } from '@/lib/db';
import OpenAI from 'openai';

const requestSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

// Demo safety gate
function checkDemoToken(request: NextRequest): boolean {
  const demoToken = process.env.RBC_DEMO_TOKEN;
  if (!demoToken) return true;
  const headerToken = request.headers.get('x-rbc-token');
  return headerToken === demoToken;
}

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
    model: 'gpt-4o-mini',
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
    // Demo safety gate
    if (!checkDemoToken(request)) {
      await logQuery(requestId, Date.now() - startTime, 'error', JSON.stringify({ type: 'slack_summary', error: 'Unauthorized' }));
      return NextResponse.json(
        { error: 'Unauthorized', request_id: requestId },
        { status: 401 }
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

