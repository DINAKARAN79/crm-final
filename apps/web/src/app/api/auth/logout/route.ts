import { NextRequest, NextResponse } from 'next/server';
import { getUpstreamFailureStatus } from '@/lib/upstream-error';

export const dynamic = 'force-dynamic';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie') || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', cookie: cookieHeader };
    const authorizationHeader = request.headers.get('authorization');
    const sessionAuthHeader = request.headers.get('x-session-auth');
    if (authorizationHeader) headers.authorization = authorizationHeader;
    if (sessionAuthHeader) headers['x-session-auth'] = sessionAuthHeader;

    const response = await fetch(`${BACKEND_URL}/api/auth/logout`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Logout failed' },
        { status: response.status }
      );
    }

    const res = NextResponse.json(data);

    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      res.headers.set('set-cookie', setCookieHeader);
    }

    return res;
  } catch (error) {
    console.error('Logout proxy error:', error);
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
