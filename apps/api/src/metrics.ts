export class MetricsRegistry {
  readonly startedAt = Date.now();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  render(): string {
    const lines = [
      "# HELP flippars_uptime_seconds Process uptime in seconds.",
      "# TYPE flippars_uptime_seconds gauge",
      `flippars_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
    ];
    const declared = new Set(["flippars_uptime_seconds"]);
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const name = baseName(key);
      if (!declared.has(name)) {
        lines.push(`# TYPE ${name} counter`);
        declared.add(name);
      }
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of [...this.gauges.entries()].sort()) {
      const name = baseName(key);
      if (!declared.has(name)) {
        lines.push(`# TYPE ${name} gauge`);
        declared.add(name);
      }
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const normalized = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (normalized.length === 0) return name;
  return `${name}{${normalized.map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, "_")}"`).join(",")}}`;
}

function baseName(key: string): string {
  return key.split("{")[0] ?? key;
}
