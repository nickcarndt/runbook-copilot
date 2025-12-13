import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    publicDemo: process.env.PUBLIC_DEMO === 'true',
  });
}

