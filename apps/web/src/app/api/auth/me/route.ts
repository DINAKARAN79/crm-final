import { NextRequest, NextResponse } from 'next/server';
import { getUpstreamFailureStatus } from '@/lib/upstream-error';

export const dynamic = 'force-dynamic';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie') || '';
    const headers: Record<string, string> = { cookie: cookieHeader };
    const authorizationHeader = request.headers.get('authorization');
    const sessionAuthHeader = request.headers.get('x-session-auth');
    if (authorizationHeader) headers.authorization = authorizationHeader;
    if (sessionAuthHeader) headers['x-session-auth'] = sessionAuthHeader;

    const response = await fetch(`${BACKEND_URL}/api/auth/me`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Not authenticated' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Auth me proxy error:', error);
    const status = getUpstreamFailureStatus(error);
    return NextResponse.json(
      {
        success: false,
        error: status === 504
          ? 'Authentication service timed out'
          : 'Unable to connect to authentication service',
      },
      { status }
    );
  }
}
