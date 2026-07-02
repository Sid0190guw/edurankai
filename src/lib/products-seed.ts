// Server-side helper: ensure the Viśvambhara product row exists. Called by
// every page that lists products so the row appears the first time any of
// them is visited, not only after someone hits the hub page.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let seeded = false;

export async function ensureVisvambharaProduct(): Promise<void> {
  if (seeded) return;
  try {
    await db.execute(sql`
      INSERT INTO products (slug, name, emphasis_word, status, short_description, long_description, external_url, icon_key, sort_order)
      VALUES (
        'visvambhara',
        'Viśvambhara',
        'aerospace',
        'research',
        'Autonomous aerospace concept: a three-tier swarm — Bee micro-UAV, Mother SSTO ship, Grandmother interplanetary command vessel.',
        'Viśvambhara is EduRankAI''s frontier aerospace research line. The flagship VESPER concept demonstrates a single parametric family across three scales: a 3.2 g bee-class micro-UAV, a 38 t blended-lifting-body Mother Ship that carries 100,000 bees from atmosphere to orbit, and a 28,000 t Grandmother command vessel that berths 500 Mother Ships and commands 50 million bees across the solar system. Includes interactive CFD, flight profile, fleet 3D viewer, and architecture documents.',
        '/products/visvambhara',
        'aerospace',
        40
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        emphasis_word = EXCLUDED.emphasis_word,
        status = EXCLUDED.status,
        short_description = EXCLUDED.short_description,
        long_description = EXCLUDED.long_description,
        external_url = EXCLUDED.external_url,
        is_visible = true
    `);
    seeded = true;
  } catch (_) { /* swallow - listing pages should never 500 because of seed */ }
}

// Canonical copy for the three consumer ventures. The DB rows previously
// carried education-flavored placeholder text (Sancharan as "communication
// infrastructure", Sampark as "bridge between learning and work", Sambandh as
// "learning connections") — wrong: they are travel, CRM, and matchmaking.
// The upsert below inserts the rows if missing and REPLACES the copy only
// while the row still carries the old placeholder wording (detected by
// markers like "Sanskrit for" / "learner"), so later manual edits made in
// /admin/products are never overwritten.
export const VENTURE_COPY = [
  {
    slug: 'sancharan',
    name: 'Sancharan',
    emphasisWord: 'journeys',
    short: 'Journeys, reimagined. A consumer travel venture by EduRankAI — being built carefully in India to serve every kind of journey that matters: weekend trips, family vacations, pilgrimages, heritage circuits, educational tours, corporate offsites, and more.',
    long: 'Where today’s apps treat every traveler the same, Sancharan respects that each journey is different. A pilgrimage is not a weekend getaway; a school tour is not a corporate offsite — each deserves planning, pacing, and care of its own.\n\nSancharan is built without dark patterns, hidden fees, or fake urgency: no countdown timers pressuring you to book, no prices that quietly change while you decide, no pre-ticked add-ons. Honest journeys, planned well — for every kind of traveler in India.',
    sortOrder: 60,
  },
  {
    slug: 'sampark',
    name: 'Sampark',
    emphasisWord: 'workspace',
    short: 'A modern CRM and communication platform that brings every customer conversation, contact detail, and transaction into a single, encrypted workspace. Capture leads through shareable forms, message customers instantly, jump on video calls, and collect payments — all without leaving the app.',
    long: 'One workspace for contacts, chat, pipeline, meetings, forms, sites, and payments.\nReal-time chat with read receipts and read-depth tracking on long messages.\nVideo and voice calls, with 3D meeting rooms and hologram meetings on the roadmap.\nShareable lead-capture forms with every field type — text, file, signature, payment, and more.\nVisual sales pipeline with drag-and-drop deal stages.\nAI-powered website builder — from a single sentence to a live site in minutes.\nIntegrated payments — UPI for small, cards for medium, international wires for large.\nEnd-to-end encrypted, GDPR-ready, with row-level security on every record.\nBuilt for the 6G era — ultra-low latency and AI-native by design.\nMade in Bharat — free to start, scales as you grow.',
    sortOrder: 61,
  },
  {
    slug: 'sambandh',
    name: 'Sambandh',
    emphasisWord: 'verified',
    short: 'India’s only dating platform where every profile is verified by government ID and every profession is cross-checked — no fake doctors, no fake engineers, no catfish.',
    long: 'What makes Sambandh genuinely different is the Karma Book: an AI that silently watches chat behaviour across the platform and catches users who lie about exclusivity, manipulate matches, or run scams — without ever exposing anyone’s private messages.\n\nUsers declare their intent openly — marriage, dating, casual, or friendship — so there is no guessing what someone actually wants. Anonymous chat lets you connect honestly before revealing who you are, with identity shared only when both sides agree.\n\nTwo unique match signals go beyond swipe-and-hope: real Vedic astrology compatibility (actual guna milan, not sun-sign guesswork), paired with engagement compatibility computed from how well you actually chat.\n\nAnd because behaviour on the platform shapes your visible reputation score, people who ghost, love-bomb, or deceive do not get away with it — their next match sees a quiet warning before investing emotionally.',
    sortOrder: 62,
  },
] as const;

let ventureCopySynced = false;

export async function ensureVentureCopy(): Promise<void> {
  if (ventureCopySynced) return;
  try {
    for (const v of VENTURE_COPY) {
      await db.execute(sql`
        INSERT INTO products (slug, name, emphasis_word, status, short_description, long_description, sort_order)
        VALUES (${v.slug}, ${v.name}, ${v.emphasisWord}, 'in_development', ${v.short}, ${v.long}, ${v.sortOrder})
        ON CONFLICT (slug) DO UPDATE SET
          short_description = EXCLUDED.short_description,
          long_description = EXCLUDED.long_description,
          emphasis_word = EXCLUDED.emphasis_word,
          updated_at = NOW()
        WHERE products.short_description IS NULL
           OR products.short_description = ''
           OR products.short_description ILIKE '%sanskrit for%'
           OR products.short_description ILIKE '%learner%'
           OR products.short_description ILIKE '%learning%'
           OR products.short_description ILIKE '%educational organisations%'
      `);
    }
    ventureCopySynced = true;
  } catch (_) { /* never 500 a page because of copy sync */ }
}
