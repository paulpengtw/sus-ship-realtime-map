// src/write-meter.ts — per-UTC-day rows_written accounting for the D1 free tier (spec 2026-09-05 §3).
// In-memory only: a DO restart resets the counter to 0 (accepted — see spec §3 "Write meter").
export interface WriteMeterStatus { day: string; usedToday: number; budget: number; optionalWritesPaused: boolean }

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class WriteMeter {
  private day = "";
  private used = 0;

  constructor(private readonly budget: number) {}

  private roll(now: number): void {
    const d = utcDay(now);
    if (d !== this.day) { this.day = d; this.used = 0; }
  }

  record(rowsWritten: number, now: number): void {
    this.roll(now);
    this.used += Math.max(0, rowsWritten);
  }

  usedToday(now: number): number {
    this.roll(now);
    return this.used;
  }

  optionalAllowed(now: number): boolean {
    return this.usedToday(now) < this.budget;
  }

  status(now: number): WriteMeterStatus {
    this.roll(now);
    return { day: this.day, usedToday: this.used, budget: this.budget, optionalWritesPaused: !this.optionalAllowed(now) };
  }

  /** Test hook (TrackerDO.resetForTests). */
  reset(): void {
    this.day = "";
    this.used = 0;
  }
}
