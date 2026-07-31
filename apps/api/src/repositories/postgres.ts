import { Pool, type PoolConfig } from "pg";
import type {
  AuditEvent,
  Candle,
  DeviceRecord,
  MarketSnapshot,
  ModelRecord,
  OutcomeRecord,
  PreferencesRecord,
  SignalRecord,
  SignalType,
} from "../domain.js";
import { SecretCipher } from "./crypto.js";
import {
  defaultPreferences,
  type PutPreferencesInput,
  type Repository,
  type SignalCursor,
  type SignalPage,
  type UpsertDeviceInput,
} from "./repository.js";

export class PostgresRepository implements Repository {
  readonly pool: Pool;
  private readonly cipher: SecretCipher | null;

  constructor(config: PoolConfig, encryptionKey?: string) {
    this.pool = new Pool({
      ...config,
      max: config.max ?? 12,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    });
    this.cipher = encryptionKey ? new SecretCipher(encryptionKey) : null;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertDevice(input: UpsertDeviceInput): Promise<DeviceRecord> {
    const token = input.pushToken ? this.encryptToken(input.pushToken) : null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DatabaseRow>(
        `INSERT INTO guest_devices
          (id, platform, push_token_ciphertext, push_environment, notifications_authorized, app_version, locale, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
          push_token_ciphertext = EXCLUDED.push_token_ciphertext,
          push_environment = EXCLUDED.push_environment,
          notifications_authorized = EXCLUDED.notifications_authorized,
          app_version = EXCLUDED.app_version,
          locale = EXCLUDED.locale,
          timezone = EXCLUDED.timezone,
          updated_at = now(), last_seen_at = now(), retain_until = NULL
         RETURNING *`,
        [
          input.id,
          input.platform,
          token,
          input.pushEnvironment,
          input.notificationsAuthorized,
          input.appVersion,
          input.locale,
          input.timezone,
        ],
      );
      await client.query(
        `INSERT INTO guest_preferences
          (device_id, notifications_enabled, signal_types, minimum_confidence, quiet_hours, show_demo_data, locale)
         VALUES ($1, true, $2, 0.75, $3::jsonb, false, $4)
         ON CONFLICT (device_id) DO NOTHING`,
        [
          input.id,
          defaultPreferences(input.id).signalTypes,
          JSON.stringify(defaultPreferences(input.id).quietHours),
          input.locale,
        ],
      );
      await client.query("COMMIT");
      return this.mapDevice(requiredRow(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteDevice(id: string): Promise<boolean> {
    const result = await this.pool.query<DatabaseRow>(
      "DELETE FROM guest_devices WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async putPreferences(input: PutPreferencesInput): Promise<PreferencesRecord> {
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO guest_preferences
        (device_id, notifications_enabled, signal_types, minimum_confidence, quiet_hours, show_demo_data, locale, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       ON CONFLICT (device_id) DO UPDATE SET
        notifications_enabled = EXCLUDED.notifications_enabled,
        signal_types = EXCLUDED.signal_types,
        minimum_confidence = EXCLUDED.minimum_confidence,
        quiet_hours = EXCLUDED.quiet_hours,
        show_demo_data = EXCLUDED.show_demo_data,
        locale = EXCLUDED.locale,
        updated_at = now()
       RETURNING *`,
      [
        input.deviceId,
        input.notificationsEnabled,
        input.signalTypes,
        input.minimumConfidence,
        JSON.stringify(input.quietHours),
        input.showDemoData,
        input.locale,
      ],
    );
    return this.mapPreferences(requiredRow(result.rows[0]));
  }

  async getPreferences(deviceId: string): Promise<PreferencesRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      "SELECT * FROM guest_preferences WHERE device_id = $1",
      [deviceId],
    );
    return result.rows[0] ? this.mapPreferences(result.rows[0]) : null;
  }

  async notificationTargets(signal: SignalRecord) {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT d.*, p.notifications_enabled, p.signal_types, p.minimum_confidence,
              p.quiet_hours, p.updated_at AS preferences_updated_at
       FROM guest_devices d
       JOIN guest_preferences p ON p.device_id = d.id
       WHERE d.push_token_ciphertext IS NOT NULL
         AND p.notifications_enabled = true
         AND $1 = ANY(p.signal_types)
         AND p.minimum_confidence <= $2`,
      [signal.type, signal.confidence],
    );
    return result.rows.map((row) => ({
      device: this.mapDevice(row),
      preferences: this.mapPreferences(row, "preferences_updated_at"),
    }));
  }

  async claimNotification(
    deviceId: string,
    signalId: string,
    expiresAt: string,
  ): Promise<boolean> {
    const retainUntil = new Date(Date.parse(expiresAt) + 30 * 86_400_000).toISOString();
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO notification_deliveries(device_id, signal_id, status, retain_until)
       VALUES ($1, $2, 'claimed', $3)
       ON CONFLICT (device_id, signal_id) DO NOTHING`,
      [deviceId, signalId, retainUntil],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordNotificationResult(
    deviceId: string,
    signalId: string,
    status: string,
    apnsId: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE notification_deliveries SET status = $3, apns_id = $4, updated_at = now()
       WHERE device_id = $1 AND signal_id = $2`,
      [deviceId, signalId, status, apnsId],
    );
  }

  async createSignal(
    signal: SignalRecord,
  ): Promise<{ created: boolean; signal: SignalRecord }> {
    const retainUntil = new Date(
      Date.parse(signal.intervalEnd) + 7 * 365 * 86_400_000,
    ).toISOString();
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO signals
        (id, signal_type, direction, open_price, current_price, confidence, interval_start,
         interval_end, issued_at, expires_at, model_id, model_version, explanation, input_snapshot, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
       ON CONFLICT (signal_type, interval_start) DO NOTHING
       RETURNING *`,
      [
        signal.id,
        signal.type,
        signal.direction,
        signal.openPrice,
        signal.currentPrice,
        signal.confidence,
        signal.intervalStart,
        signal.intervalEnd,
        signal.issuedAt,
        signal.expiresAt,
        signal.modelId,
        signal.modelVersion,
        JSON.stringify(signal.explanation),
        JSON.stringify(signal.canonical ?? {}),
        retainUntil,
      ],
    );
    if (result.rows[0])
      return { created: true, signal: this.mapSignal(result.rows[0]) };
    const existing = await this.pool.query<DatabaseRow>(
      `SELECT s.*, o.result AS outcome_result, o.close_price AS outcome_close_price,
              o.evaluated_at AS outcome_evaluated_at, o.reason AS outcome_reason
       FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       WHERE s.signal_type = $1 AND s.interval_start = $2`,
      [signal.type, signal.intervalStart],
    );
    return { created: false, signal: this.mapSignal(requiredRow(existing.rows[0])) };
  }

  async getSignal(id: string): Promise<SignalRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT s.*, o.result AS outcome_result, o.close_price AS outcome_close_price,
              o.evaluated_at AS outcome_evaluated_at, o.reason AS outcome_reason
       FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id WHERE s.id = $1`,
      [id],
    );
    return result.rows[0] ? this.mapSignal(result.rows[0]) : null;
  }

  async listSignals(input: {
    type?: SignalType;
    limit: number;
    cursor?: SignalCursor;
  }): Promise<SignalPage> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.type) {
      values.push(input.type);
      where.push(`s.signal_type = $${values.length}`);
    }
    if (input.cursor) {
      values.push(input.cursor.issuedAt, input.cursor.id);
      where.push(
        `(s.issued_at, s.id) < ($${values.length - 1}::timestamptz, $${values.length}::text)`,
      );
    }
    values.push(input.limit + 1);
    const result = await this.pool.query<DatabaseRow>(
      `SELECT s.*, o.result AS outcome_result, o.close_price AS outcome_close_price,
              o.evaluated_at AS outcome_evaluated_at, o.reason AS outcome_reason
       FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.issued_at DESC, s.id DESC LIMIT $${values.length}`,
      values,
    );
    const selected = result.rows.map((row) => this.mapSignal(row));
    const hasMore = selected.length > input.limit;
    const items = selected.slice(0, input.limit);
    const last = hasMore ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { issuedAt: last.issuedAt, id: last.id } : null,
    };
  }

  async unresolvedSignals(before: string, limit: number): Promise<SignalRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT s.* FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id
       WHERE o.signal_id IS NULL AND s.interval_end <= $1
       ORDER BY s.interval_end ASC LIMIT $2`,
      [before, limit],
    );
    return result.rows.map((row) => this.mapSignal(row));
  }

  async createOutcome(outcome: OutcomeRecord): Promise<boolean> {
    const retainUntil = new Date(
      Date.parse(outcome.evaluatedAt) + 7 * 365 * 86_400_000,
    ).toISOString();
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO signal_outcomes(signal_id, result, close_price, evaluated_at, reason, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (signal_id) DO NOTHING`,
      [
        outcome.signalId,
        outcome.result,
        outcome.closePrice,
        outcome.evaluatedAt,
        outcome.reason,
        retainUntil,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getApprovedModel(type: SignalType): Promise<ModelRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      "SELECT * FROM model_registry WHERE signal_type = $1 AND status = 'approved' ORDER BY approved_at DESC LIMIT 1",
      [type],
    );
    return result.rows[0] ? this.mapModel(result.rows[0]) : null;
  }

  async insertMarketObservation(
    snapshot: MarketSnapshot,
    retainUntil: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_observations(symbol, price, bid, ask, observed_at, payload, retain_until)
       VALUES ('BTC-USD', $1, $2, $3, $4, $5::jsonb, $6)`,
      [
        snapshot.price,
        snapshot.bid,
        snapshot.ask,
        snapshot.observedAt,
        JSON.stringify(snapshot),
        retainUntil,
      ],
    );
  }

  async latestMarketSnapshot(): Promise<MarketSnapshot | null> {
    const result = await this.pool.query<DatabaseRow>(
      "SELECT payload FROM market_observations ORDER BY observed_at DESC LIMIT 1",
    );
    return (result.rows[0]?.["payload"] as MarketSnapshot | undefined) ?? null;
  }

  async candles(input: {
    interval: "1m" | "5m" | "15m";
    from: string;
    to: string;
    limit: number;
  }): Promise<Candle[]> {
    const seconds = input.interval === "1m" ? 60 : input.interval === "5m" ? 300 : 900;
    const result = await this.pool.query<DatabaseRow>(
      `WITH bucketed AS (
         SELECT to_timestamp(floor(extract(epoch FROM observed_at) / $1) * $1) AS bucket,
                observed_at, price
         FROM market_observations WHERE observed_at >= $2 AND observed_at < $3
       ), ranked AS (
         SELECT bucket, observed_at, price,
                row_number() OVER (PARTITION BY bucket ORDER BY observed_at) AS first_rank,
                row_number() OVER (PARTITION BY bucket ORDER BY observed_at DESC) AS last_rank
         FROM bucketed
       )
       SELECT bucket,
              max(price) AS high, min(price) AS low, count(*)::int AS observations,
              max(price) FILTER (WHERE first_rank = 1) AS open,
              max(price) FILTER (WHERE last_rank = 1) AS close
       FROM ranked GROUP BY bucket ORDER BY bucket DESC LIMIT $4`,
      [seconds, input.from, input.to, input.limit],
    );
    return result.rows.reverse().map((row) => ({
      startAt: iso(row["bucket"]),
      endAt: new Date(Date.parse(iso(row["bucket"])) + seconds * 1000).toISOString(),
      interval: input.interval,
      open: number(row["open"]),
      high: number(row["high"]),
      low: number(row["low"]),
      close: number(row["close"]),
      observations: Number(row["observations"]),
    }));
  }

  async closePriceAt(at: string, toleranceMs: number): Promise<number | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT price FROM market_observations
       WHERE observed_at BETWEEN $1::timestamptz - ($2 * interval '1 millisecond')
                             AND $1::timestamptz + ($2 * interval '1 millisecond')
       ORDER BY abs(extract(epoch FROM (observed_at - $1::timestamptz))) LIMIT 1`,
      [at, toleranceMs],
    );
    return result.rows[0] ? number(result.rows[0]["price"]) : null;
  }

  async audit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events(id, action, subject_type, subject_id, request_id, metadata, occurred_at, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [
        event.id,
        event.action,
        event.subjectType,
        event.subjectId,
        event.requestId,
        JSON.stringify(event.metadata),
        event.occurredAt,
        event.retainUntil,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapDevice(row: DatabaseRow): DeviceRecord {
    const encrypted = row["push_token_ciphertext"] as string | null | undefined;
    return {
      id: String(row["id"]),
      platform: "ios",
      pushToken: encrypted ? this.decryptToken(encrypted) : null,
      pushEnvironment: String(row["push_environment"]) as "sandbox" | "production",
      notificationsAuthorized: Boolean(row["notifications_authorized"]),
      appVersion: String(row["app_version"]),
      locale: String(row["locale"]),
      timezone: String(row["timezone"]),
      createdAt: iso(row["created_at"]),
      updatedAt: iso(row["updated_at"]),
      lastSeenAt: iso(row["last_seen_at"]),
    };
  }

  private mapPreferences(
    row: DatabaseRow,
    updatedKey = "updated_at",
  ): PreferencesRecord {
    return {
      deviceId: String(row["device_id"] ?? row["id"]),
      notificationsEnabled: Boolean(row["notifications_enabled"]),
      signalTypes: (row["signal_types"] as SignalType[]) ?? [],
      minimumConfidence: number(row["minimum_confidence"]),
      quietHours:
        (row["quiet_hours"] as PreferencesRecord["quietHours"]) ??
        defaultPreferences(String(row["device_id"] ?? row["id"])).quietHours,
      showDemoData: Boolean(row["show_demo_data"]),
      locale: stringOr(row["locale"], "en"),
      updatedAt: iso(row[updatedKey]),
    };
  }

  private mapSignal(row: DatabaseRow): SignalRecord {
    const result = row["outcome_result"] as OutcomeRecord["result"] | null | undefined;
    return {
      id: String(row["id"]),
      type: String(row["signal_type"]) as SignalType,
      direction: String(row["direction"]) as SignalRecord["direction"],
      openPrice: number(row["open_price"]),
      currentPrice: number(row["current_price"]),
      confidence: number(row["confidence"]),
      intervalStart: iso(row["interval_start"]),
      intervalEnd: iso(row["interval_end"]),
      issuedAt: iso(row["issued_at"]),
      expiresAt: iso(row["expires_at"]),
      modelId: String(row["model_id"]),
      modelVersion: String(row["model_version"]),
      explanation: row["explanation"] as SignalRecord["explanation"],
      outcome: result
        ? {
            signalId: String(row["id"]),
            result,
            closePrice:
              row["outcome_close_price"] === null
                ? null
                : number(row["outcome_close_price"]),
            evaluatedAt: iso(row["outcome_evaluated_at"]),
            reason: String(row["outcome_reason"]),
          }
        : null,
      ...(row["input_snapshot"] &&
      typeof row["input_snapshot"] === "object" &&
      "type" in row["input_snapshot"]
        ? { canonical: row["input_snapshot"] as NonNullable<SignalRecord["canonical"]> }
        : {}),
    };
  }

  private mapModel(row: DatabaseRow): ModelRecord {
    return {
      id: String(row["id"]),
      signalType: String(row["signal_type"]) as SignalType,
      version: String(row["version"]),
      artifactUri: String(row["artifact_uri"]),
      artifactSha256: String(row["artifact_sha256"]),
      status: String(row["status"]) as ModelRecord["status"],
      approvedAt: row["approved_at"] ? iso(row["approved_at"]) : null,
      minimumConfidence: number(row["minimum_confidence"]),
      metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    };
  }

  private encryptToken(token: string): string {
    if (!this.cipher) throw new Error("Push-token encryption key is not configured");
    return this.cipher.encrypt(token);
  }

  private decryptToken(token: string): string | null {
    if (!this.cipher) return null;
    try {
      return this.cipher.decrypt(token);
    } catch {
      return null;
    }
  }
}

type DatabaseRow = Record<string, unknown>;

function requiredRow(row: DatabaseRow | undefined): DatabaseRow {
  if (!row) throw new Error("Expected database row");
  return row;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error("Database returned a non-finite numeric value");
  return parsed;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
