// GET /api/aquintutor/mind/dataset?part=train|validation|manifest — the curated fine-tuning corpus.
//
// This is the one door the training corpus leaves by, and it is deliberately a door: an
// administrator asks for it, by hand, and what comes out is whitelisted, PII-scrubbed, deduplicated
// and split, with a manifest saying exactly what went in and what was refused.
//
// It does not replace /api/admin/llm?export=jsonl — that one is the raw capture, unfiltered and
// capped at 5000 rows. This is the one to train on.
//
// Gated on the AquinTutor administrator principal. A corpus export is the single highest-value thing
// an attacker could ask this platform for, so it gets the same gate as the console that offers it.
import type { APIRoute } from 'astro';
import { requireAquinAdmin } from '@/lib/aquin/gate';
import { buildDataset, toJsonl } from '@/lib/mind/dataset';

function j(d: any, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async (ctx) => {
  const gate = await requireAquinAdmin(ctx as any);
  if (!gate.ok) return j({ ok: false, error: gate.message || 'Sign in as an AquinTutor administrator.' }, gate.redirect ? 401 : 403);

  const part = String(ctx.url.searchParams.get('part') || 'manifest');
  const limit = Math.min(20000, Number(ctx.url.searchParams.get('limit')) || 5000);

  try {
    const built = await buildDataset({ limit });
    if (part === 'manifest') return j({ ok: true, manifest: built.manifest });

    const rows = part === 'validation' ? built.validation : built.train;
    const name = part === 'validation' ? 'aquin-lora-val.jsonl' : 'aquin-lora-train.jsonl';
    return new Response(toJsonl(rows), {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        // The checksum travels with the file so an adapter can be tied back to the exact corpus that
        // produced it. Without it, "which data was this trained on" is answerable only from memory.
        'X-Corpus-Checksum': built.manifest.checksum,
      },
    });
  } catch (e: any) {
    console.error('[mind/dataset] export failed:', e?.cause?.message || e?.message);
    return j({ ok: false, error: e?.cause?.message || e?.message || 'export failed' }, 500);
  }
};
