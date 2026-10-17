/** Relative wall/monotonic consistency only, never absolute clock accuracy. */
export class CaptureClockContinuity {
  private readonly start: number;
  private previousWall: number;
  private previousMonotonic = 0n;

  constructor(startedAt: string) {
    this.start = Date.parse(startedAt);
    if (
      !Number.isFinite(this.start) ||
      new Date(this.start).toISOString() !== startedAt
    )
      throw new Error("Invalid capture start timestamp");
    this.previousWall = this.start;
  }

  accept(receivedAt: string, elapsedNanoseconds: string): void {
    const wall = Date.parse(receivedAt);
    if (
      !/^(?:0|[1-9]\d{0,19})$/u.test(elapsedNanoseconds) ||
      !Number.isFinite(wall) ||
      new Date(wall).toISOString() !== receivedAt
    )
      throw new Error("CLOCK_DISCONTINUITY");
    const monotonic = BigInt(elapsedNanoseconds);
    if (
      wall < this.previousWall ||
      monotonic < this.previousMonotonic ||
      Math.abs(wall - this.start - Number(monotonic) / 1_000_000) > 1_000
    )
      throw new Error("CLOCK_DISCONTINUITY");
    this.previousWall = wall;
    this.previousMonotonic = monotonic;
  }
}
