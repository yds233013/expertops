import { CSRF_COOKIE } from '@/lib/csrf-constants';

/**
 * Edge-runtime CSRF token minting.
 *
 * Next.js middleware runs on the Edge runtime, which has no `node:crypto`. This
 * module uses Web Crypto instead. HMAC-SHA256 over the same secret produces the
 * same digest as the Node implementation in `csrf.ts`, so a token minted here
 * verifies there and vice versa. The two must stay in step; the shared shape is
 * `<token>.<base64url(hmac)>`.
 */
export { CSRF_COOKIE };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateEdgeToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function signEdgeToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return `${token}.${toBase64Url(new Uint8Array(signature))}`;
}
