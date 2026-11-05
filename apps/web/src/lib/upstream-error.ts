const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function getUpstreamFailureStatus(error: unknown): 502 | 504 {
  const visited = new Set<object>();
  let current = error;

  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (
      candidate.name === 'TimeoutError' ||
      candidate.name === 'AbortError' ||
      (typeof candidate.code === 'string' && TIMEOUT_CODES.has(candidate.code))
    ) {
      return 504;
    }
    current = candidate.cause;
  }

  return 502;
}
