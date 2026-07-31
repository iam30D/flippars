import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorHandler(
  error: FastifyError | ApiError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const validation = "validation" in error ? error.validation : undefined;
  const statusCode =
    error instanceof ApiError
      ? error.statusCode
      : validation
        ? 400
        : (error.statusCode ?? 500);
  const code =
    error instanceof ApiError
      ? error.code
      : validation
        ? "VALIDATION_ERROR"
        : statusCode >= 500
          ? "INTERNAL_ERROR"
          : "REQUEST_ERROR";
  const message = statusCode >= 500 ? "An unexpected error occurred" : error.message;
  const details = error instanceof ApiError ? error.details : validation;

  if (statusCode >= 500) request.log.error({ err: error }, "request failed");
  else request.log.info({ err: error }, "request rejected");

  void reply.status(statusCode).send({
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    },
  });
}
