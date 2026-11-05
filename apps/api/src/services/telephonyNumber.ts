export function maskPhone(e164: string) {
  if (e164.length <= 6) return '******';
  return `${e164.slice(0, 3)}${'*'.repeat(Math.max(4, e164.length - 7))}${e164.slice(-4)}`;
}
