import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorDetails } from '../errors/AppError.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
    request_id: string;
  };
}

// Single error envelope used by every endpoint in the project:
// { "error": { "code", "message", "details"|null, "request_id" } }
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details: ErrorDetails = null;

  if (err instanceof AppError) {
    status = err.httpStatus;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = { issues: err.issues };
  } else if (isBodyParseError(err)) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Malformed JSON body';
  } else if (err instanceof Error) {
    req.log?.error({ err, request_id: requestId }, 'Unhandled error');
  }

  const body: ErrorEnvelope = { error: { code, message, details, request_id: requestId } };
  res.status(status).json(body);
};

function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.parse.failed'
  );
}
