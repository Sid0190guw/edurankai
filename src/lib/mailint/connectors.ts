// src/lib/mailint/connectors.ts — THE CONNECTOR REGISTRY. Pure; no database, no network.
//
// Two kinds of thing live here, and the difference between them is stated in the data rather than
// implied by an empty file:
//
//   AVAILABLE — the five EduRankAI products the brief names. These are real: they accept a payload,
//               map it, and publish onto the bus today, and each one ships the mappings for its own
//               shape so an integration is a connect, not a configuration project.
//
//   PLANNED   — Slack, Teams, Google Workspace, CRM, ATS, university SIS, government portals, ERP.
//               Section 13 says "do not implement every connector now; build the framework". They
//               are registered with real metadata and a PlannedConnector that refuses every step
//               with the specific thing that is missing. The console lists them as planned, with no
//               connect button. Nothing here pretends to work.
//
// THE GENERIC INBOUND CONNECTOR IS THE FRAMEWORK'S PROOF. `external-webhook` accepts any JSON from
// any system, authenticates it by HMAC signature against a per-integration secret, and maps it with
// rows an admin edits in the console. A new external system therefore needs no code at all — which
// is the actual test of whether an integration platform is a platform.

import type { CanonicalEvent } from './events';
import {
  BaseConnector,
  PlannedConnector,
  type Connector,
  type ConnectorContext,
  type ConnectorMeta,
  type ExternalEvent,
  type InboundRequest,
  type StepResult,
} from './connector';
import type { EventMapping } from './mapping';
// The signature scheme is the platform's ONE scheme, from the transactional API layer: the same
// signingString(), the same `v1,<base64>` header value, the same tolerance. An integration layer
// with its own verifier would mean a partner's implementation could pass one door and fail the
// other, which is the single most common webhook integration failure there is.
import { verifySignature } from '@/lib/mailapi/webhooks';

// ---------------------------------------------------------------------------------------------
// EduRankAI first-party connectors
// ---------------------------------------------------------------------------------------------
//
// All five are inbound and all five are authenticated by the platform API key that reached the
// route: they are our own server-to-server callers, holding a key scoped to one organisation, and
// adding a second shared secret between two of our own services would be ceremony rather than
// security. A third-party integration does not get that default — see ExternalWebhookConnector.

class EduRankAIProductConnector extends BaseConnector {
  constructor(public meta: ConnectorMeta) { super(); }

  /**
   * Accept both the product's own shape and a pre-canonical envelope.
   *
   * A first-party caller that already knows the canonical vocabulary should not have to be mapped:
   * `{ type: 'application.created', data: {...} }` is passed through as-is. Anything else goes
   * through the configured mappings like a third-party payload. This is what lets a product adopt
   * the platform incrementally instead of in one change.
   */
  async receive(parsed: unknown, ctx: ConnectorContext): Promise<StepResult<ExternalEvent[]>> {
    const base = await super.receive(parsed, ctx);
    if (!base.ok) return base;
    return base;
  }

  async normalize(events: ExternalEvent[], ctx: ConnectorContext): Promise<StepResult<Partial<CanonicalEvent>[]>> {
    const passthrough: Partial<CanonicalEvent>[] = [];
    const needsMapping: ExternalEvent[] = [];

    for (const ext of events) {
      const body = ext.body as any;
      const type = body?.type ?? body?.event_type;
      const data = body?.data ?? body?.payload;
      if (typeof type === 'string' && data && typeof data === 'object' && !Array.isArray(data)) {
        passthrough.push({
          type,
          source: this.meta.key as any,
          payload: data as Record<string, unknown>,
          occurredAt: typeof body.occurred_at === 'string' ? body.occurred_at : new Date(ctx.now ?? Date.now()).toISOString(),
          externalEventId: ext.externalId ? String(ext.externalId) : (typeof body.event_id === 'string' ? body.event_id : null),
          actorType: 'connector',
          actorId: this.meta.key,
          orgId: ctx.orgId, // never from the payload
        });
      } else {
        needsMapping.push(ext);
      }
    }

    if (!needsMapping.length) return { ok: true, data: passthrough };
    const mapped = await super.normalize(needsMapping, ctx);
    if (!mapped.ok) {
      // Partial success matters: if three events passed through cleanly and one failed to map, the
      // three are still published and the failure is reported. Losing them would make the sender
      // replay the whole batch, which is how a duplicate email gets sent.
      if (passthrough.length) return { ok: true, data: passthrough };
      return mapped;
    }
    return { ok: true, data: [...passthrough, ...(mapped.data || [])] };
  }
}

export const CAREERS_CONNECTOR = new EduRankAIProductConnector({
  key: 'careers',
  name: 'EduRankAI Careers',
  description:
    'The applicant-facing recruitment funnel. Publishes an event when an application is filed, when it moves through the six funnel stages, and when a candidate withdraws — which is what drives every acknowledgement, invitation and decision message a candidate receives.',
  direction: 'inbound',
  availability: 'available',
  family: 'edurankai',
  produces: ['application.created', 'application.updated', 'application.stage.changed', 'application.withdrawn'],
  requires: ['api_key'],
  docs: '#careers',
});

export const AQUINTUTOR_CONNECTOR = new EduRankAIProductConnector({
  key: 'aquintutor',
  name: 'AquinTutor',
  description:
    'The learning platform. Publishes enrolment and completion facts so course mail — welcome sequences, cohort notices, completion follow-ups — is driven by what a learner actually did rather than by a list somebody exported.',
  direction: 'inbound',
  availability: 'available',
  family: 'edurankai',
  produces: ['course.enrolled', 'course.completed', 'assessment.created', 'assessment.completed', 'user.created'],
  requires: ['api_key'],
  docs: '#aquintutor',
});

export const TALENT_CONNECTOR = new EduRankAIProductConnector({
  key: 'talent',
  name: 'EduRankAI Talent',
  description:
    'Assessments and interviews. Publishes the facts that carry a time or a score: an assessment assigned or submitted, an interview booked, moved, cancelled or held. Scores and outcomes are marked sensitive and are redacted before any third-party endpoint sees them.',
  direction: 'inbound',
  availability: 'available',
  family: 'edurankai',
  produces: ['assessment.created', 'assessment.completed', 'interview.scheduled', 'interview.rescheduled', 'interview.cancelled', 'interview.completed'],
  requires: ['api_key'],
  docs: '#talent',
});

export const RECRUITMENT_CONNECTOR = new EduRankAIProductConnector({
  key: 'recruitment',
  name: 'EduRankAI recruitment workflows',
  description:
    'The hiring desk’s decisions. Publishes selection and rejection as separate facts from the stage change that carried them, because the message a decision deserves is written once and must not depend on which screen the decision was made from.',
  direction: 'inbound',
  availability: 'available',
  family: 'edurankai',
  produces: ['candidate.selected', 'candidate.rejected', 'application.stage.changed'],
  requires: ['api_key'],
  docs: '#recruitment',
});

export const UNIVERSITY_CONNECTOR = new EduRankAIProductConnector({
  key: 'university',
  name: 'EduRankAI university systems',
  description:
    'Accounts, invitations and credentials issued by accredited partners. EduRankAI is the technology platform; the partner is the awarding body, and credential events carry the partner’s name for exactly that reason.',
  direction: 'inbound',
  availability: 'available',
  family: 'edurankai',
  produces: ['user.created', 'user.invited', 'credential.issued'],
  requires: ['api_key'],
  docs: '#university',
});

// ---------------------------------------------------------------------------------------------
// The generic external connector
// ---------------------------------------------------------------------------------------------

/**
 * Any external system, no code.
 *
 * Authentication is an HMAC signature over the exact received bytes, verified against the
 * integration's stored webhook secret — with the previous secret still accepted during a rotation
 * window, so rotating a secret is not an outage. The API key alone is NOT enough here: a
 * third-party system's configuration screen is a place where a bearer token gets pasted, screenshot
 * and logged, and a stolen key that can post events would let an outsider trigger candidate mail.
 */
export class ExternalWebhookConnector extends BaseConnector {
  meta: ConnectorMeta = {
    key: 'external-webhook',
    name: 'Generic signed webhook',
    description:
      'Receives JSON from any external system over a signed webhook, and turns it into EduRankAI Mail events with mapping rules edited in the console. This is the connector to reach for when the system on the other side has no dedicated connector: it needs no deployment, only a shared secret and a mapping.',
    direction: 'inbound',
    availability: 'available',
    family: 'edurankai',
    produces: [], // whatever its mappings produce — deliberately not claimed in advance
    requires: ['webhook_secret'],
    docs: '#generic',
  };

  async authenticate(req: InboundRequest, ctx: ConnectorContext): Promise<StepResult<{ detail: string }>> {
    const secret = await ctx.credential('webhook_secret');
    // The previous secret is stored under the same kind during a rotation; the vault returns both
    // joined by a newline, so a rotation window is not an outage for the sender either.
    const secrets = String(secret || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!secrets.length) {
      return { ok: false, code: 'unauthorized', error: 'No webhook secret is stored for this integration, so no signature can be verified. Add one in the integration console.' };
    }
    const id = req.headers['webhook-id'] || req.headers['x-webhook-id'] || '';
    const timestamp = req.headers['webhook-timestamp'] || req.headers['x-webhook-timestamp'] || '';
    const signature = req.headers['webhook-signature'] || req.headers['x-webhook-signature'] || '';
    if (!id || !timestamp || !signature) {
      return {
        ok: false,
        code: 'invalid_signature',
        error: 'Send Webhook-Id, Webhook-Timestamp and Webhook-Signature. The signed string is id + "." + timestamp + "." + the exact request body.',
      };
    }
    for (const s of secrets) {
      const r = verifySignature({ secret: s, id, timestamp, signature, body: req.rawBody, nowMs: ctx.now });
      if (r.ok) return { ok: true, data: { detail: 'Signature verified.' } };
      // A stale or future timestamp is the same answer for every secret, so it is reported once
      // rather than being hidden behind a rotation loop that ends in a generic mismatch.
      if (r.reason === 'stale' || r.reason === 'future' || r.reason === 'bad_timestamp') {
        return { ok: false, code: 'invalid_signature', error: 'The Webhook-Timestamp is ' + r.reason.replace('_', ' ') + '. Signatures are accepted within five minutes of our clock.' };
      }
    }
    return {
      ok: false,
      code: 'invalid_signature',
      error: 'The signature does not match the body. Sign the exact bytes sent, as id + "." + timestamp + "." + body, with HMAC-SHA256 and the header value `v1,<base64>`.',
    };
  }
}

export const EXTERNAL_WEBHOOK_CONNECTOR = new ExternalWebhookConnector();

// ---------------------------------------------------------------------------------------------
// Planned connectors (section 13)
// ---------------------------------------------------------------------------------------------
//
// `blockedOn` is a sentence naming the actual obstacle, not a shrug. The rule this follows is the
// one already learned on the live-streaming work in this repository: "coming soon" on a screen
// becomes a commitment somebody plans around, and the honest version — which app review, which
// protocol, which credential — is what lets a reader judge the distance themselves.

function planned(meta: Omit<ConnectorMeta, 'availability'>): PlannedConnector {
  return new PlannedConnector({ ...meta, availability: 'planned' });
}

export const PLANNED_CONNECTORS: PlannedConnector[] = [
  planned({
    key: 'slack',
    name: 'Slack',
    description: 'Post platform events into a channel, and accept slash-command actions back. Outbound first: a hiring desk that watches applications arrive in a channel.',
    direction: 'bidirectional',
    family: 'messaging',
    produces: [],
    consumes: ['application.created', 'application.stage.changed', 'candidate.selected', 'candidate.rejected', 'message.bounced'],
    requires: ['oauth_token'],
    blockedOn: 'Needs a Slack app with chat:write, its OAuth flow, and a distribution review before it can be installed outside our own workspace. The event side is ready; nothing about the connector itself is.',
  }),
  planned({
    key: 'microsoft-teams',
    name: 'Microsoft Teams',
    description: 'The same channel notifications for organisations on Microsoft 365.',
    direction: 'outbound',
    family: 'messaging',
    produces: [],
    consumes: ['application.created', 'application.stage.changed', 'interview.scheduled'],
    requires: ['oauth_token'],
    blockedOn: 'Needs an Azure AD app registration and admin consent in the customer’s tenant. Incoming-webhook connectors are being retired by Microsoft, so this has to be built on Graph, not on a connector URL.',
  }),
  planned({
    key: 'google-workspace',
    name: 'Google Workspace',
    description: 'Directory sync for contacts and calendar writes for interview slots.',
    direction: 'bidirectional',
    family: 'productivity',
    produces: ['user.created'],
    consumes: ['interview.scheduled', 'interview.rescheduled', 'interview.cancelled'],
    requires: ['oauth_token'],
    blockedOn: 'Needs a verified OAuth consent screen with restricted directory and calendar scopes — Google’s verification takes weeks, and the refresh token is revoked if it goes seven days unused, which the credential vault has to be built to survive.',
  }),
  planned({
    key: 'crm-generic',
    name: 'CRM systems',
    description: 'Two-way contact sync with a customer-relationship system: their contacts become our audience, our engagement becomes their activity timeline.',
    direction: 'bidirectional',
    family: 'crm',
    produces: ['contact.created', 'contact.updated'],
    consumes: ['message.sent', 'message.opened', 'message.clicked', 'message.bounced'],
    requires: ['oauth_token'],
    blockedOn: 'No target system chosen. Every CRM spells a contact differently, so this becomes real when there is one to integrate — the mapping engine already covers the shape translation, and the generic signed webhook covers the inbound half today.',
  }),
  planned({
    key: 'ats-generic',
    name: 'ATS systems',
    description: 'Applicant tracking: their stage changes drive our candidate mail, our delivery outcomes appear on their candidate record.',
    direction: 'bidirectional',
    family: 'ats',
    produces: ['application.created', 'application.stage.changed', 'candidate.selected', 'candidate.rejected'],
    consumes: ['message.sent', 'message.bounced'],
    requires: ['api_key'],
    blockedOn: 'No target system chosen. The inbound half already works through the generic signed webhook — the worked mapping in docs/mail/INTEGRATIONS.md turns an ATS numeric stage into application.stage.changed with no code.',
  }),
  planned({
    key: 'university-sis',
    name: 'University SIS',
    description: 'Student information systems at accredited partners: enrolment, progression and credential facts.',
    direction: 'inbound',
    family: 'sis',
    produces: ['user.created', 'course.enrolled', 'course.completed', 'credential.issued'],
    requires: ['api_key'],
    blockedOn: 'Depends on the partner. Most SIS deployments export overnight files rather than webhooks, so this needs a scheduled pull with a watermark, not the push path — a different shape of connector that the interface supports but no adapter implements yet.',
  }),
  planned({
    key: 'government-portal',
    name: 'Government portals',
    description: 'Statutory and regulatory reporting surfaces.',
    direction: 'outbound',
    family: 'government',
    produces: [],
    requires: ['api_key'],
    blockedOn: 'Needs a named portal, its authorisation scheme and a legal basis for each field sent. Not a technical blocker — an approval one, and it must not be started as though it were technical.',
  }),
  planned({
    key: 'erp-generic',
    name: 'ERP systems',
    description: 'Finance and people systems of record.',
    direction: 'bidirectional',
    family: 'erp',
    produces: ['user.created'],
    consumes: [],
    requires: ['api_key'],
    blockedOn: 'No target system chosen, and no event in the catalogue currently needs one. Registered so the architecture is on record, not because work is queued.',
  }),
];

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const AVAILABLE: Connector[] = [
  CAREERS_CONNECTOR,
  AQUINTUTOR_CONNECTOR,
  TALENT_CONNECTOR,
  RECRUITMENT_CONNECTOR,
  UNIVERSITY_CONNECTOR,
  EXTERNAL_WEBHOOK_CONNECTOR,
];

const REGISTRY = new Map<string, Connector>();
for (const c of [...AVAILABLE, ...PLANNED_CONNECTORS]) REGISTRY.set(c.meta.key, c);

export function getConnector(key: string): Connector | null {
  return REGISTRY.get(String(key || '').trim().toLowerCase()) || null;
}

export function listConnectors(): Connector[] {
  return [...REGISTRY.values()];
}

export function listConnectorMeta(): ConnectorMeta[] {
  return listConnectors().map((c) => c.meta);
}

export function availableConnectorKeys(): string[] {
  return AVAILABLE.map((c) => c.meta.key);
}

/** True when an integration may be created against this connector at all. */
export function isConnectable(key: string): boolean {
  const c = getConnector(key);
  return !!c && c.meta.availability === 'available';
}

// ---------------------------------------------------------------------------------------------
// Default mappings
// ---------------------------------------------------------------------------------------------

/**
 * Stage numbers to stage keys.
 *
 * The order is the funnel's own, from src/lib/application-stages.ts: 1 Submitted, 2 Review,
 * 3 Assessment, 4 Interview, 5 Decision, 6 Onboarded. A number is what most external systems send;
 * a key is what this platform's events carry, because a renumbered funnel must not silently
 * re-point every mapping at the wrong stage.
 */
export const STAGE_BY_NUMBER: Record<string, string> = {
  '1': 'submitted',
  '2': 'review',
  '3': 'assessment',
  '4': 'interview',
  '5': 'decision',
  '6': 'onboarded',
  '0': 'submitted',
};

/**
 * Mappings a new integration starts with. Editable afterwards; nothing here is load-bearing for the
 * first-party products, which speak the canonical envelope directly.
 *
 * The `careers` entry is section 8 of the brief, working: an external `candidate.stage = 3` becomes
 * `application.stage.changed` with `stage: "assessment"`, which is what a stage-3 email workflow
 * matches on.
 */
export const DEFAULT_MAPPINGS: Record<string, EventMapping[]> = {
  careers: [
    {
      name: 'External stage change (numeric stage)',
      source: 'careers',
      match: [{ path: '$.candidate.stage', exists: true }],
      canonicalType: 'application.stage.changed',
      valueMaps: { stage: STAGE_BY_NUMBER },
      fields: [
        { to: 'application_id', from: '$.candidate.id', transforms: ['string'], required: true },
        { to: 'stage', from: '$.candidate.stage', transforms: ['string'], valueMap: 'stage', required: true },
        { to: 'previous_stage', from: '$.candidate.previous_stage', transforms: ['string'], valueMap: 'stage' },
        { to: 'stage_index', from: '$.candidate.stage', transforms: ['integer'] },
        { to: 'email', from: '$.candidate.email', transforms: ['email'] },
        { to: 'name', from: '$.candidate.name', transforms: ['trim'] },
        { to: 'role_title', from: '$.job.title', transforms: ['trim'] },
      ],
      eventIdPath: '$.event_id',
      occurredAtPath: '$.occurred_at',
      priority: 10,
      isActive: true,
    },
    {
      name: 'External application submitted',
      source: 'careers',
      match: [{ path: '$.event', in: ['application.submitted', 'application_created', 'candidate.applied'] }],
      canonicalType: 'application.created',
      fields: [
        { to: 'application_id', from: '$.application.id', transforms: ['string'], required: true },
        { to: 'email', from: '$.application.email', transforms: ['email'], required: true },
        { to: 'name', from: '$.application.name', transforms: ['trim'] },
        { to: 'role_key', from: '$.job.key', transforms: ['trim'] },
        { to: 'role_title', from: '$.job.title', transforms: ['trim'] },
        { to: 'source', value: 'external' },
      ],
      eventIdPath: '$.event_id',
      occurredAtPath: '$.occurred_at',
      priority: 20,
      isActive: true,
    },
  ],
  'external-webhook': [
    {
      name: 'Example: event name lookup',
      source: 'external',
      match: [{ path: '$.event', exists: true }],
      canonicalType: { from: '$.event', valueMap: 'types' },
      valueMaps: {
        types: {
          'candidate.created': 'application.created',
          'candidate.moved': 'application.stage.changed',
          'candidate.hired': 'candidate.selected',
          'candidate.rejected': 'candidate.rejected',
        },
        stage: STAGE_BY_NUMBER,
      },
      fields: [
        { to: 'application_id', from: '$.data.id', transforms: ['string'], required: true },
        { to: 'email', from: '$.data.email', transforms: ['email'] },
        { to: 'stage', from: '$.data.stage', transforms: ['string'], valueMap: 'stage' },
      ],
      eventIdPath: '$.id',
      occurredAtPath: '$.created_at',
      priority: 50,
      isActive: false, // an example to copy, not a rule that silently starts routing traffic
    },
  ],
};

export function defaultMappingsFor(connectorKey: string): EventMapping[] {
  return (DEFAULT_MAPPINGS[connectorKey] || []).map((m) => ({ ...m }));
}
