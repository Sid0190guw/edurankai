-- Face 2FA schema. Idempotent. Assumes a `users` table with `id UUID` PK.
-- Run once against your target DB.

CREATE TABLE IF NOT EXISTS user_face_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  face_descriptor JSONB NOT NULL,            -- 128 floats from faceRecognitionNet
  device_info  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional but recommended: an audit log of every face attempt.
CREATE TABLE IF NOT EXISTS face_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  distance     DOUBLE PRECISION,
  passed       BOOLEAN NOT NULL,
  method       VARCHAR(20),                   -- 'enroll' | 'login'
  ip_address   VARCHAR(64),
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional convenience flags on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS face_enrolled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ;
