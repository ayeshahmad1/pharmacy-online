// Every API error response has the shape { error: { code, message, details? } }.

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_INACTIVE',
  'INVALID_REFRESH_TOKEN',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_STOCK',
  'IDEMPOTENCY_KEY_REUSED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};
