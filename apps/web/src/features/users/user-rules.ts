// User management rules the screen shows before the server enforces them:
// an admin cannot change their own role or deactivate themselves, so the
// pharmacy is never left without an active admin.

import type { RoleCode, UpdateUserBody, UserDto } from '@pharmacy/shared';
import { ApiError } from '@/lib/api';
import { serverFieldErrors, type FieldErrors } from '@/lib/form';

export const ROLE_LABELS: Record<RoleCode, string> = {
  ADMIN: 'Admin',
  PHARMACIST: 'Pharmacist',
  CASHIER: 'Cashier',
};

export const ROLE_DESCRIPTIONS: Record<RoleCode, string> = {
  ADMIN: 'Everything, including users',
  PHARMACIST: 'Stock, sales, returns, approvals and reports',
  CASHIER: 'Billing, their own sales and returns',
};

export type SelfGuards = {
  isSelf: boolean;
  /** Why the role cannot be changed, or null. */
  roleLocked: string | null;
  /** Why the account cannot be deactivated, or null. */
  deactivateLocked: string | null;
};

export function selfGuards(target: Pick<UserDto, 'id'>, me: Pick<UserDto, 'id'>): SelfGuards {
  const isSelf = target.id === me.id;
  return {
    isSelf,
    roleLocked: isSelf ? 'You cannot change your own role; ask another admin.' : null,
    deactivateLocked: isSelf ? 'You cannot deactivate your own account.' : null,
  };
}

export type UserFormValues = {
  username: string;
  fullName: string;
  email: string;
  role: RoleCode;
  password: string;
};

/** Create body for the shared schema: a blank email is "none". */
export function createUserInput(values: UserFormValues) {
  return {
    username: values.username,
    fullName: values.fullName,
    email: values.email.trim() === '' ? null : values.email,
    role: values.role,
    password: values.password,
  };
}

/** Update body for the shared schema: name, email (blank clears it) and role. */
export function updateUserInput(values: UserFormValues) {
  return {
    fullName: values.fullName,
    email: values.email.trim() === '' ? null : values.email,
    role: values.role,
  };
}

/**
 * Only the fields that differ from the saved user, so the audit log records
 * real changes. Empty when nothing changed.
 */
export function changedFields(before: UserDto, parsed: UpdateUserBody): UpdateUserBody {
  const changes: UpdateUserBody = {};
  if (parsed.fullName !== undefined && parsed.fullName !== before.fullName) {
    changes.fullName = parsed.fullName;
  }
  if (parsed.email !== undefined && parsed.email !== before.email) changes.email = parsed.email;
  if (parsed.role !== undefined && parsed.role !== before.role) changes.role = parsed.role;
  return changes;
}

/**
 * API errors on the user form's fields. A taken username comes back as a
 * unique-constraint conflict naming the column, rather than a field error.
 */
export function userFormErrors(err: unknown): FieldErrors {
  const errors = serverFieldErrors(err);
  const fields = err instanceof ApiError && (err.details as { fields?: unknown } | null)?.fields;
  if (err instanceof ApiError && err.code === 'CONFLICT' && Array.isArray(fields)) {
    if (fields.includes('username')) errors.username = 'This username is already taken';
  }
  return errors;
}
