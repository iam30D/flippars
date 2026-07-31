import type { SignalRecord } from "../domain.js";
import type { MarketCoordinator } from "../market/coordinator.js";
import type { MetricsRegistry } from "../metrics.js";
import type { Repository } from "../repositories/repository.js";
import type { ApnsClient } from "./apns.js";

export class NotificationDispatcher {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly market: MarketCoordinator,
    private readonly repository: Repository,
    private readonly apns: ApnsClient,
    private readonly metrics: MetricsRegistry,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.market.onSignal((signal) => {
      void this.dispatch(signal).catch(() =>
        this.metrics.increment("flippars_notification_dispatch_errors_total"),
      );
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.apns.close();
  }

  private async dispatch(signal: SignalRecord): Promise<void> {
    if (Date.parse(signal.expiresAt) <= Date.now()) return;
    const targets = await this.repository.notificationTargets(signal);
    for (let offset = 0; offset < targets.length; offset += 20) {
      const batch = targets.slice(offset, offset + 20);
      await Promise.allSettled(
        batch.map(async ({ device, preferences }) => {
          if (
            preferences.quietHours.enabled &&
            isQuietTime(preferences.quietHours, new Date())
          )
            return;
          if (
            !(await this.repository.claimNotification(
              device.id,
              signal.id,
              signal.expiresAt,
            ))
          ) {
            this.metrics.increment("flippars_notifications_deduplicated_total");
            return;
          }
          try {
            const result = await this.apns.send(device, signal);
            await this.repository.recordNotificationResult(
              device.id,
              signal.id,
              result.accepted ? "accepted" : (result.reason ?? `http_${result.status}`),
              result.apnsId,
            );
            this.metrics.increment("flippars_notifications_total", {
              result: result.accepted ? "accepted" : "rejected",
            });
          } catch {
            await this.repository.recordNotificationResult(
              device.id,
              signal.id,
              "transport_error",
              null,
            );
            this.metrics.increment("flippars_notifications_total", {
              result: "transport_error",
            });
          }
        }),
      );
    }
  }
}

function isQuietTime(
  quiet: { start: string; end: string; timezone: string },
  now: Date,
): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: quiet.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    const current = hour * 60 + minute;
    const start = minutes(quiet.start);
    const end = minutes(quiet.end);
    return start <= end
      ? current >= start && current < end
      : current >= start || current < end;
  } catch {
    return true;
  }
}

function minutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}
