import { z } from "zod";

/** Separate revision: the original collector and its historical hashes stay intact. */
export const LONG_CAPTURE_MODULES = [
  "capture-session",
  "capture-long-cli",
  "capture-clock",
  "capture-revisions",
  "capture-cli",
  "capture-domain",
  "capture-writer",
] as const;

export const LongCaptureSettingsSchema = z
  .object({
    outputParent: z.string().min(1),
    seconds: z.number().int().min(10).max(13_500),
    maxMiB: z.number().int().min(1).max(1_024),
  })
  .strict();

export const LongCaptureCodeSchema = z
  .record(z.enum(LONG_CAPTURE_MODULES), z.string().regex(/^[a-f0-9]{64}$/u))
  .refine((value) => Object.keys(value).length === LONG_CAPTURE_MODULES.length);
