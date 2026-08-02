import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalNonBlankString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().trim().min(1).optional(),
);

const marketFeedsString = z
  .string()
  .default("coinbase,kraken,binance")
  .superRefine((value, context) => {
    const feeds = value
      .split(",")
      .map((feed) => feed.trim())
      .filter(Boolean);
    if (feeds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one feed is required",
      });
      return;
    }
    const supported = new Set(["coinbase", "kraken", "binance", "simulated"]);
    const unsupported = feeds.filter((feed) => !supported.has(feed));
    if (unsupported.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unsupported feed(s): ${unsupported.join(", ")}`,
      });
    }
    if (new Set(feeds).size !== feeds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate feeds are forbidden",
      });
    }
  });

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
    DATABASE_CA_CERT: optionalNonBlankString,
    CORS_ORIGINS: z.string().default(""),
    TRUST_PROXY: booleanString,
    API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    MARKET_FEEDS: marketFeedsString,
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
    MODEL_PROVIDER: z.literal("disabled").default("disabled"),
    SIGNAL_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(0.999).default(0.75),
    SIGNAL_MIN_LEAD_TIME_MS: z.coerce.number().int().min(1_000).default(5_000),
    SIGNAL_NEUTRAL_BAND_BPS: z.coerce.number().min(0).max(100).default(1),
    SIMULATED_FEED_ENABLED: booleanString,
    APNS_ENABLED: booleanString,
    APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    APNS_TEAM_ID: optionalNonBlankString,
    APNS_KEY_ID: optionalNonBlankString,
    APNS_BUNDLE_ID: optionalNonBlankString,
    APNS_PRIVATE_KEY: optionalNonBlankString,
    DEVICE_TOKEN_ENCRYPTION_KEY: optionalNonBlankString,
  })
  .superRefine((value, context) => {
    const marketFeeds = value.MARKET_FEEDS.split(",")
      .map((feed) => feed.trim())
      .filter(Boolean);
    const usesSimulatedFeed = marketFeeds.includes("simulated");

    if (value.NODE_ENV === "production" && !value.DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "required in production",
      });
    }
    if (value.NODE_ENV === "production" && value.DATABASE_URL) {
      let databaseUrl: URL | null = null;
      try {
        databaseUrl = new URL(value.DATABASE_URL);
      } catch {
        // The issue below intentionally avoids echoing the secret value.
      }
      if (
        !databaseUrl ||
        !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
        [databaseUrl.username, databaseUrl.password, databaseUrl.hostname].some(
          (part) => /^(?:USER|PASSWORD|DATABASE_HOST|REPLACE(?:_ME)?)$/iu.test(part),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL"],
          message: "must be a real PostgreSQL connection URL, not a template value",
        });
      }
    }
    if (
      value.NODE_ENV === "production" &&
      (!value.DEVICE_TOKEN_ENCRYPTION_KEY ||
        value.DEVICE_TOKEN_ENCRYPTION_KEY.length < 32 ||
        /^REPLACE(?:_|$)/iu.test(value.DEVICE_TOKEN_ENCRYPTION_KEY))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEVICE_TOKEN_ENCRYPTION_KEY"],
        message: "at least 32 characters are required in production",
      });
    }
    if (value.NODE_ENV === "production" && value.SIMULATED_FEED_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIMULATED_FEED_ENABLED"],
        message: "must be false in production",
      });
    }
    if (value.NODE_ENV === "production" && usesSimulatedFeed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_FEEDS"],
        message: "simulated market feed is forbidden in production",
      });
    }
    if (usesSimulatedFeed && !value.SIMULATED_FEED_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIMULATED_FEED_ENABLED"],
        message: "must be true when MARKET_FEEDS includes simulated",
      });
    }
    if (value.SIMULATED_FEED_ENABLED && !usesSimulatedFeed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIMULATED_FEED_ENABLED"],
        message: "must be false unless MARKET_FEEDS is simulated",
      });
    }
    if (usesSimulatedFeed && marketFeeds.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_FEEDS"],
        message: "simulated cannot be mixed with live feeds",
      });
    }
    if (value.MARKET_MIN_HEALTHY_VENUES > marketFeeds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MARKET_MIN_HEALTHY_VENUES"],
        message: "cannot exceed the number of configured market feeds",
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
      if (value.NODE_ENV === "production" && value.APNS_ENVIRONMENT !== "production") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["APNS_ENVIRONMENT"],
          message: "must be production when APNS is enabled in production",
        });
      }
    }
    if (value.SIGNALS_ENABLED && value.MODEL_PROVIDER === "disabled") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SIGNALS_ENABLED"],
        message:
          "must remain false because no validated production model provider is bundled",
      });
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
    databaseCaCert: value.DATABASE_CA_CERT?.replace(/\\n/g, "\n"),
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
      provider: value.MODEL_PROVIDER,
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
