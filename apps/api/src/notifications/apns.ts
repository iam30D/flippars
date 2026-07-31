import { connect, constants, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type { DeviceRecord, SignalRecord } from "../domain.js";

export interface PushResult {
  accepted: boolean;
  status: number;
  reason: string | null;
  apnsId: string | null;
}

export interface ApnsClient {
  send(device: DeviceRecord, signal: SignalRecord): Promise<PushResult>;
  close(): Promise<void>;
}

export interface ApnsTokenOptions {
  environment: "sandbox" | "production";
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
}

export class TokenApnsClient implements ApnsClient {
  private session: ClientHttp2Session | null = null;
  private signingKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
  private cachedJwt: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: ApnsTokenOptions) {}

  async send(device: DeviceRecord, signal: SignalRecord): Promise<PushResult> {
    if (!device.pushToken)
      return { accepted: false, status: 0, reason: "missing_push_token", apnsId: null };
    if (device.pushEnvironment !== this.options.environment) {
      return {
        accepted: false,
        status: 0,
        reason: "apns_environment_mismatch",
        apnsId: null,
      };
    }
    if (Date.parse(signal.expiresAt) <= Date.now())
      return { accepted: false, status: 0, reason: "signal_expired", apnsId: null };
    const jwt = await this.authorizationToken();
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: title(signal),
          body: body(signal),
        },
        sound: "default",
        "thread-id": signal.type,
        "interruption-level": "time-sensitive",
      },
      signalId: signal.id,
      signalType: signal.type,
      expiresAt: signal.expiresAt,
    });
    const session = this.getSession();
    return await new Promise<PushResult>((resolve, reject) => {
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(device.pushToken ?? "")}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.options.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.parse(signal.expiresAt) / 1000)),
        "apns-collapse-id": signal.id,
      });
      let status = 0;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        apnsId = typeof headers["apns-id"] === "string" ? headers["apns-id"] : null;
      });
      request.on("data", (chunk: string) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let reason: string | null = null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { reason?: string };
            reason = parsed.reason ?? "unknown_apns_error";
          } catch {
            reason = "invalid_apns_response";
          }
        }
        resolve({ accepted: status === 200, status, reason, apnsId });
      });
      request.on("error", reject);
      request.setTimeout(8_000, () =>
        request.destroy(new Error("APNs request timed out")),
      );
      request.end(payload);
    });
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session || session.closed || session.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.destroy();
        resolve();
      }, 2_000);
      timer.unref();
      session.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      session.close();
    });
  }

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed)
      return this.session;
    const host =
      this.options.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const session = connect(host);
    session.on("error", () => {
      if (this.session === session) this.session = null;
    });
    session.on("goaway", () => session.close());
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });
    this.session = session;
    return session;
  }

  private async authorizationToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedJwt && this.cachedJwt.expiresAt > now) return this.cachedJwt.value;
    this.signingKey ??= await importPKCS8(this.options.privateKey, "ES256");
    const issuedAt = Math.floor(now / 1000);
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.options.keyId })
      .setIssuer(this.options.teamId)
      .setIssuedAt(issuedAt)
      .sign(this.signingKey);
    this.cachedJwt = { value, expiresAt: now + 50 * 60_000 };
    return value;
  }
}

export class FakeApnsClient implements ApnsClient {
  readonly sent: Array<{ device: DeviceRecord; signal: SignalRecord }> = [];
  constructor(
    private readonly result: PushResult = {
      accepted: true,
      status: 200,
      reason: null,
      apnsId: "fake-apns-id",
    },
  ) {}
  send(device: DeviceRecord, signal: SignalRecord): Promise<PushResult> {
    this.sent.push(structuredClone({ device, signal }));
    return Promise.resolve(this.result);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function title(signal: SignalRecord): string {
  const interval = signal.type === "fifteen_minute_reversal" ? "15-minute" : "5-minute";
  return `${interval} Bitcoin signal`;
}

function body(signal: SignalRecord): string {
  const relation = signal.direction === "higher" ? "above" : "below";
  return `BTC is forecast to close ${relation} the interval open (${Math.round(signal.confidence * 100)}% calibrated confidence).`;
}
