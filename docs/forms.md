# EduRankAI Forms

The Forms module is part of the existing admin panel. Administrators with content edit access can
create a blank draft, configure questions, preview the public renderer, publish, duplicate a form,
and search or page through its responses.

## Current form contract

Form questions remain in the existing `forms.fields` JSONB column. `src/lib/forms/form-schema.ts`
normalizes stored definitions (including JSON-serialized field arrays from older integrations) and validates submitted answers on the server. Saved question keys are
kept stable so editing a label does not detach answers from existing submissions. The public
submission endpoint stores only declared answers and records an acknowledgment statement and
timestamp when a respondent accepts a required acknowledgment. It rechecks publication readiness
and returns an explicit client or service error rather than treating a failed lookup or write as a
successful submission.

Supported question types are short text, paragraph, email, phone, URL, number, currency, percentage,
duration, date, time, date/time, dropdown, radio, checkbox, yes/no, numeric rating, linear scale,
acknowledgment, optional selfie, optional location, and optional drawn signature. Choice options,
text lengths, numeric bounds, dates, and conditional rules are validated before publication or
submission.

## Public respondent experience and sharing

`/f/{slug}` renders the saved, published question definition through the same normalizer used by the
editor and submission endpoint; it does not substitute a fixed set of contact fields. An invalid or
empty published definition displays an unavailable state instead of a blank form. The respondent
view hides the marketing navigation and footer, adapts to mobile, and provides system, light, dark,
and reading appearance modes. Forms with multiple named sections have progress, back, and continue
controls; required fields are validated as respondents advance and again on submission.

The editor's Share and publish area provides the public URL, copy and open actions, native device
sharing where available, an email link, a QR code, and responsive iframe code. Publishing remains
the existing explicit `is_published` toggle. These links are public (except for linked Careers
submissions, which still require a verified applicant account); domain allowlists, expiry dates,
capacity limits, scheduled publication, referral tracking, and form version history are not
configured by this interface.

## Draft preview

The editor's **Preview form** link opens `/f/{slug}?preview=1`. That route checks the existing
`content.view` permission before loading a draft. Respondents can navigate preview sections, but
submission is disabled, the payment widget is not loaded, and the submission handler does not run.
Ordinary public links continue to return only published forms; the submission API independently
requires publication.

## Creating and duplicating forms

**Create from scratch** starts with no questions. **Duplicate** creates a separate unpublished form
with the source form's question definition and settings; it does not copy responses. A duplicate
gets a unique public slug and remains a draft until explicitly published.

Response workspaces provide search, pagination, CSV export, and structured JSON export. Both export
routes require the existing content-export permission. The JSON export contains form metadata,
question definitions, respondent contact fields, payment status, and answer data; it excludes
request IP addresses and payment-provider identifiers. CSV exports use the shared formula-injection
guard, normalize saved field definitions, and are marked private/no-store.

Public submissions are limited to ten attempts per source IP in a one-hour window; if the limiter
cannot be reached, a submission is refused. Payment confirmations have a separate limit and also
fail closed when its counter is unavailable. Ordinary forms allow multiple responses and do not yet
use an idempotency key, so retrying an ambiguous successful request can create a second response.
Linked Careers applications instead serialize on candidate and role and return an existing active
application rather than creating a duplicate.

## Careers application links

An administrator can link a form to one open Careers role and map required text/email questions
plus an optional phone question and optionally assign new applications to an active HR, recruiter,
reviewer, or department-head account. Recruitment form submissions require an active, verified,
signed-in applicant account whose verified email matches the mapped answer. The server rechecks
that the role is open and before its deadline, serializes submissions for the same candidate/role,
enforces the existing active-duplicate and six-month reapplication policy, creates the existing
`applications` record with its reviewer assignment and initial stage-history event, and stores the
original response separately with its application reference. Candidates are sent to their existing
My Applications page. No account or alternate applications table is created.

The additive SQL in `db/forms-recruitment-link-schema.sql` must be applied manually before enabling
this feature. It creates the form-to-role configuration, optional reviewer assignment, and response
relationship columns and the initial stage-history table if it is absent. The existing application
stage columns are managed separately by `db/application-stages-schema.sql`; follow that file's
lock-timeout and verification instructions if either column is missing. Ordinary public forms
continue to submit without the Forms migration; recruitment linking is unavailable until it is
applied. Recruitment forms must have a zero form fee and mapped required identity questions. Job
availability and the configured reviewer account are checked again at submission, not only in the
editor.

## Candidate Intake template and remaining scope

The exact “EduRankAI Candidate Intake & Intelligence Application — Fall” sample must be transcribed
from `from intell.pdf`. That source PDF was not present with the supplied specification or in the
repository when this implementation was prepared. Do not seed or advertise a reconstructed sample
from the question inventory: the specification requires exact wording, options, descriptions, and
required flags, and explicitly prohibits guessing.

The current module is not yet the complete Forms Studio described by the master specification.
Named sections, conditional visibility based on an earlier question, numeric ratings and linear
scales, payment-state totals, and a recent submission trend are implemented. Trend and counts are
measured response records only; no abandonment or completion-time estimate is presented.

Reusable template management, historical form versions, file uploads, advanced access/distribution
settings, and enterprise collaboration/audit workflows are not implemented. Other
advanced question types in the master specification are also not yet available. Do not represent
these as available features until implemented and verified.

The wider Phase 2 roadmap is also incomplete: secure post-submit account claims, configurable
recruitment-stage pipelines, document/OCR import and review, event registration capacity/check-in,
and the other mail, archive, inbound-routing, deliverability, and employee identity requirements
are not delivered by this slice.
