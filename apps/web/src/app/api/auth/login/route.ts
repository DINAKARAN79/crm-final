import { NextRequest, NextResponse } from 'next/server';
import { getUpstreamFailureStatus } from '@/lib/upstream-error';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const forwardedProto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
    if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

    const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Login failed' },
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
    console.error('Login proxy error:', error);
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
