export const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
        details: {},
      },
    },
  },
} as const;

export const installationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export const deviceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "platform",
    "appVersion",
    "locale",
    "timeZone",
    "pushToken",
    "notificationsAuthorized",
    "pushEnvironment",
  ],
  properties: {
    platform: { const: "IOS" },
    appVersion: { type: "string", minLength: 1, maxLength: 40 },
    locale: { type: "string", minLength: 2, maxLength: 35 },
    timeZone: { type: "string", minLength: 1, maxLength: 100 },
    pushToken: {
      anyOf: [{ type: "string", pattern: "^[A-Fa-f0-9]{32,512}$" }, { type: "null" }],
    },
    notificationsAuthorized: { type: "boolean" },
    pushEnvironment: { enum: ["sandbox", "production"] },
  },
} as const;

export const preferencesBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "installationId",
    "enabledSignalTypes",
    "notificationsEnabled",
    "minimumConfidence",
    "quietHours",
    "showDemoData",
    "locale",
  ],
  properties: {
    installationId: { type: "string", format: "uuid" },
    enabledSignalTypes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        enum: [
          "FIVE_MINUTE_REVERSAL",
          "FIFTEEN_MINUTE_REVERSAL",
          "FIVE_MINUTE_EARLY_DIRECTION",
        ],
      },
    },
    notificationsEnabled: { type: "boolean" },
    minimumConfidence: { type: "number", minimum: 0.5, maximum: 1 },
    quietHours: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "start", "end", "timeZone"],
      properties: {
        enabled: { type: "boolean" },
        start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    showDemoData: { type: "boolean" },
    locale: { type: "string", minLength: 2, maxLength: 35 },
  },
} as const;

export const signalQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      enum: [
        "FIVE_MINUTE_REVERSAL",
        "FIFTEEN_MINUTE_REVERSAL",
        "FIVE_MINUTE_EARLY_DIRECTION",
      ],
    },
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  },
} as const;

export const candleQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["interval"],
  properties: {
    interval: { enum: ["1m", "5m", "15m"] },
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
  },
} as const;
