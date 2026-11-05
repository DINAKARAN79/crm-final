import type { CookieOptions, Response } from 'express';

const REFRESH_COOKIE_PREFIX = 'crm_refresh_';

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api',
};

export function refreshCookieName(sessionSecret: string) {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(sessionSecret)) {
    throw new Error('Invalid session identifier.');
  }
  return `${REFRESH_COOKIE_PREFIX}${sessionSecret}`;
}

export function setRefreshTokenCookie(
  res: Response,
  sessionSecret: string,
  token: string,
  expiresAt: Date,
) {
  res.cookie(refreshCookieName(sessionSecret), token, {
    ...refreshCookieOptions,
    expires: expiresAt,
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
}

export function clearRefreshTokenCookie(res: Response, sessionSecret: string) {
  res.clearCookie(refreshCookieName(sessionSecret), refreshCookieOptions);
}
