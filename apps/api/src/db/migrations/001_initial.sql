CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guest_devices (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform = 'ios'),
  push_token_ciphertext text,
  push_environment text NOT NULL CHECK (push_environment IN ('sandbox', 'production')),
  notifications_authorized boolean NOT NULL DEFAULT false,
  app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  locale text NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz
);

CREATE TABLE IF NOT EXISTS guest_preferences (
  device_id uuid PRIMARY KEY REFERENCES guest_devices(id) ON DELETE CASCADE,
  notifications_enabled boolean NOT NULL DEFAULT true,
  signal_types text[] NOT NULL CHECK (
    cardinality(signal_types) >= 1 AND
    signal_types <@ ARRAY['five_minute_reversal', 'fifteen_minute_reversal', 'five_minute_early_direction']::text[]
  ),
  minimum_confidence numeric(6,5) NOT NULL CHECK (minimum_confidence BETWEEN 0.5 AND 1),
  quiet_hours jsonb,
  show_demo_data boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'en',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_registry (
  id text PRIMARY KEY,
  signal_type text NOT NULL CHECK (signal_type IN ('five_minute_reversal', 'fifteen_minute_reversal', 'five_minute_early_direction')),
  version text NOT NULL,
  artifact_uri text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('candidate', 'shadow', 'approved', 'retired')),
  approved_at timestamptz,
  minimum_confidence numeric(6,5) NOT NULL CHECK (minimum_confidence BETWEEN 0.5 AND 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz,
  UNIQUE (signal_type, version),
  CHECK ((status <> 'approved') OR approved_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_registry_one_approved_per_signal
  ON model_registry(signal_type) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS market_observations (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL CHECK (symbol = 'BTC-USD'),
  price numeric(24,10) NOT NULL CHECK (price > 0),
  bid numeric(24,10) NOT NULL CHECK (bid > 0),
  ask numeric(24,10) NOT NULL CHECK (ask > 0),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  retain_until timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS market_observations_observed_at_idx ON market_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS market_observations_retention_idx ON market_observations(retain_until);

CREATE TABLE IF NOT EXISTS signals (
  id text PRIMARY KEY,
  signal_type text NOT NULL CHECK (signal_type IN ('five_minute_reversal', 'fifteen_minute_reversal', 'five_minute_early_direction')),
  direction text NOT NULL CHECK (direction IN ('higher', 'lower')),
  open_price numeric(24,10) NOT NULL CHECK (open_price > 0),
  current_price numeric(24,10) NOT NULL CHECK (current_price > 0),
  confidence numeric(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  interval_start timestamptz NOT NULL,
  interval_end timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  model_id text NOT NULL REFERENCES model_registry(id),
  model_version text NOT NULL,
  explanation jsonb NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  retain_until timestamptz NOT NULL,
  UNIQUE (signal_type, interval_start),
  CHECK (interval_end > interval_start),
  CHECK (expires_at <= interval_end),
  CHECK (issued_at < expires_at)
);

CREATE INDEX IF NOT EXISTS signals_issued_at_idx ON signals(issued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS signals_retention_idx ON signals(retain_until);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  signal_id text PRIMARY KEY REFERENCES signals(id) ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('correct', 'incorrect', 'flat', 'void')),
  close_price numeric(24,10),
  evaluated_at timestamptz NOT NULL,
  reason text NOT NULL,
  retain_until timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  device_id uuid NOT NULL REFERENCES guest_devices(id) ON DELETE CASCADE,
  signal_id text NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  status text NOT NULL,
  apns_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (device_id, signal_id)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_retention_idx ON notification_deliveries(retain_until);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_retention_idx ON audit_events(retain_until);

CREATE OR REPLACE FUNCTION prevent_signal_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'signals are immutable; record an outcome instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signals_immutable ON signals;
CREATE TRIGGER signals_immutable BEFORE UPDATE OR DELETE ON signals
  FOR EACH ROW EXECUTE FUNCTION prevent_signal_mutation();

COMMENT ON TABLE guest_devices IS 'Anonymous installations only; deleting a device cascades preferences and delivery metadata.';
COMMENT ON TABLE signals IS 'Immutable prediction ledger. Exactly one signal of a type may exist per UTC interval.';
COMMENT ON TABLE market_observations IS 'Short-lived composite observations. Delete rows after retain_until using the retention job.';
