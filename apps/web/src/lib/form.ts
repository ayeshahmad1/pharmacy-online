import { ApiError } from './api';

/**
 * Form validation with the shared Zod schemas. Errors are keyed by the issue
 * path joined with dots ("name", "items.2.batchNumber"), so one map covers
 * flat forms and line-item forms alike.
 */

export type FieldErrors = Record<string, string>;

type Issue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  expected?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
};

/** The structural slice of a Zod schema this needs; the web app does not import zod itself. */
type Schema<T> = {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
};

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

export function parseForm<T>(schema: Schema<T>, values: unknown): ParseResult<T> {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data };

  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join('.');
    // The first issue per field is the most useful; later ones repeat the problem.
    if (!(key in errors)) errors[key] = friendlyMessage(issue, valueAt(values, issue.path));
  }
  return { ok: false, errors };
}

function valueAt(values: unknown, path: readonly PropertyKey[]): unknown {
  let current = values;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * The shared schemas carry hand-written messages where it matters. Zod's own
 * defaults ("Invalid input: expected number, received undefined") are
 * replaced with something a counter clerk can act on.
 */
export function friendlyMessage(issue: Issue, value: unknown): string {
  const isDefault = /^(Invalid|Too small|Too big)/.test(issue.message);
  if (!isDefault) return issue.message;

  if (isBlank(value)) return 'Required';
  switch (issue.code) {
    case 'invalid_type':
      return issue.expected === 'number' ? 'Enter a whole number' : 'Invalid value';
    case 'too_small':
      return issue.origin === 'string'
        ? `At least ${String(issue.minimum)} characters`
        : `Must be at least ${String(issue.minimum)}`;
    case 'too_big':
      return issue.origin === 'string'
        ? `At most ${String(issue.maximum)} characters`
        : `Must be at most ${String(issue.maximum)}`;
    case 'invalid_format':
      return 'Invalid format';
    default:
      return issue.message;
  }
}

/**
 * Form input for an integer field: blank becomes undefined (so schema defaults
 * apply), a whole number becomes a number, anything else is passed through so
 * the schema rejects it.
 */
export function intInput(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

type ItemIssue = { index: number; field: string; message: string };

/**
 * Field errors the API reported, in the same keys parseForm uses. Covers the
 * validate middleware's flattened errors, `{ field }` conflicts (duplicate
 * barcode, inactive supplier) and per-line `{ items: [...] }` receipt errors.
 */
export function serverFieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof ApiError) || typeof err.details !== 'object' || err.details === null) {
    return {};
  }
  const details = err.details as {
    field?: unknown;
    items?: unknown;
    body?: { fieldErrors?: Record<string, string[] | undefined> };
  };
  const errors: FieldErrors = {};

  for (const [key, messages] of Object.entries(details.body?.fieldErrors ?? {})) {
    if (messages?.[0]) errors[key] = messages[0];
  }
  if (typeof details.field === 'string') errors[details.field] = err.message;
  if (Array.isArray(details.items)) {
    for (const item of details.items as ItemIssue[]) {
      errors[`items.${item.index}.${item.field}`] = item.message;
    }
  }
  return errors;
}
