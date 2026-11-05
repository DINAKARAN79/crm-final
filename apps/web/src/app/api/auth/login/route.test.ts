import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

describe('login proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards client proxy metadata and the refresh cookie from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { token: 'access-token' } }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'crm_refresh_session-secret=refresh-token; HttpOnly; Path=/api; SameSite=Lax',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('https://crm.example.test/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-host': 'crm.example.test',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email: 'user@example.test', password: 'password' }),
    });

    const response = await POST(request);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/login$/),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
          'x-forwarded-host': 'crm.example.test',
          'x-forwarded-proto': 'https',
        },
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('crm_refresh_session-secret=refresh-token');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('returns 504 when the authentication service times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')));

    const request = new NextRequest('https://crm.example.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'password' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Authentication service timed out',
    });
  });
});
