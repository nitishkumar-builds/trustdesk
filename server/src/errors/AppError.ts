export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GUARDRAIL_BLOCKED'
  | 'TOOL_EXECUTION_FAILED'
  | 'AI_PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export type ErrorDetails = Record<string, unknown> | null;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details ?? null;
  }
}

export const validationError = (message = 'Request validation failed', details?: ErrorDetails) =>
  new AppError('VALIDATION_ERROR', 400, message, details);

export const unauthorizedError = (message = 'Authentication required', details?: ErrorDetails) =>
  new AppError('UNAUTHORIZED', 401, message, details);

export const forbiddenError = (message = 'Insufficient permissions', details?: ErrorDetails) =>
  new AppError('FORBIDDEN', 403, message, details);

export const notFoundError = (message = 'Resource not found', details?: ErrorDetails) =>
  new AppError('NOT_FOUND', 404, message, details);

export const conflictError = (
  message = 'Request conflicts with current state',
  details?: ErrorDetails,
) => new AppError('CONFLICT', 409, message, details);

export const guardrailError = (message = 'Blocked by guardrail policy', details?: ErrorDetails) =>
  new AppError('GUARDRAIL_BLOCKED', 403, message, details);

export const toolExecutionError = (message = 'Tool execution failed', details?: ErrorDetails) =>
  new AppError('TOOL_EXECUTION_FAILED', 500, message, details);

export const aiProviderError = (message = 'AI provider request failed', details?: ErrorDetails) =>
  new AppError('AI_PROVIDER_ERROR', 502, message, details);
