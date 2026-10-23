import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

/**
 * Validates and parses the request with the given Zod schemas. On success the
 * parsed (coerced, trimmed, defaulted) values replace req.body / req.query /
 * req.params, so controllers can cast them to the schema's inferred type.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: Record<string, ReturnType<typeof z.flattenError>> = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        issues[part] = z.flattenError(result.error);
        continue;
      }
      // Express 5 exposes req.query as a getter, so it can't be assigned.
      Object.defineProperty(req, part, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    if (Object.keys(issues).length > 0) {
      next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', issues));
      return;
    }
    next();
  };
}
