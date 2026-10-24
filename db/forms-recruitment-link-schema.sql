-- Link a Forms definition to one authoritative Careers role.
-- Apply this migration manually; application startup must not perform schema changes.
CREATE TABLE IF NOT EXISTS form_role_links (
  form_id UUID PRIMARY KEY,
  role_id UUID NOT NULL,
  name_field_key TEXT NOT NULL,
  email_field_key TEXT NOT NULL,
  phone_field_key TEXT,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_role_links_role_idx ON form_role_links(role_id);

ALTER TABLE form_responses
  ADD COLUMN IF NOT EXISTS application_id UUID,
  ADD COLUMN IF NOT EXISTS applicant_user_id UUID;

ALTER TABLE form_role_links
  ADD COLUMN IF NOT EXISTS reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS form_responses_application_idx
  ON form_responses(application_id)
  WHERE application_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS application_stage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  from_stage VARCHAR(40),
  to_stage VARCHAR(40) NOT NULL,
  actor_user_id UUID,
  actor_name VARCHAR(200),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ase_app_idx
  ON application_stage_events(application_id, created_at ASC);
