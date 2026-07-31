export interface SafetySnapshot {
  signalEmissionConfigured: boolean;
  killed: boolean;
  degraded: boolean;
  reason: string | null;
  changedAt: string;
}

export class SafetyController {
  private killed = false;
  private degraded = false;
  private reason: string | null = null;
  private changedAt = new Date().toISOString();

  constructor(private readonly emissionConfigured: boolean) {}

  canEmit(): boolean {
    return this.emissionConfigured && !this.killed && !this.degraded;
  }

  setDegraded(reason: string): void {
    this.degraded = true;
    this.reason = reason;
    this.changedAt = new Date().toISOString();
  }

  clearDegraded(): void {
    if (this.killed) return;
    this.degraded = false;
    this.reason = null;
    this.changedAt = new Date().toISOString();
  }

  engageKillSwitch(reason: string): void {
    this.killed = true;
    this.degraded = true;
    this.reason = reason;
    this.changedAt = new Date().toISOString();
  }

  snapshot(): SafetySnapshot {
    return {
      signalEmissionConfigured: this.emissionConfigured,
      killed: this.killed,
      degraded: this.degraded,
      reason: this.reason,
      changedAt: this.changedAt,
    };
  }
}
