import { defineMiddleware } from 'astro:middleware';
import { validateSessionToken } from '@/lib/auth/session';
import { readSessionCookie, setSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';

export const onRequest = defineMiddleware(async (context, next) => {
  const token = readSessionCookie(context.cookies);

  if (!token) {
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }

  const result = await validateSessionToken(token);
  if (!result) {
    clearSessionCookie(context.cookies);
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }

  // Refresh cookie expiry on each valid request
  setSessionCookie(context.cookies, token, result.session.expiresAt);
  context.locals.user = result.user;
  context.locals.session = result.session;

  return next();
});
