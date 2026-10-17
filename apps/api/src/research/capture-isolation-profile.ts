import { z } from "zod";

export const ISOLATED_CAPTURE_MODULES = [
  "capture-isolated-session",
  "capture-isolated-cli",
  "capture-isolation-profile",
  "capture-clock",
  "capture-cli",
  "capture-domain",
  "capture-writer",
] as const;
export const IsolatedCaptureSettingsSchema = z
  .object({
    outputParent: z.string().min(1),
    seconds: z.number().int().min(10).max(13_500),
    maxMiB: z.number().int().min(1).max(1_024),
  })
  .strict();
export const IsolatedCaptureCodeSchema = z
  .record(z.enum(ISOLATED_CAPTURE_MODULES), z.string().regex(/^[a-f0-9]{64}$/u))
  .refine((value) => Object.keys(value).length === ISOLATED_CAPTURE_MODULES.length);
