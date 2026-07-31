import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_SSL: booleanString,
    CORS_ORIGINS: z.string().default(""),
    TRUST_PROXY: booleanString,
    API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    MARKET_FEEDS: z.string().default("coinbase,kraken,binance"),
    MARKET_STALE_AFTER_MS: z.coerce.number().int().min(1_000).default(5_000),
    MARKET_MIN_HEALTHY_VENUES: z.coerce.number().int().min(1).max(3).default(3),
    MARKET_MAX_USDT_DEVIATION_BPS: z.coerce.number().min(1).max(1_000).default(50),
    MARKET_OBSERVATION_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    REQUIRE_MARKET_FOR_READINESS: booleanString,
    SIGNALS_ENABLED: booleanString,
    SIGNAL_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(0.999).default(0.75),
    SIGNAL_MIN_LEAD_TIME_MS: z.coerce.number().int().min(1_000).default(5_000),
    SIGNAL_NEUTRAL_BAND_BPS: z.coerce.number().min(0).max(100).default(1),
    SIMULATED_FEED_ENABLED: booleanString,
    APNS_ENABLED: booleanString,
    APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    APNS_TEAM_ID: z.string().optional(),
    APNS_KEY_ID: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    APNS_PRIVATE_KEY: z.string().optional(),
    DEVICE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "required in production",
      });
    }
    if (value.NODE_ENV === "production" && value.SIMULATED_FEED_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIMULATED_FEED_ENABLED"],
        message: "must be false in production",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      value.MARKET_FEEDS.split(",").includes("simulated")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_FEEDS"],
        message: "simulated market feed is forbidden in production",
      });
    }
    if (value.APNS_ENABLED) {
      for (const key of [
        "APNS_TEAM_ID",
        "APNS_KEY_ID",
        "APNS_BUNDLE_ID",
        "APNS_PRIVATE_KEY",
      ] as const) {
        if (!value[key])
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "required when APNS_ENABLED=true",
          });
      }
      if (
        !value.DEVICE_TOKEN_ENCRYPTION_KEY ||
        value.DEVICE_TOKEN_ENCRYPTION_KEY.length < 32
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DEVICE_TOKEN_ENCRYPTION_KEY"],
          message: "at least 32 characters are required when APNS_ENABLED=true",
        });
      }
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API environment: ${summary}`);
  }

  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    databaseSsl: value.DATABASE_SSL,
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustProxy: value.TRUST_PROXY,
    rateLimit: {
      max: value.API_RATE_LIMIT_MAX,
      windowMs: value.API_RATE_LIMIT_WINDOW_MS,
    },
    market: {
      feeds: value.MARKET_FEEDS.split(",")
        .map((feed) => feed.trim())
        .filter(Boolean),
      staleAfterMs: value.MARKET_STALE_AFTER_MS,
      minimumHealthyVenues: value.MARKET_MIN_HEALTHY_VENUES,
      maximumUsdtDeviationBps: value.MARKET_MAX_USDT_DEVIATION_BPS,
      retentionDays: value.MARKET_OBSERVATION_RETENTION_DAYS,
      requireForReadiness: value.REQUIRE_MARKET_FOR_READINESS,
      simulatedEnabled: value.SIMULATED_FEED_ENABLED,
    },
    signals: {
      enabled: value.SIGNALS_ENABLED,
      confidenceThreshold: value.SIGNAL_CONFIDENCE_THRESHOLD,
      minimumLeadTimeMs: value.SIGNAL_MIN_LEAD_TIME_MS,
      neutralBandBps: value.SIGNAL_NEUTRAL_BAND_BPS,
    },
    apns: {
      enabled: value.APNS_ENABLED,
      environment: value.APNS_ENVIRONMENT,
      teamId: value.APNS_TEAM_ID,
      keyId: value.APNS_KEY_ID,
      bundleId: value.APNS_BUNDLE_ID,
      privateKey: value.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    deviceTokenEncryptionKey: value.DEVICE_TOKEN_ENCRYPTION_KEY,
  } as const;
}
