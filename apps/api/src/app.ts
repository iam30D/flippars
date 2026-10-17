import { createHash, randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyPluginCallback,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  GUEST_CREDENTIAL_HEADER,
  GUEST_INSTALLATION_ID_HEADER,
  GuestCredentialSchema,
  GuestInstallationIdSchema,
  type DataMode,
  type SignalType as WireSignalType,
} from "@flippars/contracts";
import type { AppConfig } from "./config.js";
import { ApiError, errorHandler } from "./errors.js";
import type { MarketCoordinator } from "./market/coordinator.js";
import type { MetricsRegistry } from "./metrics.js";
import type { NotificationDispatcher } from "./notifications/dispatcher.js";
import type { Repository, SignalCursor } from "./repositories/repository.js";
import type { OutcomeEvaluator } from "./signals/outcomes.js";
import type { SafetyController } from "./signals/safety.js";
import type { SignalWorker } from "./signals/worker.js";
import {
  presentCandle,
  presentCurrentCandle,
  presentDevice,
  presentMarketSnapshot,
  presentPreferences,
  presentSignal,
  toInternalSignalType,
} from "./transport/presenters.js";
import {
  candleQuerySchema,
  deviceBodySchema,
  errorResponseSchema,
  installationParamsSchema,
  preferencesBodySchema,
  signalQuerySchema,
} from "./transport/schemas.js";
import { StreamHub } from "./transport/stream.js";

export interface ApiDependencies {
  config: AppConfig;
  repository: Repository;
  market: MarketCoordinator;
  metrics: MetricsRegistry;
  safety: SafetyController;
  signalWorker?: SignalWorker;
  outcomeEvaluator?: OutcomeEvaluator;
  notificationDispatcher?: NotificationDispatcher;
  startBackground?: boolean;
  logger?: FastifyServerOptions["logger"];
}

type SwaggerUiPlugin = FastifyPluginCallback<{
  routePrefix: string;
  uiConfig: { docExpansion: "list"; deepLinking: boolean };
}>;

interface DeviceBody {
  platform: "IOS";
  appVersion: string;
  locale: string;
  timeZone: string;
  pushToken: string | null;
  notificationsAuthorized: boolean;
  pushEnvironment: "sandbox" | "production";
}

interface PreferencesBody {
  installationId: string;
  enabledSignalTypes: WireSignalType[];
  notificationsEnabled: boolean;
  minimumConfidence: number;
  quietHours: { enabled: boolean; start: string; end: string; timeZone: string };
  showDemoData: boolean;
  locale: string;
}

interface SignalQuery {
  type?: WireSignalType;
  cursor?: string;
  limit?: number;
}

interface CandleQuery {
  interval: "1m" | "5m" | "15m";
  from?: string;
  to?: string;
  limit?: number;
}

export async function buildApi(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const { config, repository, market, metrics, safety } = dependencies;
  const dataMode: DataMode =
    config.nodeEnv === "production"
      ? "LIVE"
      : config.market.feeds.includes("simulated")
        ? "SIMULATION"
        : "LIVE";
  const app = Fastify({
    logger: dependencies.logger ?? {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-flippars-installation-id",
          "req.headers.x-flippars-guest-credential",
          "req.body.installationId",
          "req.body.pushToken",
          "body.installationId",
          "body.pushToken",
          "*.installationId",
          "*.pushToken",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: true,
        useDefaults: true,
      },
    },
    genReqId(request) {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: config.nodeEnv === "production",
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (
        !origin ||
        config.corsOrigins.includes(origin) ||
        (config.nodeEnv !== "production" && config.corsOrigins.length === 0)
      ) {
        callback(null, true);
      } else {
        callback(new ApiError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed"), false);
      }
    },
    methods: ["GET", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    allowList: (request) =>
      request.url === "/health/live" ||
      request.url === "/health/ready" ||
      request.url === "/metrics",
    errorResponseBuilder(request, context) {
      return {
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests; retry in ${context.after}`,
          requestId: request.id,
        },
      };
    },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Flippars API",
        version: "0.1.0",
        description: "Informational Bitcoin signals. This API never executes trades.",
      },
      tags: [
        { name: "health", description: "Service health and observability" },
        { name: "market", description: "Composite BTC/USD market data" },
        {
          name: "signals",
          description: "Immutable informational signals and outcomes",
        },
        { name: "guest", description: "Anonymous installation preferences" },
      ],
    },
  });
  const swaggerUiPlugin = swaggerUi as unknown as SwaggerUiPlugin;
  await app.register(swaggerUiPlugin, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });
  await app.register(websocket, {
    options: { maxPayload: 8 * 1024, clientTracking: false },
  });

  app.setErrorHandler(errorHandler);
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    metrics.increment("flippars_http_requests_total", {
      method: request.method,
      status: String(reply.statusCode),
    });
  });

  const streamHub = new StreamHub(
    market,
    safety,
    dataMode,
    config.signals.confidenceThreshold,
    config.signals.neutralBandBps,
  );

  app.get(
    "/health/live",
    {
      schema: { tags: ["health"], summary: "Liveness probe" },
      config: { rateLimit: false },
    },
    () => ({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: { tags: ["health"], summary: "Readiness probe" },
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      const database = await repository.ping();
      const marketHealth = market.health();
      const safetyState = safety.snapshot();
      const ready =
        database &&
        (!config.market.requireForReadiness || marketHealth.healthy) &&
        !safetyState.killed;
      return reply.status(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        checks: { database, market: marketHealth, safety: safetyState },
        checkedAt: new Date().toISOString(),
      });
    },
  );

  app.get(
    "/metrics",
    {
      schema: { tags: ["health"], summary: "Prometheus metrics", hide: true },
      config: { rateLimit: false },
    },
    async (_request, reply) =>
      reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render()),
  );

  app.get(
    "/v1/market/snapshot",
    {
      schema: {
        tags: ["market"],
        summary: "Latest composite BTC/USD snapshot",
        response: { 503: errorResponseSchema },
      },
    },
    async () => {
      const snapshot = market.snapshot() ?? (await repository.latestMarketSnapshot());
      if (!snapshot)
        throw new ApiError(
          503,
          "MARKET_UNAVAILABLE",
          "No market snapshot is currently available",
        );
      return presentMarketSnapshot(snapshot, dataMode);
    },
  );

  app.get<{ Querystring: CandleQuery }>(
    "/v1/candles",
    {
      schema: {
        tags: ["market"],
        summary: "Historical composite candles",
        querystring: candleQuerySchema,
        response: { 400: errorResponseSchema },
      },
    },
    async (request) => {
      const to = request.query.to ? new Date(request.query.to) : new Date();
      const from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 6 * 3_600_000);
      if (
        !Number.isFinite(from.getTime()) ||
        !Number.isFinite(to.getTime()) ||
        from >= to
      ) {
        throw new ApiError(400, "INVALID_TIME_RANGE", "from must be earlier than to");
      }
      if (to.getTime() - from.getTime() > 31 * 86_400_000) {
        throw new ApiError(
          400,
          "TIME_RANGE_TOO_LARGE",
          "Candle requests are limited to 31 days",
        );
      }
      const items = await repository.candles({
        interval: request.query.interval,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: request.query.limit ?? 200,
      });
      return {
        items: items.map(presentCandle),
        interval: request.query.interval,
        from: from.toISOString(),
        to: to.toISOString(),
      };
    },
  );

  app.get(
    "/v1/candles/current",
    {
      schema: {
        tags: ["market"],
        summary: "Current UTC-aligned 5m and 15m candle states",
      },
    },
    async () => {
      const now = new Date();
      const intervals = ["5m", "15m"] as const;
      const items = [];
      for (const interval of intervals) {
        const duration = interval === "5m" ? 300_000 : 900_000;
        const start = new Date(Math.floor(now.getTime() / duration) * duration);
        const candles = await repository.candles({
          interval,
          from: start.toISOString(),
          to: new Date(now.getTime() + 1).toISOString(),
          limit: 1,
        });
        const candle = candles[0];
        if (candle)
          items.push(
            presentCurrentCandle(candle, now, dataMode, config.signals.neutralBandBps),
          );
      }
      return { items };
    },
  );

  app.get<{ Querystring: SignalQuery }>(
    "/v1/signals",
    {
      schema: {
        tags: ["signals"],
        summary: "Signal and outcome history",
        querystring: signalQuerySchema,
        response: { 400: errorResponseSchema },
      },
    },
    async (request) => {
      const cursor = request.query.cursor
        ? decodeCursor(request.query.cursor)
        : undefined;
      const type = request.query.type
        ? toInternalSignalType(request.query.type)
        : undefined;
      const page = await repository.listSignals({
        limit: request.query.limit ?? 25,
        ...(cursor ? { cursor } : {}),
        ...(type ? { type } : {}),
      });
      const items = page.items.map((signal) =>
        presentSignal(signal, {
          confidenceThreshold: config.signals.confidenceThreshold,
          deadbandBps: config.signals.neutralBandBps,
          dataMode,
        }),
      );
      return {
        items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        hasMore: page.nextCursor !== null,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/signals/:id",
    {
      schema: {
        tags: ["signals"],
        summary: "Signal detail with outcome",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_:-]+$",
            },
          },
        },
        response: { 404: errorResponseSchema },
      },
    },
    async (request) => {
      const signal = await repository.getSignal(request.params.id);
      if (!signal) throw new ApiError(404, "SIGNAL_NOT_FOUND", "Signal was not found");
      return presentSignal(signal, {
        confidenceThreshold: config.signals.confidenceThreshold,
        deadbandBps: config.signals.neutralBandBps,
        dataMode,
      });
    },
  );

  app.put<{ Params: { id: string }; Body: DeviceBody }>(
    "/v1/devices/:id",
    {
      schema: {
        tags: ["guest"],
        summary: "Register or refresh an anonymous iOS installation",
        params: installationParamsSchema,
        body: deviceBodySchema,
        response: { 401: errorResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request) => {
      const credentialHash = guestCredentialHash(request, request.params.id);
      assertTimeZone(request.body.timeZone);
      assertLocale(request.body.locale);
      if (!request.body.notificationsAuthorized && request.body.pushToken !== null) {
        throw new ApiError(
          400,
          "INVALID_PUSH_STATE",
          "pushToken must be null when notifications are not authorized",
        );
      }
      const device = await repository.upsertDevice({
        id: request.params.id,
        credentialHash,
        platform: "ios",
        pushToken: request.body.pushToken,
        pushEnvironment: request.body.pushEnvironment,
        notificationsAuthorized: request.body.notificationsAuthorized,
        appVersion: request.body.appVersion,
        locale: request.body.locale,
        timezone: request.body.timeZone,
      });
      if (!device)
        throw new ApiError(
          403,
          "GUEST_CREDENTIAL_INVALID",
          "The guest installation credential is invalid",
        );
      await audit(
        repository,
        "guest_device.upserted",
        "guest_device",
        device.id,
        request.id,
        { hasPushToken: Boolean(device.pushToken) },
      );
      return presentDevice(device);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/devices/:id",
    {
      schema: {
        tags: ["guest"],
        summary: "Delete an anonymous installation and associated personal data",
        params: installationParamsSchema,
        response: { 401: errorResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const credentialHash = guestCredentialHash(request, request.params.id);
      const deletion = await repository.deleteDevice(request.params.id, credentialHash);
      if (deletion === "credential_mismatch")
        throw new ApiError(
          403,
          "GUEST_CREDENTIAL_INVALID",
          "The guest installation credential is invalid",
        );
      await audit(
        repository,
        "guest_device.deleted",
        "guest_device",
        request.params.id,
        request.id,
        {},
      );
      return reply.status(204).send();
    },
  );

  app.put<{ Body: PreferencesBody }>(
    "/v1/preferences",
    {
      schema: {
        tags: ["guest"],
        summary: "Replace guest notification preferences",
        body: preferencesBodySchema,
        response: { 401: errorResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request) => {
      const credentialHash = guestCredentialHash(request, request.body.installationId);
      assertTimeZone(request.body.quietHours.timeZone);
      assertLocale(request.body.locale);
      if (
        !(await repository.verifyDeviceCredential(
          request.body.installationId,
          credentialHash,
        ))
      ) {
        throw new ApiError(
          403,
          "GUEST_CREDENTIAL_INVALID",
          "Register the guest installation with the matching credential before saving preferences",
        );
      }
      const preferences = await repository.putPreferences({
        deviceId: request.body.installationId,
        signalTypes: request.body.enabledSignalTypes.map(toInternalSignalType),
        notificationsEnabled: request.body.notificationsEnabled,
        minimumConfidence: request.body.minimumConfidence,
        quietHours: {
          enabled: request.body.quietHours.enabled,
          start: request.body.quietHours.start,
          end: request.body.quietHours.end,
          timezone: request.body.quietHours.timeZone,
        },
        showDemoData: request.body.showDemoData,
        locale: request.body.locale,
      });
      await audit(
        repository,
        "guest_preferences.updated",
        "guest_device",
        request.body.installationId,
        request.id,
        {
          notificationsEnabled: preferences.notificationsEnabled,
          signalTypes: preferences.signalTypes,
        },
      );
      return presentPreferences(preferences);
    },
  );

  app.get(
    "/v1/stream",
    {
      websocket: true,
      schema: {
        tags: ["market", "signals"],
        summary: "Sequenced real-time market and signal stream",
      },
    },
    (socket) => {
      streamHub.add(socket);
    },
  );

  if (dependencies.startBackground !== false) {
    app.addHook("onReady", () => {
      streamHub.start();
      market.start();
      dependencies.signalWorker?.start();
      dependencies.outcomeEvaluator?.start();
      dependencies.notificationDispatcher?.start();
    });
  } else {
    streamHub.start();
  }

  app.addHook("onClose", async () => {
    dependencies.outcomeEvaluator?.stop();
    await dependencies.signalWorker?.stop();
    await dependencies.notificationDispatcher?.stop();
    await streamHub.stop();
    await market.stop();
    await repository.close();
  });

  return app;
}

function encodeCursor(cursor: SignalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SignalCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed["issuedAt"] !== "string" ||
      !Number.isFinite(Date.parse(parsed["issuedAt"])) ||
      typeof parsed["id"] !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return { issuedAt: parsed["issuedAt"], id: parsed["id"] };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }
}

async function audit(
  repository: Repository,
  action: string,
  subjectType: string,
  subjectId: string,
  requestId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await repository.audit({
    id: randomUUID(),
    action,
    subjectType,
    subjectId:
      subjectType === "guest_device" ? pseudonymousAuditId(subjectId) : subjectId,
    requestId,
    metadata,
    occurredAt: now.toISOString(),
    retainUntil: new Date(now.getTime() + 2 * 365 * 86_400_000).toISOString(),
  });
}

function pseudonymousAuditId(value: string): string {
  return `installation_hash:${createHash("sha256").update(value).digest("hex")}`;
}

function guestCredentialHash(
  request: FastifyRequest,
  expectedInstallationId: string,
): string {
  const rawInstallationId = request.headers[GUEST_INSTALLATION_ID_HEADER.toLowerCase()];
  const rawCredential = request.headers[GUEST_CREDENTIAL_HEADER.toLowerCase()];
  if (typeof rawInstallationId !== "string" || typeof rawCredential !== "string")
    throw new ApiError(
      401,
      "GUEST_CREDENTIAL_REQUIRED",
      "Guest mutation credentials are required",
    );
  const installationId = GuestInstallationIdSchema.safeParse(rawInstallationId);
  const credential = GuestCredentialSchema.safeParse(rawCredential);
  if (
    !installationId.success ||
    installationId.data !== expectedInstallationId ||
    !credential.success
  )
    throw new ApiError(
      403,
      "GUEST_CREDENTIAL_INVALID",
      "The guest installation credential is invalid",
    );
  return createHash("sha256").update(credential.data, "utf8").digest("hex");
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new ApiError(400, "INVALID_TIME_ZONE", "A valid IANA time zone is required");
  }
}

function assertLocale(value: string): void {
  try {
    Intl.getCanonicalLocales(value);
  } catch {
    throw new ApiError(400, "INVALID_LOCALE", "A valid locale is required");
  }
}
