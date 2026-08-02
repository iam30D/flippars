-- Governed model foundation only. This migration does not register, approve,
-- bundle, deploy, or enable a model.

ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS bundle_manifest_sha256 text,
  ADD COLUMN IF NOT EXISTS dataset_sha256 text,
  ADD COLUMN IF NOT EXISTS feature_schema_version text,
  ADD COLUMN IF NOT EXISTS policy_version text,
  ADD COLUMN IF NOT EXISTS calibration_version text,
  ADD COLUMN IF NOT EXISTS calibration_valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS shadow_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS shadow_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS shadow_independent_windows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_report_sha256 text,
  ADD COLUMN IF NOT EXISTS release_stage text,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

ALTER TABLE model_registry
  ADD CONSTRAINT model_registry_governance_hashes CHECK (
    (bundle_manifest_sha256 IS NULL OR bundle_manifest_sha256 ~ '^[a-f0-9]{64}$') AND
    (dataset_sha256 IS NULL OR dataset_sha256 ~ '^[a-f0-9]{64}$') AND
    (shadow_report_sha256 IS NULL OR shadow_report_sha256 ~ '^[a-f0-9]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT model_registry_release_stage CHECK (
    release_stage IS NULL OR release_stage IN ('CANARY', 'GENERAL')
  ) NOT VALID,
  ADD CONSTRAINT model_registry_shadow_values CHECK (
    shadow_independent_windows >= 0 AND
    (shadow_ended_at IS NULL OR shadow_started_at IS NOT NULL) AND
    (shadow_ended_at IS NULL OR shadow_ended_at > shadow_started_at)
  ) NOT VALID,
  ADD CONSTRAINT model_registry_governed_approval CHECK (
    status <> 'approved' OR (
      bundle_manifest_sha256 IS NOT NULL AND
      dataset_sha256 IS NOT NULL AND
      feature_schema_version IS NOT NULL AND
      policy_version IS NOT NULL AND
      calibration_version IS NOT NULL AND
      calibration_valid_until IS NOT NULL AND
      shadow_started_at IS NOT NULL AND
      shadow_ended_at IS NOT NULL AND
      shadow_ended_at - shadow_started_at >= interval '84 days' AND
      shadow_independent_windows >= 300 AND
      shadow_report_sha256 IS NOT NULL AND
      release_stage IS NOT NULL AND
      approved_at IS NOT NULL AND
      calibration_valid_until > approved_at
    )
  ) NOT VALID,
  ADD CONSTRAINT model_registry_lifecycle_timestamps CHECK (
    (status IN ('candidate', 'shadow') AND
      approved_at IS NULL AND release_stage IS NULL AND retired_at IS NULL) OR
    (status = 'approved' AND approved_at IS NOT NULL AND retired_at IS NULL) OR
    (status = 'retired' AND retired_at IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT model_registry_retirement_timestamp CHECK (
    status <> 'retired' OR retired_at IS NOT NULL
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS model_approval_records (
  statement_id text PRIMARY KEY CHECK (
    statement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  ),
  model_id text NOT NULL REFERENCES model_registry(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision = 'APPROVE'),
  release_stage text NOT NULL CHECK (release_stage IN ('CANARY', 'GENERAL')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  statement_sha256 text NOT NULL UNIQUE CHECK (
    statement_sha256 ~ '^[a-f0-9]{64}$'
  ),
  approver_id text NOT NULL CHECK (
    approver_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  ),
  approver_role text NOT NULL CHECK (approver_role IN (
    'INDEPENDENT_VALIDATOR',
    'MODEL_OWNER',
    'PRODUCT_OWNER',
    'SECURITY_REVIEWER'
  )),
  signer_key_id text NOT NULL CHECK (
    signer_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  ),
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  signed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > signed_at),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS model_approval_records_lookup_idx
  ON model_approval_records(model_id, manifest_sha256, release_stage, approver_role);

CREATE OR REPLACE FUNCTION prevent_model_approval_record_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'model approval records are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS model_approval_records_immutable ON model_approval_records;
CREATE TRIGGER model_approval_records_immutable
  BEFORE UPDATE OR DELETE ON model_approval_records
  FOR EACH ROW EXECUTE FUNCTION prevent_model_approval_record_mutation();

CREATE OR REPLACE FUNCTION guard_model_registry_governance()
RETURNS trigger AS $$
DECLARE
  approval_role_count integer;
  approval_identity_count integer;
  approval_key_count integer;
  general_stage_transition boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION 'new model registry rows must begin as candidate';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.signal_type IS DISTINCT FROM OLD.signal_type OR
     NEW.version IS DISTINCT FROM OLD.version OR
     NEW.artifact_uri IS DISTINCT FROM OLD.artifact_uri OR
     NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256 OR
     NEW.minimum_confidence IS DISTINCT FROM OLD.minimum_confidence OR
     NEW.metadata IS DISTINCT FROM OLD.metadata OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'model artifact identity and policy metadata are immutable';
  END IF;

  IF OLD.dataset_sha256 IS NOT NULL AND
     NEW.dataset_sha256 IS DISTINCT FROM OLD.dataset_sha256 THEN
    RAISE EXCEPTION 'model dataset digest is immutable once recorded';
  END IF;
  IF OLD.feature_schema_version IS NOT NULL AND
     NEW.feature_schema_version IS DISTINCT FROM OLD.feature_schema_version THEN
    RAISE EXCEPTION 'model feature schema is immutable once recorded';
  END IF;
  IF OLD.policy_version IS NOT NULL AND
     NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
    RAISE EXCEPTION 'model policy version is immutable once recorded';
  END IF;
  IF OLD.calibration_version IS NOT NULL AND
     NEW.calibration_version IS DISTINCT FROM OLD.calibration_version THEN
    RAISE EXCEPTION 'model calibration version is immutable once recorded';
  END IF;
  IF OLD.calibration_valid_until IS NOT NULL AND
     NEW.calibration_valid_until IS DISTINCT FROM OLD.calibration_valid_until THEN
    RAISE EXCEPTION 'model calibration validity is immutable once recorded';
  END IF;

  general_stage_transition :=
    OLD.status = 'approved' AND
    NEW.status = 'approved' AND
    OLD.release_stage = 'CANARY' AND
    NEW.release_stage = 'GENERAL';

  IF general_stage_transition AND (
    NEW.bundle_manifest_sha256 IS NOT DISTINCT FROM OLD.bundle_manifest_sha256 OR
    NEW.approved_at IS NULL OR
    OLD.approved_at IS NULL OR
    NEW.approved_at <= OLD.approved_at
  ) THEN
    RAISE EXCEPTION 'general release requires a new manifest and later approval timestamp';
  END IF;

  IF OLD.bundle_manifest_sha256 IS NOT NULL AND
     NEW.bundle_manifest_sha256 IS DISTINCT FROM OLD.bundle_manifest_sha256 AND
     NOT general_stage_transition THEN
    RAISE EXCEPTION 'bundle manifest digest may change only for general release';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'candidate' AND NEW.status IN ('shadow', 'retired')) OR
    (OLD.status = 'shadow' AND NEW.status IN ('approved', 'retired')) OR
    (OLD.status = 'approved' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid model lifecycle transition: % to %', OLD.status, NEW.status;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'approved' AND
     NOT general_stage_transition THEN
    RAISE EXCEPTION 'approved model rows are immutable except CANARY to GENERAL';
  END IF;

  IF NEW.status = 'shadow' AND NEW.shadow_started_at IS NULL THEN
    RAISE EXCEPTION 'shadow status requires shadow_started_at';
  END IF;

  IF NEW.status = 'retired' AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'retirement requires retired_at';
  END IF;

  IF (OLD.status = 'shadow' AND NEW.status = 'approved') OR
     general_stage_transition THEN
    SELECT
      count(DISTINCT approver_role),
      count(DISTINCT approver_id),
      count(DISTINCT signer_key_id)
    INTO approval_role_count, approval_identity_count, approval_key_count
    FROM model_approval_records
    WHERE model_id = NEW.id
      AND manifest_sha256 = NEW.bundle_manifest_sha256
      AND artifact_sha256 = NEW.artifact_sha256
      AND release_stage = NEW.release_stage
      AND signed_at <= NEW.approved_at
      AND (NOT general_stage_transition OR signed_at > OLD.approved_at)
      AND valid_until >= NEW.approved_at;

    IF approval_role_count < 4 OR
       approval_identity_count < 4 OR
       approval_key_count < 4 THEN
      RAISE EXCEPTION 'approval requires four distinct governed roles, identities, and keys';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS model_registry_governance_guard ON model_registry;
CREATE TRIGGER model_registry_governance_guard
  BEFORE INSERT OR UPDATE ON model_registry
  FOR EACH ROW EXECUTE FUNCTION guard_model_registry_governance();

COMMENT ON TABLE model_approval_records IS
  'Append-only detached approval statements. Signatures must be verified offline before insertion.';
COMMENT ON COLUMN model_approval_records.signature IS
  'Raw 64-byte Ed25519 signature; the database stores but does not cryptographically verify it.';
COMMENT ON FUNCTION guard_model_registry_governance() IS
  'Guards lifecycle shape only. It does not replace external evidence review or signature verification.';
