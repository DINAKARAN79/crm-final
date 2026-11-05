import { PrismaClient } from '@prisma/client';

function positiveIntegerEnv(name: string, defaultValue: number) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function databaseUrlWithPoolLimits() {
  const value = process.env.DATABASE_URL;
  if (!value) return undefined;

  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return value;

  const settings: Array<[string, string, number]> = [
    ['DATABASE_CONNECTION_LIMIT', 'connection_limit', 10],
    ['DATABASE_POOL_TIMEOUT', 'pool_timeout', 10],
    ['DATABASE_CONNECT_TIMEOUT', 'connect_timeout', 10],
  ];
  for (const [environmentName, queryName, defaultValue] of settings) {
    if (process.env[environmentName] || !url.searchParams.has(queryName)) {
      url.searchParams.set(queryName, String(positiveIntegerEnv(environmentName, defaultValue)));
    }
  }
  return url.toString();
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};
const datasourceUrl = databaseUrlWithPoolLimits();

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  ...(datasourceUrl
    ? { datasources: { db: { url: datasourceUrl } } }
    : {}),
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';
export * from './unit-field-tags';
