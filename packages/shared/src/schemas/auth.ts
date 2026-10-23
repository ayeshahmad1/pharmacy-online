import { z } from 'zod';
import type { RecordStatus, RoleCode } from '../constants';

// bcrypt only uses the first 72 bytes of a password, so longer ones would
// silently match on a prefix. Count UTF-8 bytes, not characters.
const utf8Length = (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/gi, 'x').length;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

/** Policy for new passwords (create user, reset password). */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((s) => utf8Length(s) <= PASSWORD_MAX_BYTES, {
    message: `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  });

/** Usernames are stored lowercase; login is case-insensitive. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'Username may only contain letters, digits, dot, dash and underscore');

// Login does not re-apply the password policy: old accounts may predate it.
export const loginBodySchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** A user as returned by the API. Never includes the password hash. */
export type UserDto = {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  role: RoleCode;
  status: RecordStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Returned by login and refresh. The refresh token is not in the body: it is
 * set as an httpOnly cookie scoped to /api/auth.
 */
export type AuthResponse = {
  accessToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: UserDto;
};
