# @edurankai/mail

Official TypeScript client for the EduRankAI Mail transactional email API. Zero dependencies.

```bash
npm install && npm run build
```

```ts
import { EduRankAIMail, EduRankAIMailError } from '@edurankai/mail';

const mail = new EduRankAIMail({ apiKey: process.env.EDURANKAI_MAIL_KEY! });

// An Idempotency-Key is generated for you, so the built-in retries can never
// produce a second message.
try {
  const message = await mail.sendEmail({
    from: 'talent@edurankai.in',
    to: ['candidate@example.com'],
    template_id: 'internship-stage-update',
    variables: {
      candidate_name: 'Candidate',
      role: 'AI Engineering Intern',
      stage: 3,
      next_stage: 'Technical assessment',
      deadline: '22 August 2026',
    },
    metadata: { application_id: 'app_01H8' },
    tags: ['careers', 'stage-3'],
  });
  console.log(message.id, message.status);
  // The platform tells you when it changed something — a rewritten From, a skipped recipient.
  message.warnings?.forEach((w) => console.warn('[mail]', w));
} catch (e) {
  if (e instanceof EduRankAIMailError && e.code === 'template_variable_missing') {
    console.error('Missing:', e.body.missing_variables);
  } else throw e;
}
```

## Correlating an application with what was sent

```ts
const { data } = await mail.listMessages({ metadata: { application_id: 'app_01H8' } });
for (const m of data) console.log(m.created_at, m.subject, m.status);
```

## Receiving webhooks (Express)

```ts
import express from 'express';
import { verifyWebhookSignature } from '@edurankai/mail';

const app = express();
const seen = new Set<string>();   // use Redis or a table in production

// express.raw, NOT express.json — the signature covers the exact bytes we sent.
app.post('/hooks/edurankai', express.raw({ type: 'application/json' }), (req, res) => {
  const id = req.header('Webhook-Id')!;
  const result = verifyWebhookSignature({
    secret: process.env.EDURANKAI_WEBHOOK_SECRET!,
    id,
    timestamp: req.header('Webhook-Timestamp')!,
    signature: req.header('Webhook-Signature')!,
    body: req.body.toString('utf8'),
  });
  if (!result.ok) return res.status(400).json({ error: result.reason });

  // A valid signature proves the delivery is ours, not that it is new. Our retries and any
  // dead-letter replay reuse the same Webhook-Id, so dedupe on it.
  if (seen.has(id)) return res.status(200).end();
  seen.add(id);

  const event = JSON.parse(req.body.toString('utf8'));
  handle(event.type, event.data);

  // Answer 2xx quickly and do the work asynchronously — we time out at 10 seconds.
  res.status(200).end();
});
```

## Notes

- **Attachments are links.** `{ url, filename }`. Base64 content is refused by the API with an
  explanation; documents travel as shared links on this platform.
- **`environment`** is readable from the client without a network call.
- **`lastRateLimit`** holds the counters from the most recent response, for pacing a bulk loop.
- **Retries** cover 429 and 5xx and honour `RateLimit-Reset`. Set `maxRetries: 0` to disable.
