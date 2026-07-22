// src/lib/board-translate.ts — Block 07: translation-on-fan-out for live board events.
// Pure text extract/apply + a cached translateFire (per session,seq,locale). The LaTeX body of
// an equation is deliberately never translated; only its human-readable caption is.
export interface TranslatableEvent {
  templateId: string;
  params: any;
  seq?: number;
  sessionId?: string;
}

/** Pull the human-readable strings out of a fired event (pure). */
export function translatableText(ev: TranslatableEvent): string[] {
  const p = ev.params || {};
  if (ev.templateId === 'slide' && p.slide) return [p.slide.title, ...(p.slide.bullets || [])].filter((s: any) => typeof s === 'string' && s);
  if (ev.templateId === 'scene' && p.scene) {
    const s = p.scene;
    return [s.title, s.subtitle, ...((s.objects || []).map((o: any) => o?.text))].filter((x: any) => typeof x === 'string' && x);
  }
  if (ev.templateId === 'equation' && typeof p.caption === 'string' && p.caption) return [p.caption];
  return [];   // projectile/sine/sortbars/ink carry nothing translatable
}

/** Return a copy of the event with each source string replaced by map[string] (pure). */
export function applyTranslations<T extends TranslatableEvent>(ev: T, map: Record<string, string>): T {
  const clone: T = JSON.parse(JSON.stringify(ev));
  const p = clone.params || {};
  const tr = (s: any) => (typeof s === 'string' && map[s] != null ? map[s] : s);
  if (clone.templateId === 'slide' && p.slide) {
    p.slide.title = tr(p.slide.title);
    p.slide.bullets = (p.slide.bullets || []).map(tr);
  } else if (clone.templateId === 'scene' && p.scene) {
    const s = p.scene;
    if (s.title) s.title = tr(s.title);
    if (s.subtitle) s.subtitle = tr(s.subtitle);
    (s.objects || []).forEach((o: any) => { if (o && typeof o.text === 'string') o.text = tr(o.text); });
  } else if (clone.templateId === 'equation' && typeof p.caption === 'string') {
    p.caption = tr(p.caption);
  }
  return clone;
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
async function ensure() {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_board_translations (
     session_id TEXT NOT NULL, seq BIGINT NOT NULL, locale TEXT NOT NULL,
     payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (session_id, seq, locale))`));
  booted = true;
}

/** Translate a fired event into `locale`, cached per (session,seq,locale). Falls back to the
 *  original event if there is nothing to translate, no LLM, or any failure (never throws). */
export async function translateFire<T extends TranslatableEvent>(ev: T, locale: string): Promise<T> {
  const texts = translatableText(ev);
  if (!locale || locale === 'en' || texts.length === 0) return ev;
  try {
    await ensure(); const { db, sql } = await ctx();
    if (ev.sessionId != null && ev.seq != null) {
      const hit = rows(await db.execute(sql`SELECT payload FROM edu_board_translations WHERE session_id = ${ev.sessionId} AND seq = ${ev.seq} AND locale = ${locale} LIMIT 1`))[0];
      if (hit?.payload && Object.keys(hit.payload).length) return applyTranslations(ev, hit.payload as Record<string, string>);
    }
    const { getConfig, isReady, chat } = await import('@/lib/llm/gateway');
    const cfg = await getConfig();
    if (!isReady(cfg)) return ev;   // no LLM -> serve the original
    const sys = `Translate each numbered line into ${locale}. Preserve meaning, keep it concise. Return ONLY a JSON array of strings, same order, same length.`;
    const res = await chat(sys, [{ role: 'user', content: texts.map((t, i) => `${i}. ${t}`).join('\n') }], cfg);
    if (!res.ok) return ev;
    let out: unknown;
    try { out = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, '').trim()); } catch { return ev; }
    if (!Array.isArray(out) || out.length !== texts.length) return ev;
    const map: Record<string, string> = {};
    texts.forEach((t, i) => { if (typeof out[i] === 'string') map[t] = out[i] as string; });
    if (ev.sessionId != null && ev.seq != null) {
      await db.execute(sql`INSERT INTO edu_board_translations (session_id, seq, locale, payload)
        VALUES (${ev.sessionId}, ${ev.seq}, ${locale}, ${JSON.stringify(map)}::jsonb)
        ON CONFLICT (session_id, seq, locale) DO NOTHING`);
    }
    return applyTranslations(ev, map);
  } catch { return ev; }
}
