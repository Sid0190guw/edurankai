// POST /api/aquintutor/mind/train — run a learning cycle, or move a checkpoint.
//
// Gated on the AquinTutor administrator principal, the same identity the Mind console runs under.
// An EduRankAI session does not carry over: this product administers itself.
//
// Every action here is bounded on purpose — a fixed row cap, a fixed epoch cap, a wall-clock ceiling
// — because it runs inside an ordinary request on ordinary hosting. Training that cannot finish in a
// request would need a machine this platform does not own, and owning the loop is the point.
import type { APIRoute } from 'astro';
import { requireAquinAdmin } from '@/lib/aquin/gate';
import { runCycle } from '@/lib/mind/train';
import { promoteVersion, rollback } from '@/lib/mind/store';
import { invalidateServingCache } from '@/lib/mind/serve';
import { runIntentCycle, distillBatch } from '@/lib/mind/distill';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async (ctx) => {
  const gate = await requireAquinAdmin(ctx as any);
  if (!gate.ok) return j({ ok: false, error: gate.message || 'Sign in as an AquinTutor administrator.' }, gate.redirect ? 401 : 403);

  let b: any = {};
  try { b = await ctx.request.json(); } catch { /* an empty body means "train, with the defaults" */ }
  const action = String(b.action || 'train');

  try {
    if (action === 'train') {
      const r = await runCycle({
        maxExamples: Math.min(20000, Number(b.maxExamples) || 6000),
        epochs: Math.min(400, Number(b.epochs) || 60),
        semiSupervised: b.semiSupervised !== false,
        unsupervised: b.unsupervised !== false,
        warmStart: b.warmStart !== false,
      });
      invalidateServingCache();
      return j({ ok: r.ok, result: r });
    }
    if (action === 'intent') {
      const r = await runIntentCycle({ epochs: Math.min(400, Number(b.epochs) || 120) });
      return j({ ok: r.ok, result: r });
    }
    if (action === 'distill') {
      const r = await distillBatch(Math.min(100, Number(b.limit) || 40));
      return j({ ok: r.ok, result: r });
    }
    if (action === 'promote') {
      const version = Number(b.version || 0);
      const task = b.task === 'intent' ? 'intent' : 'mastery';
      if (!version) return j({ ok: false, error: 'version required' }, 400);
      await promoteVersion(task, version);
      invalidateServingCache();
      return j({ ok: true, promoted: version });
    }
    if (action === 'rollback') {
      const task = b.task === 'intent' ? 'intent' : 'mastery';
      const restored = await rollback(task);
      invalidateServingCache();
      return j({ ok: true, restored, message: restored ? 'Checkpoint v' + restored + ' is serving again.' : 'No earlier checkpoint to fall back to. The platform is answering with its own estimator again, which is where it started.' });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    console.error('[mind/train] ' + action + ' failed:', e?.cause?.message || e?.message);
    return j({ ok: false, error: e?.cause?.message || e?.message || 'cycle failed' }, 500);
  }
};
