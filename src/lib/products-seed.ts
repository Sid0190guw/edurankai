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
