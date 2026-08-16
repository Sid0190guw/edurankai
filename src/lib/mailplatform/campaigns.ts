// src/lib/mailplatform/campaigns.ts — bulk sending.
//
// A campaign is NOT "a message with a lot of recipients". It is a queue of individual, personalised
// messages, each with its own suppression check, its own unsubscribe link and its own delivery
// record. That distinction is the whole design:
//
//   - one message per recipient  -> personalization works, and nobody sees anyone else's address
//   - one queue row per recipient -> a half-finished send resumes exactly where it stopped
//   - a unique index on (campaign, address) -> a resumed send cannot mail the first half twice
//
// The expansion and the sending are separate steps on purpose. Expansion writes the recipient list
// in one pass and can be reviewed before anything leaves; sending walks that list. A design that
// expands and sends together cannot be paused, cannot be previewed and cannot be resumed.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import { checkSuppressed } from './suppression';
import { getCurrentVersion, renderTemplate } from './templates';
import { sendMessage } from './send';
import { addressKey } from './rfc';
import type { Campaign, CampaignStats, Page, Principal, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const EMPTY_STATS: CampaignStats = {
  recipients: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
};

function toCampaign(row: any): Campaign {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    templateId: row.template_id ?? null,
    sendingIdentityId: row.sending_identity_id ?? null,
    subject: row.subject ?? null,
    preheader: row.preheader ?? null,
    listId: row.list_id ?? null,
    segment: row.segment ?? null,
    scheduledAt: iso(row.scheduled_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    stats: { ...EMPTY_STATS, ...(row.stats || {}) },
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCampaigns(orgId: UUID, opts: { status?: string; limit?: number; cursor?: string | null } = {}): Promise<Page<Campaign>> {
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  try {
    const conditions = [sql`org_id = ${orgId}`, sql`deleted_at IS NULL`];
    if (opts.status) conditions.push(sql`status = ${opts.status}`);
    if (opts.cursor) conditions.push(sql`created_at < ${new Date(opts.cursor)}`);
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_campaigns WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC LIMIT ${limit + 1}`));
    const hasMore = r.length > limit;
    const page = r.slice(0, limit);
    return { items: page.map(toCampaign), hasMore, nextCursor: hasMore ? iso(page[page.length - 1].created_at) : null };
  } catch (e: any) {
    console.error('[mailplatform/campaigns] list failed -', causeOf(e));
    return { items: [], hasMore: false, nextCursor: null };
  }
}

export async function getCampaign(orgId: UUID, idOrSlug: string): Promise<Campaign | null> {
  if (!idOrSlug) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug.trim());
    const r = rows(await db.execute(
      isUuid
        ? sql`SELECT * FROM mp_campaigns WHERE org_id = ${orgId} AND id = ${idOrSlug.trim()} AND deleted_at IS NULL LIMIT 1`
        : sql`SELECT * FROM mp_campaigns WHERE org_id = ${orgId} AND lower(slug) = ${idOrSlug.trim().toLowerCase()} AND deleted_at IS NULL LIMIT 1`,
    ));
    return r.length ? toCampaign(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/campaigns] get failed -', causeOf(e));
    return null;
  }
}

/** Live counts, read from the event stream rather than from a counter that could drift. */
export async function campaignStats(orgId: UUID, campaignId: UUID): Promise<CampaignStats> {
  const stats = { ...EMPTY_STATS };
  try {
    const recips = rows(await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM mp_campaign_recipients
      WHERE org_id = ${orgId} AND campaign_id = ${campaignId} GROUP BY status`));
    for (const row of recips) {
      stats.recipients += Number(row.n) || 0;
      if (row.status === 'sent') stats.sent = Number(row.n) || 0;
    }

    const events = rows(await db.execute(sql`
      SELECT event_type, COUNT(DISTINCT recipient_address)::int AS n FROM mp_delivery_events
      WHERE org_id = ${orgId} AND campaign_id = ${campaignId} GROUP BY event_type`));
    for (const row of events) {
      const n = Number(row.n) || 0;
      // DISTINCT on recipient, so five opens by one person is one opener. An "opens" number that
      // counts reloads reads as engagement that is not there.
      if (row.event_type === 'delivered') stats.delivered = n;
      else if (row.event_type === 'opened') stats.opened = n;
      else if (row.event_type === 'clicked') stats.clicked = n;
      else if (row.event_type === 'bounced') stats.bounced = n;
      else if (row.event_type === 'complained') stats.complained = n;
      else if (row.event_type === 'unsubscribed') stats.unsubscribed = n;
    }
  } catch (e: any) {
    console.error('[mailplatform/campaigns] stats failed -', causeOf(e));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCampaign(input: {
  orgId: UUID;
  name: string;
  slug?: string;
  templateId?: UUID | null;
  sendingIdentityId?: UUID | null;
  subject?: string | null;
  preheader?: string | null;
  listId?: UUID | null;
  scheduledAt?: string | null;
  createdBy?: UUID | null;
}): Promise<{ ok: boolean; campaign?: Campaign; error?: string }> {
  const name = String(input.name || '').trim();
  if (!name) return { ok: false, error: 'A name is required.' };
  const slug = String(input.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  if (!slug) return { ok: false, error: 'That name does not produce a usable slug. Add some letters or digits.' };

  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_campaigns (org_id, name, slug, template_id, sending_identity_id, subject, preheader, list_id, scheduled_at, created_by, status)
      VALUES (${input.orgId}, ${name.slice(0, 200)}, ${slug}, ${input.templateId || null}, ${input.sendingIdentityId || null},
              ${input.subject || null}, ${input.preheader || null}, ${input.listId || null},
              ${input.scheduledAt ? new Date(input.scheduledAt) : null}, ${input.createdBy || null},
              ${input.scheduledAt ? 'scheduled' : 'draft'})
      RETURNING *`));
    const campaign = toCampaign(r[0]);

    await providers().events.publish({
      orgId: input.orgId,
      eventType: EVENT_TYPES.campaignCreated,
      entityType: 'campaign',
      entityId: campaign.id,
      actorType: input.createdBy ? 'user' : 'system',
      actorId: input.createdBy || null,
      payload: { name, slug },
      occurredAt: new Date().toISOString(),
    });
    return { ok: true, campaign };
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: `A campaign with the slug "${slug}" already exists.` };
    return { ok: false, error: reason };
  }
}

/**
 * Expand the audience into recipient rows.
 *
 * Runs BEFORE any sending, and can be re-run: the unique index on (campaign_id, lower(address))
 * with ON CONFLICT DO NOTHING makes it idempotent, so a list that grew between expansion and send
 * picks up the new people without touching the ones already queued or sent.
 *
 * Suppressed addresses are written with status 'suppressed' rather than omitted. An operator asking
 * "why did 40 fewer people get this?" gets a per-address answer instead of a missing row.
 */
export async function expandRecipients(
  orgId: UUID,
  campaignId: UUID,
): Promise<{ ok: boolean; queued: number; suppressed: number; error?: string }> {
  const campaign = await getCampaign(orgId, campaignId);
  if (!campaign) return { ok: false, queued: 0, suppressed: 0, error: 'No such campaign.' };
  if (!campaign.listId) return { ok: false, queued: 0, suppressed: 0, error: 'This campaign has no contact list.' };

  try {
    const members = rows(await db.execute(sql`
      SELECT c.id, c.email, c.first_name, c.last_name, c.full_name, c.company, c.attributes
      FROM mp_contact_list_members m
      JOIN mp_contacts c ON c.id = m.contact_id
      WHERE m.org_id = ${orgId} AND m.list_id = ${campaign.listId}
        AND m.status = 'subscribed' AND c.status = 'subscribed' AND c.deleted_at IS NULL
      LIMIT 200000`));

    if (!members.length) return { ok: true, queued: 0, suppressed: 0 };

    const checks = await checkSuppressed(orgId, members.map((m) => m.email), { campaignId });

    let queued = 0;
    let suppressedCount = 0;

    // Batched inserts. One statement per row would be 200,000 round trips.
    const BATCH = 500;
    for (let i = 0; i < members.length; i += BATCH) {
      const slice = members.slice(i, i + BATCH);
      const values = slice.map((m) => {
        const key = addressKey(m.email);
        const isSuppressed = checks.get(key)?.suppressed === true;
        if (isSuppressed) suppressedCount++;
        else queued++;
        const personalization = {
          email: m.email,
          first_name: m.first_name || '',
          last_name: m.last_name || '',
          full_name: m.full_name || '',
          company: m.company || '',
          ...(m.attributes || {}),
        };
        return sql`(${orgId}, ${campaignId}, ${m.id}, ${key}, ${isSuppressed ? 'suppressed' : 'pending'},
                    ${JSON.stringify(personalization)}::jsonb,
                    ${isSuppressed ? checks.get(key)?.detail || 'on the suppression list' : null})`;
      });
      await db.execute(sql`
        INSERT INTO mp_campaign_recipients (org_id, campaign_id, contact_id, address, status, personalization, failed_reason)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (campaign_id, lower(address)) DO NOTHING`);
    }

    return { ok: true, queued, suppressed: suppressedCount };
  } catch (e: any) {
    return { ok: false, queued: 0, suppressed: 0, error: causeOf(e) };
  }
}

/**
 * Start a campaign.
 *
 * Refuses unless everything needed is present, because a half-configured campaign that starts and
 * fails on recipient one has already told a fraction of the audience something was wrong. The
 * checks are: a published template or a body, a verified sending identity, and at least one
 * pending recipient.
 *
 * The status transition is a CONDITIONAL UPDATE (`WHERE status IN ('draft','scheduled','paused')`),
 * so two people clicking Send at the same moment cannot both start it.
 */
export async function startCampaign(
  orgId: UUID,
  campaignId: UUID,
  actor?: Principal | null,
): Promise<{ ok: boolean; queued?: number; error?: string }> {
  const campaign = await getCampaign(orgId, campaignId);
  if (!campaign) return { ok: false, error: 'No such campaign.' };
  if (campaign.status === 'sending') return { ok: false, error: 'This campaign is already sending.' };
  if (campaign.status === 'sent') return { ok: false, error: 'This campaign has already been sent.' };

  if (!campaign.templateId) return { ok: false, error: 'Attach a template before sending.' };
  const template = await getCurrentVersion(orgId, campaign.templateId);
  if (!template) return { ok: false, error: 'The attached template has no published version. Publish one first.' };

  if (!campaign.sendingIdentityId) return { ok: false, error: 'Choose a verified sending identity before sending.' };
  const identity = rows(await db.execute(sql`
    SELECT from_address, is_verified FROM mp_sending_identities
    WHERE id = ${campaign.sendingIdentityId} AND org_id = ${orgId} AND deleted_at IS NULL LIMIT 1`));
  if (!identity.length) return { ok: false, error: 'That sending identity no longer exists.' };
  if (!identity[0].is_verified) return { ok: false, error: `${identity[0].from_address} is not verified. Verify its domain before sending a campaign from it.` };

  const expansion = await expandRecipients(orgId, campaignId);
  if (!expansion.ok) return { ok: false, error: expansion.error };

  const pending = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM mp_campaign_recipients
    WHERE org_id = ${orgId} AND campaign_id = ${campaignId} AND status = 'pending'`));
  const count = Number(pending[0]?.n) || 0;
  if (count === 0) {
    return {
      ok: false,
      error:
        expansion.suppressed > 0
          ? `Nobody is left to send to: all ${expansion.suppressed} contacts on this list are on the suppression list.`
          : 'This campaign has no pending recipients.',
    };
  }

  try {
    const claimed = rows(await db.execute(sql`
      UPDATE mp_campaigns SET status = 'sending', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
      WHERE id = ${campaignId} AND org_id = ${orgId} AND status IN ('draft','scheduled','paused')
      RETURNING id`));
    if (!claimed.length) return { ok: false, error: 'The campaign changed status while starting. Reload and try again.' };

    // One queue job for the campaign, not one per recipient. The worker claims a batch of recipients
    // per run and re-enqueues itself; that keeps the queue small and lets a pause take effect
    // between batches instead of after 200,000 jobs have already been created.
    await providers().queue.enqueue(
      'mp.campaign_batch',
      { campaignId, orgId },
      { dedupKey: `mp.campaign:${campaignId}:start` },
    );

    await providers().events.publish({
      orgId,
      eventType: EVENT_TYPES.campaignStarted,
      entityType: 'campaign',
      entityId: campaignId,
      actorType: actor ? (actor.kind === 'api_key' ? 'api_key' : 'user') : 'system',
      actorId: actor?.id || null,
      payload: { recipients: count, suppressed: expansion.suppressed, template: campaign.templateId },
      occurredAt: new Date().toISOString(),
    });

    return { ok: true, queued: count };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/**
 * Send one batch. Called by the queue worker; re-enqueues itself while work remains.
 *
 * The claim is atomic (`UPDATE ... WHERE status='pending' ... RETURNING`), so two workers running
 * at once cannot both take the same recipient — which is what would put two copies of a newsletter
 * in someone's inbox.
 */
export async function sendCampaignBatch(
  orgId: UUID,
  campaignId: UUID,
  batchSize = 50,
): Promise<{ ok: boolean; sent: number; failed: number; remaining: number; error?: string }> {
  const campaign = await getCampaign(orgId, campaignId);
  if (!campaign) return { ok: false, sent: 0, failed: 0, remaining: 0, error: 'No such campaign.' };
  if (campaign.status !== 'sending') {
    // Paused or cancelled between batches. Not an error — it is the pause working.
    return { ok: true, sent: 0, failed: 0, remaining: 0 };
  }

  const template = campaign.templateId ? await getCurrentVersion(orgId, campaign.templateId) : null;
  if (!template) return { ok: false, sent: 0, failed: 0, remaining: 0, error: 'The campaign template is no longer published.' };

  const identity = rows(await db.execute(sql`
    SELECT from_address, from_name FROM mp_sending_identities WHERE id = ${campaign.sendingIdentityId} LIMIT 1`));
  const fromAddress = identity[0]?.from_address;
  if (!fromAddress) return { ok: false, sent: 0, failed: 0, remaining: 0, error: 'The campaign sending identity is gone.' };

  let claimed: any[] = [];
  try {
    claimed = rows(await db.execute(sql`
      UPDATE mp_campaign_recipients SET status = 'queued', queued_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM mp_campaign_recipients
        WHERE org_id = ${orgId} AND campaign_id = ${campaignId} AND status = 'pending'
        ORDER BY created_at ASC LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)
      RETURNING id, contact_id, address, personalization`));
  } catch (e: any) {
    return { ok: false, sent: 0, failed: 0, remaining: 0, error: causeOf(e) };
  }

  let sent = 0;
  let failed = 0;

  for (const recipient of claimed) {
    const variables = recipient.personalization || {};
    const rendered = renderTemplate(template.version, variables);

    const result = await sendMessage(
      {
        orgId,
        from: fromAddress,
        to: recipient.address,
        subject: campaign.subject || rendered.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text,
        campaignId,
        metadata: { campaignId, contactId: recipient.contact_id },
        headers: {
          // RFC 8058. Without these, large receivers do not offer one-click unsubscribe and treat
          // the mail as less trustworthy for not offering it.
          'List-Unsubscribe': `<${unsubscribeUrl(campaignId, recipient.address)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          // So an out-of-office auto-reply does not answer a newsletter.
          Precedence: 'bulk',
        },
      },
      { orgId },
    );

    if (result.ok && result.messageId) {
      sent++;
      await db.execute(sql`
        UPDATE mp_campaign_recipients SET status = 'sent', sent_at = NOW(), message_id = ${result.messageId}, updated_at = NOW()
        WHERE id = ${recipient.id}`);
    } else {
      failed++;
      const status = result.status === 'suppressed' ? 'suppressed' : 'failed';
      await db.execute(sql`
        UPDATE mp_campaign_recipients SET status = ${status}, failed_reason = ${result.error || 'send failed'}, updated_at = NOW()
        WHERE id = ${recipient.id}`);
    }
  }

  const remainingRow = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM mp_campaign_recipients
    WHERE org_id = ${orgId} AND campaign_id = ${campaignId} AND status = 'pending'`));
  const remaining = Number(remainingRow[0]?.n) || 0;

  if (remaining > 0) {
    await providers().queue.enqueue(
      'mp.campaign_batch',
      { campaignId, orgId },
      // The dedup key carries the remaining count so each re-enqueue is a distinct job. A constant
      // key would be deduplicated against the job that just ran, and the campaign would stop after
      // one batch — silently, looking exactly like a finished send.
      { dedupKey: `mp.campaign:${campaignId}:${remaining}`, delayMs: 2000 },
    );
  } else {
    await db.execute(sql`
      UPDATE mp_campaigns SET status = 'sent', finished_at = NOW(), stats = ${JSON.stringify(await campaignStats(orgId, campaignId))}::jsonb, updated_at = NOW()
      WHERE id = ${campaignId} AND org_id = ${orgId} AND status = 'sending'`);
    await providers().events.publish({
      orgId,
      eventType: EVENT_TYPES.campaignFinished,
      entityType: 'campaign',
      entityId: campaignId,
      actorType: 'system',
      actorId: null,
      // Spread into a plain object: CampaignStats is a closed interface and the event payload is an
      // open Record, which TypeScript will not narrow across on its own.
      payload: { ...(await campaignStats(orgId, campaignId)) },
      occurredAt: new Date().toISOString(),
    });
  }

  return { ok: true, sent, failed, remaining };
}

/** Pause takes effect between batches: the in-flight batch finishes, nothing new is claimed. */
export async function pauseCampaign(orgId: UUID, campaignId: UUID): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_campaigns SET status = 'paused', updated_at = NOW()
      WHERE id = ${campaignId} AND org_id = ${orgId} AND status = 'sending' RETURNING id`));
    return r.length ? { ok: true } : { ok: false, error: 'That campaign is not currently sending.' };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

export async function cancelCampaign(orgId: UUID, campaignId: UUID): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_campaigns SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
      WHERE id = ${campaignId} AND org_id = ${orgId} AND status IN ('draft','scheduled','sending','paused') RETURNING id`));
    if (!r.length) return { ok: false, error: 'That campaign cannot be cancelled from its current status.' };
    // Recipients not yet sent are marked skipped, so the counts add up and nobody wonders whether
    // they went out.
    await db.execute(sql`
      UPDATE mp_campaign_recipients SET status = 'skipped', updated_at = NOW()
      WHERE campaign_id = ${campaignId} AND status IN ('pending','queued')`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** The one-click unsubscribe URL placed in List-Unsubscribe and in the message footer. */
export function unsubscribeUrl(campaignId: UUID, address: string, base?: string): string {
  const origin = (base || process.env.PUBLIC_SITE_URL || 'https://edurankai.in').replace(/\/+$/, '');
  return `${origin}/api/v1/unsubscribe?c=${encodeURIComponent(campaignId)}&a=${encodeURIComponent(addressKey(address))}`;
}
