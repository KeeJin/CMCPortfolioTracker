import type { NextFunction, Request, Response } from 'express';

import { SESSION_COOKIE_NAME, getSessionFromToken } from '../auth.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    email: string;
  };
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSessionFromToken(token);

  if (!session) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  req.user = session;
  next();
}
