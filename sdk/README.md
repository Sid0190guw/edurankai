# EduRankAI Mail SDKs

Official clients for the transactional email API. Full reference:
[`docs/mail-transactional-api.md`](../docs/mail-transactional-api.md) and `/developers/mail` on the
live site.

| Language | Path | Status |
|---|---|---|
| TypeScript / Node | [`typescript/`](typescript) | Complete |
| Python | [`python/`](python) | Complete |
| Go, Java, PHP, C# | — | Not written. The contract below is what they would be generated from. |

## Why the other four are listed and not shipped

Publishing an empty package is worse than publishing none: it appears in a search, gets installed,
and fails at the first call. The API is *shaped* for generation — one resource per path, one JSON
envelope, stable machine error codes, cursor pagination on every list, and `RateLimit-*` on every
response — so adding Go, Java, PHP or C# is mechanical when somebody actually needs one. Until then
the four names are a plan, not a claim.

## The contract an SDK is generated from

- **Auth** — `Authorization: Bearer <key>`. The environment is in the key string (`erm_dev_`,
  `erm_stg_`, `erm_live_`), so a client can report it without a network call.
- **Resources** — `email` (send), `templates`, `messages`, `events`, `webhooks`, `suppressions`,
  `domains`. Every collection is `GET`-listable with `limit` + `before` and returns
  `{ object: "list", count, next_before, data }`.
- **Errors** — always `{ "error": { "type", "message", "param?", "doc_url", "request_id" } }` with a
  stable `type`. Clients branch on `type`, never on prose.
- **Idempotency** — `Idempotency-Key` on send. Both shipped SDKs generate one when the caller does
  not, which is what makes their automatic retries safe.
- **Rate limits** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After`
  on a 429. Both clients expose the latest values for pacing.
- **Webhooks** — HMAC-SHA256 over `{Webhook-Id}.{Webhook-Timestamp}.{raw body}`, base64, prefixed
  `v1,`. Multiple space-separated signatures during a rotation; any match is valid. Both SDKs ship a
  verifier so nobody has to reimplement it, and both say the same thing in their docstrings:
  **dedupe on `Webhook-Id`**, because a signature proves authenticity and not freshness.

## TypeScript

```bash
cd sdk/typescript && npm install && npm run build
```

```ts
import { EduRankAIMail } from '@edurankai/mail';

const mail = new EduRankAIMail(process.env.EDURANKAI_MAIL_KEY!);

const message = await mail.sendEmail({
  from: 'talent@edurankai.in',
  to: ['candidate@example.com'],
  template_id: 'internship-stage-update',
  variables: { candidate_name: 'Candidate', stage: 3, role: 'AI Engineering Intern' },
  metadata: { application_id: application.id },
});
```

## Python

```bash
cd sdk/python && pip install -e .
```

```python
from edurankai_mail import EduRankAIMail

mail = EduRankAIMail(api_key=os.environ["EDURANKAI_MAIL_KEY"])

message = mail.send_email(
    to="candidate@example.com",
    template_id="internship-stage-update",
    variables={"candidate_name": "Candidate", "stage": 3, "role": "AI Engineering Intern"},
    metadata={"application_id": application.id},
)
```
