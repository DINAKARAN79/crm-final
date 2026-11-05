import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

describe('logout proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves backend error statuses instead of returning success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Authentication service unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const response = await POST(new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Authentication service unavailable',
    });
  });

  it('returns 504 when the authentication service times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')));

    const response = await POST(new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
    }));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Authentication service timed out',
    });
  });
});
