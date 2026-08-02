import { z } from "zod";

import { Rfc3339TimestampSchema } from "./primitives.js";
import { SignalTypeSchema } from "./signal.js";

export const GUEST_INSTALLATION_ID_HEADER = "X-Flippars-Installation-ID";
export const GUEST_CREDENTIAL_HEADER = "X-Flippars-Guest-Credential";

export const GuestInstallationIdSchema = z.string().uuid();
export const GuestCredentialSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a 256-bit hexadecimal guest credential");

export const GuestDeviceSchema = z
  .object({
    installationId: GuestInstallationIdSchema,
    platform: z.literal("IOS"),
    appVersion: z.string().min(1).max(40),
    locale: z.string().min(2).max(35),
    timeZone: z.string().min(1).max(100),
    pushToken: z.string().min(16).max(512).nullable(),
    notificationsAuthorized: z.boolean(),
    createdAt: Rfc3339TimestampSchema,
    lastSeenAt: Rfc3339TimestampSchema,
  })
  .strict();
export type GuestDevice = z.infer<typeof GuestDeviceSchema>;

const LocalTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");

export const QuietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: LocalTimeSchema,
    end: LocalTimeSchema,
    timeZone: z.string().min(1).max(100),
  })
  .strict();
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const GuestPreferencesSchema = z
  .object({
    installationId: GuestInstallationIdSchema,
    enabledSignalTypes: z.array(SignalTypeSchema).min(1),
    notificationsEnabled: z.boolean(),
    minimumConfidence: z.number().min(0.5).max(1),
    quietHours: QuietHoursSchema,
    showDemoData: z.boolean(),
    locale: z.string().min(2).max(35),
    updatedAt: Rfc3339TimestampSchema,
  })
  .strict();
export type GuestPreferences = z.infer<typeof GuestPreferencesSchema>;
