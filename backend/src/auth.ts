import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'cmc_portfolio_session';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map<string, { email: string; expiresAt: number }>();

export function normalizeEmail(email?: string | null): string | undefined {
  const trimmed = email?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function isAllowedEmail(email: string | null | undefined, allowedEmail: string | null | undefined): boolean {
  const normalizedEmail = normalizeEmail(email);
  const normalizedAllowedEmail = normalizeEmail(allowedEmail);

  return Boolean(normalizedEmail && normalizedAllowedEmail && normalizedEmail === normalizedAllowedEmail);
}

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET ?? 'cmc-portfolio-dev-secret';
}

export function createSessionToken(email: string): string {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const issuedAt = Date.now();
  const payload = `${sessionId}:${email}:${issuedAt}`;
  const signature = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;

  sessions.set(token, {
    email,
    expiresAt: issuedAt + SESSION_TTL_MS,
  });

  return token;
}

export function getSessionFromToken(token: string | null | undefined): { email: string } | null {
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  return { email: session.email };
}

export function clearSessionToken(token: string | null | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}
