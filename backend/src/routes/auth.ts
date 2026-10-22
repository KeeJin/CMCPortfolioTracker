import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';

import {
  SESSION_COOKIE_NAME,
  clearSessionToken,
  createSessionToken,
  getSessionFromToken,
  isAllowedEmail,
  normalizeEmail,
} from '../auth.js';

const router = Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function getCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'none' | 'lax' | 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

router.post('/google', async (req, res) => {
  const { credential } = req.body ?? {};

  if (typeof credential !== 'string' || !credential.trim()) {
    res.status(400).json({ error: 'Google credential is required.' });
    return;
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured on the backend.' });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });

    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    const allowedEmail = normalizeEmail(process.env.ALLOWED_GOOGLE_EMAIL);

    if (!payload?.email_verified || !email) {
      res.status(401).json({ error: 'Google account email is missing or unverified.' });
      return;
    }

    if (!isAllowedEmail(email, allowedEmail)) {
      res.status(403).json({
        error: `Google account ${email} is not authorized for this app.`,
      });
      return;
    }

    const sessionToken = createSessionToken(email);
    res.cookie(SESSION_COOKIE_NAME, sessionToken, getCookieOptions());
    res.status(200).json({ success: true, user: { email } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to verify the Google login.';
    res.status(401).json({ error: message });
  }
});

router.get('/session', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSessionFromToken(token);

  if (!session) {
    res.status(200).json({ authenticated: false, user: null });
    return;
  }

  res.json({ authenticated: true, user: { email: session.email } });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  clearSessionToken(token);
  const isProduction = process.env.NODE_ENV === 'production';
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/', sameSite: isProduction ? 'none' : 'lax', secure: isProduction });
  res.json({ success: true });
});

export default router;
