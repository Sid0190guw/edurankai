import type { APIRoute } from 'astro';
import { invalidateSession } from '@/lib/auth/session';
import { readSessionCookie, clearSessionCookie } from '@/lib/auth/cookie';

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const token = readSessionCookie(cookies);
  if (token) {
    await invalidateSession(token);
  }
  clearSessionCookie(cookies);
  return redirect('/admin/login');
};

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const token = readSessionCookie(cookies);
  if (token) await invalidateSession(token);
  clearSessionCookie(cookies);
  return redirect('/admin/login');
};
