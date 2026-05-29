# Face 2FA — portable bundle

Drop-in face-recognition 2FA for an **Astro 5 + Postgres** project.
Client-side face detection with `@vladmandic/face-api` (no npm install, no API
keys, models loaded from CDN). Server-side distance comparison so a malicious
client can't fake a match.

## What you get

| File | What it does |
|------|--------------|
| `migration.sql` | Tables: `user_face_enrollments`, `face_verifications`, plus two columns on `users`. Idempotent. |
| `src/lib/face.ts` | Pure helpers: `faceDistance`, `normalizeDescriptor`, `isValidDescriptor`, `FACE_MATCH_THRESHOLD = 0.55`. |
| `src/pages/api/face/enroll.ts` | `POST` — stores the signed-in user's face descriptor. |
| `src/pages/api/face/verify.ts` | `POST` — server-side euclidean distance check; returns `userId` on match. |
| `src/pages/face-2fa/enroll.astro` | Camera page that captures a selfie and POSTs to `/api/face/enroll`. |
| `src/pages/face-2fa/login.astro` | Camera page that POSTs to `/api/face/verify`, then your `/api/auth/create-session`. |
| `src/middleware-snippet.ts` | Drop-in helpers + the 4-line gate to add to your `onRequest`. |

## Wire-up steps

### 1. Run the migration

```bash
psql "$DATABASE_URL" -f migration.sql
```

Assumes you already have a `users(id UUID PK, email)` table. Adjust if yours differs.

### 2. Copy the files

```
src/lib/face.ts                  → your src/lib/face.ts
src/pages/api/face/*             → your src/pages/api/face/*
src/pages/face-2fa/*             → your src/pages/face-2fa/*
```

### 3. Adapt imports

In `api/face/enroll.ts` and `api/face/verify.ts`, the imports are:

```ts
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
```

Replace these with whatever Postgres client you use (drizzle / postgres-js / pg).
The raw SQL queries are standard and work with any of them.

In the enroll page, the route `redirect('/login')` should match your login URL.
In the login page, the success handler calls `/api/auth/create-session`
which **you implement** — it should:

```ts
// POST { userId, factor: 'face' }
// 1. Validate the request came from your own face-verify flow
//    (e.g. require a short-lived signed cookie set after /api/face/verify ok).
// 2. Mint a session token for that userId.
// 3. setCookie(...) and return { ok: true }.
```

For extra safety, you can set an httpOnly `face_pending=<userId>` cookie when
the password step succeeds, then have `/api/auth/create-session` require both
that cookie AND a fresh `/api/face/verify` pass within ~60s.

### 4. Add the middleware gate

See `src/middleware-snippet.ts`. After your existing auth section that sets
`context.locals.user`, add:

```ts
if (context.locals.user && isProtected(path) && !isExempt(path)) {
  const ok = await hasFaceEnrolled(context.locals.user.id);
  if (!ok) return new Response(null, { status: 302, headers: { Location: '/face-2fa/enroll' } });
}
```

That's the entire integration.

## The threshold

`FACE_MATCH_THRESHOLD = 0.55` in `src/lib/face.ts`. Lower = stricter.
- Most reference implementations use 0.6.
- 0.55 has been working well in production for the project this was extracted
  from.
- Don't go below 0.45 — even the same person on a different day rarely matches
  that tightly.

## Common gotchas

1. **HTTPS only.** `getUserMedia()` silently fails on plain HTTP (localhost is
   fine for dev). Vercel/Netlify default to HTTPS — no action.
2. **Models load ~5–15s the first time.** They cache in the browser after
   that. The pages show a progress bar.
3. **Mobile autoplay.** The `<video>` tags use `autoplay muted playsinline` —
   keep those attributes or iOS Safari won't auto-start the preview.
4. **JSONB descriptor format.** Postgres returns the stored descriptor as
   either an array or `{"0": 0.13, "1": -0.02, ...}` depending on driver.
   `normalizeDescriptor()` in `src/lib/face.ts` handles both.
5. **Stop the camera stream on page unload** — the included pages do this in
   `beforeunload`. If you adapt them, keep that.

## Account recovery (important)

A user who can't pass face verification (new device, bad lighting, injured)
will be locked out. Wire one or both:

- **Admin reset:** add a button on your admin Users page that runs
  `DELETE FROM user_face_enrollments WHERE user_id = ?`. User re-enrols at
  next login.
- **Self recovery via knowledge questions / email magic link.** Add an
  unauthenticated route exempt from the face gate (e.g. `/recover`), verify
  identity another way, then clear the enrolment row.

## What's intentionally NOT included

- **Gov-ID matching** (uploading an ID photo and checking the selfie matches
  it). The reference project does this for KYC. If you need it, the math is
  the same: detect+descriptor on the ID image, detect+descriptor on the
  selfie, accept if `faceDistance() < 0.55`.
- **Liveness check** (blink detection to defeat photo/video replay).
  Implementable with the eye landmarks from `faceLandmark68Net` — measure eye
  aspect ratio over time, require a dip below 0.19 then return above 0.27
  within a 9-second window.
- **Bundling face-api locally.** Loading from CDN keeps the install zero-dep.
  If your target environment blocks CDN scripts, mirror
  `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model` to your
  `public/face-api-models/` and adjust `MODEL_URL` in both pages.
