# EduRankAI Forms

The Forms module is part of the existing admin panel. Administrators with content edit access can
create a blank draft, configure questions, preview the public renderer, publish, duplicate a form,
and search or page through its responses.

## Current form contract

Form questions remain in the existing `forms.fields` JSONB column. `src/lib/forms/form-schema.ts`
normalizes stored definitions and validates submitted answers on the server. Saved question keys are
kept stable so editing a label does not detach answers from existing submissions. The public
submission endpoint stores only declared answers and records an acknowledgment statement and
timestamp when a respondent accepts a required acknowledgment.

Supported question types are short text, paragraph, email, phone, URL, number, date, time, date/time,
dropdown, radio, checkbox, yes/no, acknowledgment, optional selfie, optional location, and optional
drawn signature. Choice options, text lengths, and numeric bounds are validated before publication
or submission.

## Draft preview

The editor's **Preview form** link opens `/f/{slug}?preview=1`. That route checks the existing
`content.view` permission before loading a draft. Preview controls are disabled, the payment widget
is not loaded, and the submission handler does not run. Ordinary public links continue to return
only published forms; the submission API independently requires publication.

## Creating and duplicating forms

**Create from scratch** starts with no questions. **Duplicate** creates a separate unpublished form
with the source form's question definition and settings; it does not copy responses. A duplicate
gets a unique public slug and remains a draft until explicitly published.

Response workspaces provide search, pagination, CSV export, and structured JSON export. Both export
routes require the existing content-export permission. The JSON export contains form metadata,
question definitions, respondent contact fields, payment status, and answer data; it excludes
request IP addresses and payment-provider identifiers.

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
settings, theme modes, and enterprise collaboration/audit workflows are not implemented. Other
advanced question types in the master specification are also not yet available. Do not represent
these as available features until implemented and verified.
