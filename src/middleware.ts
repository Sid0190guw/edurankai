import { defineMiddleware } from 'astro:middleware';
import { validateSessionToken } from '@/lib/auth/session';
import { readSessionCookie, setSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';
import { getDb } from '@/lib/db';

export const onRequest = defineMiddleware(async (context, next) => {
  // Initialize DB with Cloudflare runtime env (if present)
  // On Cloudflare Workers, env vars live at context.locals.runtime.env
  // On Node local, runtime is undefined and getDb falls back to process.env
  const runtimeEnv = (context.locals as any).runtime?.env;
  await getDb(runtimeEnv);

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
  setSessionCookie(context.cookies, token, result.session.expiresAt);
  context.locals.user = result.user;
  context.locals.session = result.session;
  return next();
});
