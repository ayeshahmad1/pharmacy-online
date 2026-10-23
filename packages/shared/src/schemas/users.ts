import { z } from 'zod';
import { RECORD_STATUSES, ROLE_CODES } from '../constants';
import { passwordSchema, usernameSchema } from './auth';
import { emailSchema, nonEmptyPatch, paginationQuerySchema } from './common';

const fullNameSchema = z.string().trim().min(1, 'Full name is required').max(100);

export const createUserBodySchema = z.strictObject({
  username: usernameSchema,
  fullName: fullNameSchema,
  email: emailSchema.nullish(),
  role: z.enum(ROLE_CODES),
  password: passwordSchema,
});
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

// Status is changed only through the deactivate/activate endpoints, and the
// password only through reset-password, so each has its own audit entry.
export const updateUserBodySchema = nonEmptyPatch(
  z.strictObject({
    fullName: fullNameSchema.optional(),
    email: emailSchema.nullable().optional(),
    role: z.enum(ROLE_CODES).optional(),
  }),
);
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export const resetPasswordBodySchema = z.strictObject({
  newPassword: passwordSchema,
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  /** Matches username or full name (case-insensitive substring). */
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLE_CODES).optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
