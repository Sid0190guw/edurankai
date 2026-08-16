"""edurankai_mail — the official Python client for the EduRankAI Mail transactional API.

STANDARD LIBRARY ONLY, ON PURPOSE. urllib, hmac, hashlib, json. An SDK that pulls `requests` into a
customer's service is an SDK that eventually breaks their dependency resolution for a reason that has
nothing to do with email.

The webhook verifier at the bottom is the most important thing in this module. It is a byte-for-byte
counterpart of the signer in src/lib/mailapi/webhooks.ts and of the one in the TypeScript SDK — a
verifier that differs from its signer by one character is the commonest webhook integration failure,
and it fails in the direction of accepting forged events.

    from edurankai_mail import EduRankAIMail

    mail = EduRankAIMail(api_key=os.environ["EDURANKAI_MAIL_KEY"])
    message = mail.send_email(
        to="candidate@example.com",
        template_id="internship-stage-update",
        variables={"candidate_name": "Candidate", "stage": 3, "role": "AI Engineering Intern"},
        metadata={"application_id": application.id},
    )
    print(message["id"], message["status"])
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Union

__all__ = [
    "EduRankAIMail",
    "EduRankAIMailError",
    "verify_webhook_signature",
    "sign_webhook_payload",
    "SDK_VERSION",
    "PAYLOAD_VERSION",
    "EVENT_TYPES",
]

SDK_VERSION = "1.0.0"
PAYLOAD_VERSION = "2026-08-16"
DEFAULT_BASE_URL = "https://www.edurankai.in"

EVENT_TYPES = (
    "email.queued", "email.sent", "email.delivered", "email.deferred", "email.bounced",
    "email.failed", "email.opened", "email.clicked", "email.unsubscribed", "email.complained",
)

Recipients = Union[str, Sequence[str]]


class EduRankAIMailError(Exception):
    """An error returned by the API, carrying the machine code you should branch on."""

    def __init__(self, status: int, body: Any, rate_limit: Optional[Dict[str, int]] = None) -> None:
        err = (body or {}).get("error", {}) if isinstance(body, dict) else {}
        super().__init__(err.get("message") or f"EduRankAI Mail request failed with status {status}")
        self.status = status
        self.code = err.get("type", "unknown_error")
        self.param = err.get("param")
        self.request_id = err.get("request_id")
        self.body = body
        self.rate_limit = rate_limit

    @property
    def is_retryable(self) -> bool:
        """True when waiting and repeating the identical request is the right response."""
        return self.status == 429 or self.status >= 500 or self.code == "idempotency_in_progress"


class EduRankAIMail:
    """A client for one API key, and therefore for one organization and one environment."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
    ) -> None:
        if not api_key:
            raise ValueError("An API key is required. Create one at /admin/mail/api.")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        #: Rate-limit state from the most recent response. Useful for pacing a bulk loop.
        self.last_rate_limit: Optional[Dict[str, int]] = None

    # -- introspection ----------------------------------------------------

    @property
    def environment(self) -> Optional[str]:
        """The environment this key belongs to, read from the key itself. No network call."""
        for token, name in (("erm_dev_", "development"), ("erm_stg_", "staging"), ("erm_live_", "production")):
            if self.api_key.startswith(token):
                return name
        return None

    # -- transport --------------------------------------------------------

    def _request(self, method: str, path: str, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Any:
        last_error: Optional[EduRankAIMailError] = None

        for attempt in range(self.max_retries + 1):
            if attempt:
                wait = min(30.0, float(last_error.rate_limit["reset"])) if (last_error and last_error.rate_limit) else min(8.0, 0.5 * 2 ** attempt)
                time.sleep(wait)

            data = None if body is None else json.dumps(body).encode("utf-8")
            request = urllib.request.Request(
                self.base_url + path,
                data=data,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": f"edurankai-mail-python/{SDK_VERSION}",
                    **(headers or {}),
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    self._record_rate_limit(response.headers)
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                self._record_rate_limit(e.headers)
                raw = e.read().decode("utf-8", "replace")
                try:
                    parsed = json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    parsed = {"raw": raw}
                last_error = EduRankAIMailError(e.code, parsed, self.last_rate_limit)
                if not last_error.is_retryable or attempt == self.max_retries:
                    raise last_error
            except urllib.error.URLError as e:
                # A network failure is retryable; on the last attempt it is reported as what it is
                # rather than dressed up as an API error.
                if attempt == self.max_retries:
                    raise ConnectionError(f"Could not reach {self.base_url}: {e.reason}") from e
                last_error = None

        raise last_error or RuntimeError("Request failed")

    def _record_rate_limit(self, headers: Any) -> None:
        try:
            limit = headers.get("RateLimit-Limit")
            if limit:
                self.last_rate_limit = {
                    "limit": int(limit),
                    "remaining": int(headers.get("RateLimit-Remaining") or 0),
                    "reset": int(headers.get("RateLimit-Reset") or 0),
                }
        except (TypeError, ValueError):
            pass

    # -- email ------------------------------------------------------------

    def send_email(
        self,
        to: Recipients,
        *,
        subject: Optional[str] = None,
        html: Optional[str] = None,
        text: Optional[str] = None,
        template_id: Optional[str] = None,
        template_version: Optional[int] = None,
        variables: Optional[Dict[str, Any]] = None,
        sender: Optional[str] = None,
        cc: Optional[Recipients] = None,
        bcc: Optional[Recipients] = None,
        reply_to: Optional[str] = None,
        attachments: Optional[List[Dict[str, str]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
        scheduled_at: Optional[str] = None,
        options: Optional[Dict[str, bool]] = None,
    ) -> Dict[str, Any]:
        """Send a message.

        `attachments` are LINKS: ``[{"url": "https://…", "filename": "Offer letter.pdf"}]``. The API
        refuses base64 content — documents travel as shared links on this platform, never as uploads.

        An idempotency key is generated when you do not supply one, so the automatic retries above
        can never turn a slow network into two rejection letters.
        """
        payload: Dict[str, Any] = {"to": to}
        for key, value in (
            ("from", sender), ("cc", cc), ("bcc", bcc), ("reply_to", reply_to),
            ("subject", subject), ("html", html), ("text", text),
            ("template_id", template_id), ("template_version", template_version),
            ("variables", variables), ("attachments", attachments), ("metadata", metadata),
            ("tags", tags), ("headers", extra_headers), ("scheduled_at", scheduled_at),
            ("options", options),
        ):
            if value is not None:
                payload[key] = value

        return self._request(
            "POST", "/api/v1/email/send", payload,
            {"Idempotency-Key": idempotency_key or str(uuid.uuid4())},
        )

    def get_message(self, message_id: str, *, include_body: bool = False, include_bcc: bool = False) -> Dict[str, Any]:
        query = {}
        if include_body:
            query["include_body"] = "true"
        if include_bcc:
            query["include_bcc"] = "true"
        suffix = ("?" + urllib.parse.urlencode(query)) if query else ""
        return self._request("GET", f"/api/v1/messages/{urllib.parse.quote(message_id)}{suffix}")

    def get_message_status(self, message_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/messages/{urllib.parse.quote(message_id)}/status")

    def cancel_message(self, message_id: str) -> Dict[str, Any]:
        """Cancel a scheduled send. Only possible before it reaches a mail server."""
        return self._request("DELETE", f"/api/v1/messages/{urllib.parse.quote(message_id)}")

    def list_messages(
        self,
        *,
        status: Optional[str] = None,
        tag: Optional[str] = None,
        recipient: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None,
        before: Optional[str] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """List messages. ``metadata`` is the correlation filter:

            mail.list_messages(metadata={"application_id": "app_01H8…"})
        """
        query: Dict[str, str] = {"limit": str(limit)}
        for key, value in (("status", status), ("tag", tag), ("recipient", recipient), ("before", before)):
            if value:
                query[key] = value
        if metadata:
            key, value = next(iter(metadata.items()))
            query["metadata_key"] = key
            query["metadata_value"] = value
        return self._request("GET", "/api/v1/messages?" + urllib.parse.urlencode(query))

    def list_events(self, *, type: Optional[str] = None, message_id: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
        query: Dict[str, str] = {"limit": str(limit)}
        if type:
            query["type"] = type
        if message_id:
            query["message_id"] = message_id
        return self._request("GET", "/api/v1/events?" + urllib.parse.urlencode(query))

    # -- templates --------------------------------------------------------

    def list_templates(self, include_archived: bool = False) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/templates" + ("?include_archived=true" if include_archived else ""))

    def get_template(self, id_or_key: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}")

    def create_template(
        self, key: str, subject: str, html: str, *,
        name: Optional[str] = None, description: Optional[str] = None,
        text: Optional[str] = None, publish: bool = False,
    ) -> Dict[str, Any]:
        return self._request("POST", "/api/v1/templates", {
            "key": key, "name": name or key, "description": description,
            "subject": subject, "html": html, "text": text, "publish": publish,
        })

    def update_template(self, id_or_key: str, **fields: Any) -> Dict[str, Any]:
        """Any content change creates a NEW draft version; an existing version is never rewritten."""
        return self._request("PATCH", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}", fields)

    def publish_template(self, id_or_key: str, version: Optional[int] = None) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}/publish", {"version": version})

    def preview_template(self, id_or_key: str, variables: Dict[str, Any], version: Optional[int] = None) -> Dict[str, Any]:
        """Render without sending. Returns exactly what a send would produce, plus what is missing."""
        return self._request("POST", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}/preview",
                             {"variables": variables, "version": version})

    def copy_template(self, id_or_key: str, to_environment: str, publish: bool = False) -> Dict[str, Any]:
        """Promote a template into another environment."""
        return self._request("POST", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}/copy",
                             {"to_environment": to_environment, "publish": publish})

    def archive_template(self, id_or_key: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/templates/{urllib.parse.quote(id_or_key)}")

    # -- webhooks ---------------------------------------------------------

    def list_webhooks(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/webhooks")

    def create_webhook(self, url: str, events: Optional[Iterable[str]] = None, description: Optional[str] = None, verify: bool = True) -> Dict[str, Any]:
        """Register an endpoint. The signing secret is in the response and is never retrievable again."""
        return self._request("POST", "/api/v1/webhooks", {
            "url": url, "events": list(events or []), "description": description, "verify": verify,
        })

    def update_webhook(self, webhook_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("PATCH", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}", fields)

    def delete_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}")

    def rotate_webhook_secret(self, webhook_id: str, overlap_minutes: int = 1440) -> Dict[str, Any]:
        """Both secrets sign every delivery until the overlap expires, so rotating is not an outage."""
        return self._request("POST", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}/rotate",
                             {"overlap_minutes": overlap_minutes})

    def test_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}/test")

    def list_webhook_deliveries(self, webhook_id: str, status: Optional[str] = None) -> Dict[str, Any]:
        suffix = f"?status={urllib.parse.quote(status)}" if status else ""
        return self._request("GET", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}/deliveries{suffix}")

    def replay_webhook_delivery(self, webhook_id: str, delivery_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}/deliveries",
                             {"delivery_id": delivery_id})

    def replay_dead_webhook_deliveries(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/api/v1/webhooks/{urllib.parse.quote(webhook_id)}/deliveries",
                             {"replay_dead": True})

    # -- suppression + domains --------------------------------------------

    def list_suppressions(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/suppressions")

    def suppress(self, email: str, reason: str = "manual", detail: Optional[str] = None) -> Dict[str, Any]:
        return self._request("POST", "/api/v1/suppressions", {"email": email, "reason": reason, "detail": detail})

    def unsuppress(self, email: str) -> Dict[str, Any]:
        return self._request("DELETE", "/api/v1/suppressions?email=" + urllib.parse.quote(email))

    def list_domains(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/domains")

    def add_domain(self, domain: str) -> Dict[str, Any]:
        return self._request("POST", "/api/v1/domains", {"domain": domain})


# ---------------------------------------------------------------------------
# Webhook verification
# ---------------------------------------------------------------------------


def sign_webhook_payload(secret: str, webhook_id: str, timestamp: Union[str, int], body: str) -> str:
    """The signature we send. Signed content is ``{id}.{timestamp}.{raw body}``."""
    import base64

    signed = f"{webhook_id}.{timestamp}.{body}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode("ascii")


def verify_webhook_signature(
    secret: str,
    webhook_id: str,
    timestamp: Union[str, int],
    signature: str,
    body: str,
    tolerance_seconds: int = 300,
    now: Optional[float] = None,
) -> bool:
    """Verify a webhook delivery.

    ``body`` must be the RAW request body. Re-serialising a parsed dict changes the bytes and the
    check will fail — which is the commonest cause of "your signatures are broken" reports.

    ``signature`` is the whole ``Webhook-Signature`` header; during a secret rotation it carries
    several space-separated signatures and any match is valid.

    A valid signature proves the delivery is ours. It does NOT prove it is new. Dedupe on the
    ``Webhook-Id`` header as well — a retry of a genuine delivery reuses its id, which is what makes
    both our retries and a dead-letter replay safe for you to receive.
    """
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if ts <= 0:
        return False

    current = int(now if now is not None else time.time())
    if abs(current - ts) > tolerance_seconds:
        return False

    expected = sign_webhook_payload(secret, webhook_id, timestamp, body)
    for presented in str(signature or "").split():
        if hmac.compare_digest(presented, expected):
            return True
    return False
