import type {
  CandleView,
  GuestPreferencesView,
  MarketView,
  SignalView,
} from "../../domain/models";
import {
  adaptCandle,
  adaptMarket,
  adaptSignal,
  adaptSignalList,
  unwrapData,
} from "./adapters";
import { minutesToClock } from "../../domain/time";
import {
  GUEST_CREDENTIAL_HEADER,
  GUEST_INSTALLATION_ID_HEADER,
} from "@flippars/contracts";
import type { GuestSession } from "../installation";

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  readonly method?: "GET" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly guestAuthenticated?: boolean;
}

export class ApiClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly guestSession?: GuestSession,
  ) {}

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (options.guestAuthenticated) {
      if (!this.guestSession)
        throw new Error("Guest mutation requires a secure session");
      headers[GUEST_INSTALLATION_ID_HEADER] = this.guestSession.installationId;
      headers[GUEST_CREDENTIAL_HEADER] = this.guestSession.credential;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        throw new ApiError(
          `Request failed (${response.status}).`,
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }
      if (response.status === 204) return null;
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  public async market(signal?: AbortSignal): Promise<MarketView> {
    return adaptMarket(
      await this.request("/v1/market/snapshot", signal ? { signal } : {}),
    );
  }

  public async currentCandles(signal?: AbortSignal): Promise<readonly CandleView[]> {
    const value = unwrapData(
      await this.request("/v1/candles/current", signal ? { signal } : {}),
    );
    const items =
      typeof value === "object" &&
      value !== null &&
      "items" in value &&
      Array.isArray(value.items)
        ? value.items
        : [];
    return items.map(adaptCandle).filter((item): item is CandleView => item !== null);
  }

  public async signals(
    cursor: string | null = null,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<{
    readonly signals: readonly SignalView[];
    readonly nextCursor: string | null;
    readonly sequence: number | null;
  }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return adaptSignalList(
      await this.request(`/v1/signals?${query.toString()}`, signal ? { signal } : {}),
    );
  }

  public async signal(
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<SignalView | null> {
    return adaptSignal(
      await this.request(
        `/v1/signals/${encodeURIComponent(id)}`,
        abortSignal ? { signal: abortSignal } : {},
      ),
    );
  }

  public async updatePreferences(
    preferences: GuestPreferencesView,
    notificationsEnabled: boolean,
  ): Promise<void> {
    const enabledSignalTypes = (
      Object.entries(preferences.enabledSignalKinds) as Array<
        [keyof GuestPreferencesView["enabledSignalKinds"], boolean]
      >
    )
      .filter(([, enabled]) => enabled)
      .map(
        ([kind]) =>
          ({
            five_minute_reversal: "FIVE_MINUTE_REVERSAL",
            fifteen_minute_reversal: "FIFTEEN_MINUTE_REVERSAL",
            five_minute_early_direction: "FIVE_MINUTE_EARLY_DIRECTION",
          })[kind],
      );
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    await this.request("/v1/preferences", {
      method: "PUT",
      guestAuthenticated: true,
      body: {
        installationId: this.requiredGuestSession().installationId,
        enabledSignalTypes: enabledSignalTypes.length
          ? enabledSignalTypes
          : ["FIVE_MINUTE_REVERSAL"],
        notificationsEnabled: notificationsEnabled && enabledSignalTypes.length > 0,
        minimumConfidence: 0.75,
        quietHours: {
          enabled: preferences.quietHours.enabled,
          start: minutesToClock(preferences.quietHours.startMinutes),
          end: minutesToClock(preferences.quietHours.endMinutes),
          timeZone: resolved.timeZone ?? "UTC",
        },
        showDemoData: false,
        locale: resolved.locale ?? "en",
      },
    });
  }

  public async registerDevice(
    pushToken: string | null,
    appVersion: string,
  ): Promise<void> {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const installationId = this.requiredGuestSession().installationId;
    await this.request(`/v1/devices/${encodeURIComponent(installationId)}`, {
      method: "PUT",
      guestAuthenticated: true,
      body: {
        platform: "IOS",
        appVersion,
        locale: resolved.locale ?? "en",
        timeZone: resolved.timeZone ?? "UTC",
        pushToken,
        notificationsAuthorized: pushToken !== null,
        pushEnvironment: __DEV__ ? "sandbox" : "production",
      },
    });
  }

  public async deleteDevice(): Promise<void> {
    const installationId = this.requiredGuestSession().installationId;
    await this.request(`/v1/devices/${encodeURIComponent(installationId)}`, {
      method: "DELETE",
      guestAuthenticated: true,
    });
  }

  private requiredGuestSession(): GuestSession {
    if (!this.guestSession) throw new Error("Guest mutation requires a secure session");
    return this.guestSession;
  }

  public async ready(): Promise<boolean> {
    try {
      const value = unwrapData(await this.request("/health/ready"));
      return value !== null;
    } catch {
      return false;
    }
  }
}
