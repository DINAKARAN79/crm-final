import axios, {
  AxiosAdapter,
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = window.fetch;
const originalAxiosAdapter = axios.defaults.adapter;

function response(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown = {},
): AxiosResponse {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: {},
    config,
  };
}

function requestError(config: InternalAxiosRequestConfig, status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    undefined,
    config,
    undefined,
    response(config, status),
  );
}

async function loadApi(adapter: AxiosAdapter, fetchMock: typeof window.fetch) {
  vi.resetModules();
  window.history.replaceState(null, '', '/dashboard');
  window.sessionStorage.clear();
  window.fetch = fetchMock;
  (window as Window & { __crmSessionFetchInstalled?: boolean }).__crmSessionFetchInstalled = false;
  axios.defaults.adapter = adapter;

  const api = await import('./api');
  api.setSessionToken('expired-access-token');
  return api;
}

describe('authenticated session refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.fetch = nativeFetch;
    (window as Window & { __crmSessionFetchInstalled?: boolean }).__crmSessionFetchInstalled = false;
    axios.defaults.adapter = originalAxiosAdapter;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('shares one refresh across concurrent fetch requests and retries both once', async () => {
    let refreshCalls = 0;
    const adapter: AxiosAdapter = async (config) => {
      if (config.url?.includes('/api/auth/refresh')) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return response(config, 200, { success: true, data: { token: 'new-access-token' } });
      }
      throw requestError(config, 401);
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      return new Response(null, { status: authorization === 'Bearer new-access-token' ? 200 : 401 });
    });
    await loadApi(adapter, fetchMock);

    const responses = await Promise.all([
      window.fetch('/api/proxy/api/auth/me'),
      window.fetch('/api/proxy/api/auth/me'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(window.sessionStorage.getItem('crm-session-token')).toBe('new-access-token');
  });

  it.each([429, 503])('preserves the valid browser token when refresh returns %s', async (status) => {
    const adapter: AxiosAdapter = async (config) => {
      if (config.url?.includes('/api/auth/refresh')) {
        throw requestError(config, status);
      }
      throw requestError(config, 401);
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    const { authApi } = await loadApi(adapter, fetchMock);

    await expect(authApi.me()).rejects.toMatchObject({ response: { status } });

    expect(window.sessionStorage.getItem('crm-session-token')).toBe('expired-access-token');
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('retries authentication immediately after a temporary refresh dependency failure recovers', async () => {
    let databaseAvailable = false;
    const adapter: AxiosAdapter = async (config) => {
      if (config.url?.includes('/api/auth/refresh')) {
        if (!databaseAvailable) throw requestError(config, 503);
        return response(config, 200, { success: true, data: { token: 'recovered-access-token' } });
      }
      if (config.headers.get('Authorization') === 'Bearer recovered-access-token') {
        return response(config, 200, { success: true });
      }
      throw requestError(config, 401);
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    const { authApi } = await loadApi(adapter, fetchMock);

    await expect(authApi.me()).rejects.toMatchObject({ response: { status: 503 } });
    expect(window.sessionStorage.getItem('crm-session-token')).toBe('expired-access-token');

    databaseAvailable = true;
    await expect(authApi.me()).resolves.toMatchObject({ data: { success: true } });
    expect(window.sessionStorage.getItem('crm-session-token')).toBe('recovered-access-token');
  });

  it('retries refresh-token rotation conflicts until another tab finishes rotating', async () => {
    let refreshCalls = 0;
    let initialProtectedCalls = 0;
    const adapter: AxiosAdapter = async (config) => {
      if (config.url?.includes('/api/auth/refresh')) {
        refreshCalls += 1;
        if (refreshCalls <= 2) throw requestError(config, 409);
        return response(config, 200, { success: true, data: { token: 'rotated-access-token' } });
      }
      if (config.headers.get('Authorization') === 'Bearer rotated-access-token') {
        return response(config, 200, { success: true });
      }
      initialProtectedCalls += 1;
      throw requestError(config, 401);
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    const { authApi } = await loadApi(adapter, fetchMock);

    await expect(authApi.me()).resolves.toMatchObject({ data: { success: true } });

    expect(initialProtectedCalls).toBe(1);
    expect(refreshCalls).toBe(3);
    expect(window.sessionStorage.getItem('crm-session-token')).toBe('rotated-access-token');
  });

  it.each([20, 30, 60])('recovers after a simulated access-token expiration at %i minutes', async (minutes) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let refreshCalls = 0;
    let activeToken = 'expired-access-token';
    const adapter: AxiosAdapter = async (config) => {
      if (config.url?.includes('/api/auth/refresh')) {
        refreshCalls += 1;
        activeToken = 'refreshed-access-token';
        return response(config, 200, { success: true, data: { token: activeToken } });
      }
      if (Date.now() - startedAt >= 15 * 60 * 1000 &&
          config.headers.get('Authorization') === 'Bearer expired-access-token') {
        throw requestError(config, 401);
      }
      return response(config, 200, { success: true });
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );

    try {
      const { authApi } = await loadApi(adapter, fetchMock);
      await vi.advanceTimersByTimeAsync(minutes * 60 * 1000);
      await expect(authApi.me()).resolves.toMatchObject({ data: { success: true } });
      expect(refreshCalls).toBe(1);
      expect(window.sessionStorage.getItem('crm-session-token')).toBe('refreshed-access-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
