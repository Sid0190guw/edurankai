# EduRankAI Mail — Integration Contracts

**For the other three agents and for every EduRankAI product.** These are the shapes to build
against. Adding a field is cheap; renaming one breaks four codebases.

Types: `src/lib/mailplatform/types.ts` · Interfaces: `src/lib/mailplatform/interfaces.ts`

---

## 1. For the SMTP / MTA agent

You own **implementations** of two interfaces. This patch owns their shapes.

### `MailTransport` — outbound

```ts
interface MailTransport {
  info(): ProviderInfo;                                    // synchronous, no I/O
  send(envelope: OutboundEnvelope): Promise<TransportSendResult>;
  verify(): Promise<OperationResult<{ detail: string }>>;  // prove reachability, send nothing
}
```

Rules:

- **Return a result, never throw for an expected failure.** A server you cannot reach is an ordinary
  Tuesday. Making it an exception is how a failed send ends up in a `catch {}` and disappears — which
  has already happened on this codebase's outbound path.
- **`retryable` must be honest.** 4xx and network errors → `true`; 5xx → `false`. Retrying a 5xx
  turns one hard bounce into five and becomes a reputation problem. Use `isRetryableFailure()` from
  `rfc.ts` so the classification is identical on both sides.
- **Report per-recipient outcomes if you can.** The current SMTP adapter hands the whole envelope to
  one server and cannot, so it repeats one error across the list and says so in a comment. An MTA
  that *can* split must fill `rejected[]` per address.
- **DKIM signing is yours.** `envelope.dkim` carries `{ domain, selector, privateKeyRef }`. Resolve
  `privateKeyRef` out of your own secret store — see §4. The platform never holds the key.
- **`X-EduRankAI-Message-Id`** is on every outbound envelope. Echo it on delivery events so an
  asynchronous bounce can be matched to a message.

### `InboundMailTransport` — inbound

```ts
interface InboundMailTransport {
  info(): ProviderInfo;
  poll(opts?): Promise<InboundFetchResult>;                    // return fetched: 0 if push-only
  parse(payload: unknown): Promise<OperationResult<InboundMessage>>;
}
```

- `parse()` accepts raw MIME (string/`Uint8Array`) **or** a JSON object from a gateway.
- Refuse with `code: 'no_sender'` / `'no_recipient'` rather than storing a message from nobody. An
  inbound row with no From can never be replied to and never be traced.
- `authResults` (SPF/DKIM/DMARC) is **advisory**. Per `CLAUDE.md`, automated detection never decides
  on its own — a human does. Do not auto-reject on it.
- Put the full MIME source in object storage via `AttachmentStore`, and the key on
  `mail_messages.raw_object_key`. Never in a column.

### Recording a delivery outcome

```ts
import { recordAttempt, recordBounce, recordComplaint, recordDelivered } from '@/lib/mailplatform/delivery';

await recordAttempt({ orgId, messageId, recipientAddress, transport: 'mta',
                      attemptNo: 1, status: 'sent', smtpCode: 250, latencyMs: 412 });
await recordBounce({ orgId, messageId, recipientAddress, smtpCode: 550,
                     diagnosticCode: '5.1.1 user unknown', reportedBy: 'mta' });
```

`recordBounce` classifies, updates status, appends the event, applies the suppression policy and
publishes to the bus. Do not reimplement any of that.

## 2. For the webmail UI agent

Read through `MessageStore` — never write SQL against `mail_*` directly, or per-mailbox access
control ends up in two places and one of them will be wrong.

```ts
import { providers } from '@/lib/mailplatform/providers';
const store = providers().messages;

await store.list({ userId, folder: 'inbox', limit: 25, cursor });   // keyset paged
await store.getThread(threadId, { userId });
await store.patchState(messageId, { userId }, { isRead: true });    // YOUR copy only
await store.counts({ userId });
```

- **Always pass a viewer.** `get()` with neither `userId` nor `orgId` returns `null` by design —
  there is no bare id lookup.
- **404, not 403**, for a message the viewer may not see. A distinguishable 403 lets someone
  enumerate message ids.
- Compose through `sendMessage()` in `send.ts`, not the store. The store persists; `sendMessage`
  persists **and** checks suppression, resolves the identity, records delivery and publishes events.
- Existing surfaces (`/admin/mail`, `/portal/employee/mail`) keep working untouched: every column
  this patch added is nullable or defaulted.

## 3. For the DevOps agent — environment

| Variable | Required | What breaks without it |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | everything |
| `AUTH_SECRET`, `SESSION_COOKIE_NAME` | **yes** | sessions |
| `MAIL_DOMAIN` | recommended | Message-IDs default to `edurankai.in` |
| `MAIL_MX_HOST` | for receiving | the MX record cannot be generated and is **omitted** from the required list |
| `MAIL_SPF_INCLUDE` | for sending | the SPF record cannot be generated and is **omitted** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | for attachments | falls back to an in-memory store that does not survive a restart — reported honestly, never as success |
| `S3_PUBLIC_BASE_URL` | optional | `AttachmentStore.url()` returns `null` |
| `WEBHOOK_SIGNING_KEY` | for webhooks | deliveries are **refused, not sent unsigned** |
| `PUBLIC_SITE_URL` | for campaigns | unsubscribe links default to `https://edurankai.in` |
| `DKIM_PRIVATE_KEY_<DOMAIN>_<SELECTOR>` | per sending domain | that domain's mail is unsigned |
| `MAIL_TRANSPORT`, `MAIL_INBOUND`, `MAIL_QUEUE`, … | no | defaults match today's deployment |

`GET /api/v1/platform/status` reports which of these are missing, in sentences.

### Migration

```bash
psql "$DATABASE_URL" -f db/mail-platform-schema.sql   # idempotent, additive
npm run mail:schema                                    # regenerate after editing schema.ts
```

### Workers to schedule

| Job kind | Enqueued by | Should do |
| --- | --- | --- |
| `mp.send_message` | scheduled + retried sends | `sendStoredMessage(messageId, orgId)` |
| `mp.campaign_batch` | campaign start, re-enqueues itself | `sendCampaignBatch(orgId, campaignId)` |
| `mp.webhook_delivery` | event dispatch | `attemptDelivery(deliveryId, orgId)` |
| `mp.domain_verify` | scheduled re-check | `verifyDomain(orgId, domainId)` |
| `mp.workflow_step` | run start / delay expiry | advance one run one node |

Claim with `providers().queue.claim(n)`, then `complete()` or `fail()`. Vercel Hobby crons are
**daily-only** on this account.

## 4. DKIM key handling — the contract

1. `POST /api/v1/platform/domains` mints a 2048-bit RSA pair.
2. The **private key is returned once** in that response and written nowhere.
3. `mp_dkim_keys` stores the public key and `private_key_ref`, e.g.
   `env:DKIM_PRIVATE_KEY_EXAMPLE_ORG_ERA1`.
4. The operator puts the key in the MTA's secret store under that name.
5. The MTA resolves `privateKeyRef` at signing time.
6. Rotation mints a new selector; the **old key stays published for at least a week**, because
   messages already in flight were signed with it and receivers cache the record.

The key becomes `active` only after verification passes. Signing with a key whose public half is not
published produces a DKIM **failure** on every message — worse than not signing at all.

## 5. For EduRankAI product teams

```ts
import { sendMessage } from '@/lib/mailplatform/send';

await sendMessage({
  to: candidate.email,
  template: 'internship-stage-update',
  variables: { candidate_name: candidate.name, stage: 3, role: 'AI Engineering Intern' },
  metadata: { application_id: application.id },
});
```

or over HTTP with an API key against `POST /api/v1/platform/messages/send`.

Never call `sendExternal()` or `nodemailer` directly. A send that bypasses `sendMessage()` skips the
suppression check, records no delivery attempt, publishes no event and appears in no report.

The `metadata` you pass is echoed on every delivery event for that message, so
`application → email → delivery → bounce` is one query rather than a join across systems.

## 6. Interface stability

| Stability | Meaning |
| --- | --- |
| **Stable** | `types.ts`, `interfaces.ts`, `/api/v1/platform/*` response shapes. Additive changes only. |
| **Evolving** | service function signatures in `src/lib/mailplatform/*.ts`. |
| **Internal** | `adapters/*`. Replace freely — that is what they are for. |
