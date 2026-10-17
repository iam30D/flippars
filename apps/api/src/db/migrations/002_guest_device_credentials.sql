ALTER TABLE guest_devices
  ADD COLUMN credential_hash text
  CHECK (credential_hash IS NULL OR credential_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE guest_preferences
  ALTER COLUMN notifications_enabled SET DEFAULT false;

-- Pre-release migration: an earlier OS permission must not stand in for the new
-- explicit in-app alert opt-in. Every installation must opt in again.
UPDATE guest_preferences
SET notifications_enabled = false, updated_at = now();

UPDATE guest_devices
SET push_token_ciphertext = NULL,
    notifications_authorized = false,
    updated_at = now();

COMMENT ON COLUMN guest_devices.credential_hash IS
  'SHA-256 proof hash for anonymous installation mutations; raw credentials are never stored.';

COMMENT ON COLUMN guest_preferences.notifications_enabled IS
  'False until the current guest explicitly opts in to alerts inside Flippars.';
