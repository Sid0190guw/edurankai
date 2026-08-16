# EduRankAI Mail — Domain Model

Types: `src/lib/mailplatform/types.ts`. Pure rules: `rfc.ts`, `permissions.ts`, `templates.ts`,
`automation.ts` — all testable without a database, which is why the decisions that matter live there.

---

## 1. Organization

The tenant. Everything else hangs off `org_id`. EduRankAI itself is `edurankai`, created on first use.

Membership roles (`owner` / `admin` / `member` / `analyst` / `service`) are **not** the repository's
`users.role`. That column drives the whole EduRankAI admin console (~1400 lines in
`src/lib/auth/permissions.ts`) and a mail platform has no business widening it.

Role resolution, in order:
1. An explicit `mp_organization_members` row **always wins**. Someone made an `analyst` of this
   tenant must not be silently upgraded by an internal job title.
2. Only for the **default** org, and only when there is no membership row, an internal role maps
   through (`admin` → `admin`, `auditor` → `analyst`, everything else → `member`). Never `owner`.
3. Otherwise: **no role.** An EduRankAI employee is not a member of a customer's tenant.

## 2. Mailbox

`user` (owned) · `shared` / `group` / `system` (reached through `mp_mailbox_members`). Ownership or
membership — there is no third way, and an admin listing does not silently include everyone's
personal mailbox.

## 3. Message

One message has **one body** and **N mailbox copies** (`mail_box`, one per user who holds it).
Marking read touches only the caller's copy.

Carries: RFC `Message-ID`, `In-Reply-To`, `References`, `Reply-To`, subject, from, recipients
(to/cc/bcc), HTML and text bodies, full headers, attachments, direction, spam verdict, draft flag,
sent/received timestamps, soft delete, `raw_object_key` → full MIME in object storage.

**Threading**: subject prefixes are stripped multilingually — `Re:`, `Fw:`, `AW:`, `SV:`, `RIF:`,
`Re[2]:`, `回复:`. Matching only `Re:` splits one conversation into a thread per client locale, which
is what users describe as *"my replies keep starting new threads."*

**References** follows RFC 5322 §3.6.4, capped at 20 ids keeping the **first** (identifies the
conversation root) and the most recent (what clients actually match on).

**Recipient dedup** across to/cc/bcc, `to` winning. The visible bug is sending twice; the invisible
one is a Bcc copy of a message whose To line already names the reader — which reveals the blind copy.

**Addresses are not "normalized" beyond case.** Plus-addressing is kept and dots are not stripped:
both are provider conventions, not standards. `a.b@` and `ab@` are the same mailbox at one large
provider and two different people at a self-hosted server; collapsing them merges two real recipients
and, on a suppression list, blocks mail to someone who never asked.

## 4. Delivery

`queued → sent → delivered` (terminal) · `deferred` (retryable) · `bounced` (terminal) · `failed` ·
`suppressed`

**`sent` means handed to a server, not received.** Saying "Delivered" for a message only accepted by
the first hop is the lie that makes a delivery report useless.

**Bounce classification** (`classifyBounce`): 5xx → `hard`, 4xx → `soft`, `5.7.x`/policy language →
`block`, out-of-office → `auto_reply`.

**Suppression policy**: `hard` suppresses immediately. `soft` suppresses only after **five in 30
days** — a single soft bounce is normal operation, and suppressing on it stops a customer's receipts
after one full mailbox. `auto_reply` never suppresses; otherwise going on holiday unsubscribes you.
A complaint always suppresses.

The suppression check **fails open** if its own query fails, loudly logged. Blocking every outbound
message — including password resets — on one broken query is the larger harm. That trade is stated
where it is made.

## 5. Contact

A person the org may mail — distinct from a `users` row (has a login) and an `hr_employees` row
(works here). Keeping them separate is what lets a candidate be a contact without an account, and
stops a marketing list becoming a list of staff.

`upsertContact` merges: attributes are `||`-merged, not replaced, and **`status` is never overwritten
unless explicitly given** — re-importing a spreadsheet must not resubscribe someone who unsubscribed.

Unsubscribing writes **both** the contact status and a suppression entry. The status is what a
marketing screen reads; the suppression entry is what every send checks, including transactional mail
from another product that never looked at the contact record. Updating one is how someone
unsubscribes and keeps receiving mail.

## 6. Template

`Template` (stable key) → many `TemplateVersion` (immutable once published). Editing produces a new
row, never an `UPDATE`, so a message sent last March can still be shown with the wording that went out.

Rendering is **substitution only** — no conditionals, no loops, no partials. A template language in a
mail system becomes a code path that marketing edits and nobody tests, and the first `{{#if}}` that
throws takes out a password-reset email.

Values are **HTML-escaped** in the HTML body. A contact's name arrives from an import file; raw
interpolation makes every template a stored-XSS sink.

A missing variable is **reported, not blank**. `Dear ,` is worse than a refusal because it goes out
looking almost right — `sendMessage` refuses the send.

## 7. Campaign

Not "a message with many recipients" — a queue of individual personalised messages, each with its
own suppression check, unsubscribe link and delivery record.

Expansion and sending are **separate steps**. Expansion is idempotent (unique index +
`ON CONFLICT DO NOTHING`) so a list that grew is picked up without re-mailing anyone. Suppressed
addresses are written with status `suppressed` rather than omitted — an operator asking "why did 40
fewer people get this?" gets a per-address answer.

Batches are claimed atomically (`FOR UPDATE SKIP LOCKED`), so two workers cannot both take a
recipient. Pause takes effect **between** batches; the endpoint says so rather than implying the
in-flight batch stops.

Every campaign message carries `List-Unsubscribe`, `List-Unsubscribe-Post` (RFC 8058) and
`Precedence: bulk`.

## 8. Domain

Claimed, then **proven**. Nothing may send as a domain until DNS published by whoever controls it
says so.

Required records: ownership TXT, SPF (`~all`, not `-all` — a hard fail on a domain with a forgotten
payroll sender silently destroys their mail), DKIM TXT, DMARC (`p=none` to start), MX for receiving.

DMARC is **reported but never required**. Requiring it is how an operator publishes `p=quarantine`
before SPF and DKIM pass and spam-folders their own mail — which has happened on `edurankai.in` and is
written up in `MAIL-SETUP.md`.

TXT comparison ignores quotes and chunking, because resolvers return long records in 255-byte pieces
and some registrars store the quotes literally. A strict compare fails on a record that is correct,
and someone spends an afternoon re-pasting a key that was already right.

**The DKIM private key never enters the database.** It is returned once and referenced thereafter by
`private_key_ref`.

## 9. Automation

`Workflow` → `WorkflowNode` (trigger / send_email / delay / condition / tag / webhook / exit) →
`WorkflowEdge` → `WorkflowRun`.

`validateGraph()` runs **before activation**, not at run time, because activation is the moment a
graph starts touching real inboxes. It refuses: no trigger or two triggers, **any cycle** (an
infinite send loop aimed at a real inbox — the most damaging thing an automation system can do), a
dead end, a condition missing a branch, a send step with no template, a delay with no duration. It
warns about unreachable nodes.

Cycle detection is iterative, not recursive — a large graph would otherwise blow the stack, and "the
workflow editor crashed the server" is a worse outcome than a longer function.

**Scope, plainly:** the model, the invariants and a step function ship. A visual builder, a segment
engine and the full node library do not — that is product surface, and building it without a UI to
drive it would be code nobody can reach.

## 10. Platform event

Append-only, one row per fact, wide `jsonb` payload, time-ordered. Webhooks and analytics both read
it. Names in `EVENT_TYPES`: `message.sent`, `delivery.bounced`, `contact.unsubscribed`,
`campaign.started`, `domain.verified`, and the rest.
