# edurankai-mail

Official Python client for the EduRankAI Mail transactional email API. Standard library only.

```bash
pip install -e .
```

```python
import os
from edurankai_mail import EduRankAIMail, EduRankAIMailError

mail = EduRankAIMail(api_key=os.environ["EDURANKAI_MAIL_KEY"])

try:
    message = mail.send_email(
        sender="talent@edurankai.in",
        to="candidate@example.com",
        template_id="internship-stage-update",
        variables={
            "candidate_name": "Candidate",
            "role": "AI Engineering Intern",
            "stage": 3,
            "next_stage": "Technical assessment",
            "deadline": "22 August 2026",
        },
        metadata={"application_id": application.id},
        tags=["careers", "stage-3"],
    )
    print(message["id"], message["status"])
    for warning in message.get("warnings", []):
        print("[mail]", warning)
except EduRankAIMailError as e:
    if e.code == "template_variable_missing":
        print("Missing:", e.body.get("missing_variables"))
    else:
        raise
```

An idempotency key is generated for you, so the built-in retries can never produce a second message.

## Correlating an application with what was sent

```python
for m in mail.list_messages(metadata={"application_id": application.id})["data"]:
    print(m["created_at"], m["subject"], m["status"])
```

## Receiving webhooks (Flask)

```python
import os
from flask import Flask, request, abort
from edurankai_mail import verify_webhook_signature

app = Flask(__name__)
seen = set()   # use Redis or a table in production

@app.post("/hooks/edurankai")
def hook():
    webhook_id = request.headers.get("Webhook-Id", "")
    # request.get_data() — the RAW bytes. request.json would re-serialise and break the signature.
    ok = verify_webhook_signature(
        secret=os.environ["EDURANKAI_WEBHOOK_SECRET"],
        webhook_id=webhook_id,
        timestamp=request.headers.get("Webhook-Timestamp", ""),
        signature=request.headers.get("Webhook-Signature", ""),
        body=request.get_data(as_text=True),
    )
    if not ok:
        abort(400)

    # A valid signature proves the delivery is ours, not that it is new. Our retries and any
    # dead-letter replay reuse the same Webhook-Id, so dedupe on it.
    if webhook_id in seen:
        return "", 200
    seen.add(webhook_id)

    event = request.get_json()
    handle(event["type"], event["data"])
    return "", 200   # answer quickly; we time out at 10 seconds
```

## Notes

- **Attachments are links**: `[{"url": ..., "filename": ...}]`. Base64 content is refused.
- `mail.environment` reads the environment from the key with no network call.
- `mail.last_rate_limit` holds the counters from the most recent response, for pacing a bulk loop.
