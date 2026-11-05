import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const baseUrl = (__ENV.CRM_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const parsedBaseUrl = new URL(baseUrl);
const targetUsers = Number.parseInt(__ENV.CRM_TARGET_USERS || '10', 10);
const emailTemplate = __ENV.CRM_EMAIL_TEMPLATE || '';
const email = __ENV.CRM_EMAIL || '';
const password = __ENV.CRM_PASSWORD || '';
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

if (!Number.isSafeInteger(targetUsers) || targetUsers < 1) {
  throw new Error('CRM_TARGET_USERS must be a positive integer.');
}
if (!localHosts.has(parsedBaseUrl.hostname) && __ENV.CRM_ALLOW_REMOTE_LOAD !== 'yes') {
  throw new Error('Remote load tests are disabled by default; use an isolated staging system and set CRM_ALLOW_REMOTE_LOAD=yes.');
}
if (!localHosts.has(parsedBaseUrl.hostname) && __ENV.CRM_TARGET_ENV !== 'isolated-staging') {
  throw new Error('Remote load tests require CRM_TARGET_ENV=isolated-staging; production targets are prohibited.');
}
if (targetUsers > 40 && !emailTemplate.includes('{vu}')) {
  throw new Error('Use CRM_EMAIL_TEMPLATE with a {vu} placeholder and isolated test accounts above 40 VUs.');
}
if ((!email && !emailTemplate.includes('{vu}')) || !password) {
  throw new Error('Set CRM_EMAIL and CRM_PASSWORD, or CRM_EMAIL_TEMPLATE with {vu}, plus CRM_PASSWORD.');
}

const rampDuration = __ENV.CRM_RAMP_DURATION || '2m';
const holdDuration = __ENV.CRM_HOLD_DURATION || '5m';
const authenticationSuccess = new Rate('crm_authentication_success');
const unexpectedAuthFailures = new Counter('crm_unexpected_auth_failures');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    crm_active_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: rampDuration, target: Math.max(1, Math.ceil(targetUsers * 0.1)) },
        { duration: rampDuration, target: Math.max(1, Math.ceil(targetUsers * 0.5)) },
        { duration: rampDuration, target: targetUsers },
        { duration: holdDuration, target: targetUsers },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    crm_authentication_success: ['rate>0.99'],
    crm_unexpected_auth_failures: ['count<1'],
  },
};

let accessToken;

function credentialsForVu() {
  const vuEmail = emailTemplate
    ? emailTemplate.replaceAll('{vu}', String(__VU))
    : email;
  return { email: vuEmail, password };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'x-session-auth': 'required',
    'Content-Type': 'application/json',
  };
}

function recordAuthenticationResponse(response) {
  const successful = response.status === 200;
  authenticationSuccess.add(successful);
  if (response.status === 401) unexpectedAuthFailures.add(1);
  return successful;
}

export default function () {
  if (!accessToken) {
    const login = http.post(
      `${baseUrl}/api/auth/login`,
      JSON.stringify(credentialsForVu()),
      { headers: { 'Content-Type': 'application/json' }, tags: { workflow: 'login' } },
    );
    const loginOk = recordAuthenticationResponse(login) && check(login, {
      'login succeeds': (response) => response.status === 200 && Boolean(response.json('data.token')),
    });
    if (!loginOk) {
      sleep(1);
      return;
    }
    accessToken = login.json('data.token');
  }

  const headers = authHeaders(accessToken);
  const me = http.get(`${baseUrl}/api/proxy/api/auth/me`, {
    headers,
    tags: { workflow: 'authenticated-me' },
  });
  recordAuthenticationResponse(me);
  check(me, { 'session is authenticated': (response) => response.status === 200 });

  const leads = http.get(`${baseUrl}/api/proxy/api/leads?page=1&limit=20`, {
    headers,
    tags: { workflow: 'lead-list' },
  });
  recordAuthenticationResponse(leads);
  check(leads, { 'lead list responds successfully': (response) => response.status === 200 });

  const dashboardsPath = __ENV.CRM_DASHBOARD_PATH || '/api/proxy/api/dashboards';
  const dashboards = http.get(`${baseUrl}${dashboardsPath}`, {
    headers,
    tags: { workflow: 'dashboard-list' },
  });
  recordAuthenticationResponse(dashboards);
  check(dashboards, { 'dashboard list responds successfully': (response) => response.status === 200 });

  if (__ENV.CRM_REFRESH_EVERY_ITERATION === 'true') {
    const refreshed = http.post(`${baseUrl}/api/proxy/api/auth/refresh`, null, {
      headers,
      tags: { workflow: 'refresh' },
    });
    recordAuthenticationResponse(refreshed);
    const refreshedToken = refreshed.json('data.token');
    const refreshOk = check(refreshed, {
      'refresh succeeds': (response) => response.status === 200 && Boolean(response.json('data.token')),
    });
    if (refreshOk) accessToken = refreshedToken;
  }

  if (__ENV.CRM_LOGOUT_EVERY_ITERATION === 'true') {
    const logout = http.post(`${baseUrl}/api/proxy/api/auth/logout`, null, {
      headers: authHeaders(accessToken),
      tags: { workflow: 'logout' },
    });
    recordAuthenticationResponse(logout);
    check(logout, { 'logout succeeds': (response) => response.status === 200 });
    accessToken = undefined;
  }

  sleep(1);
}
