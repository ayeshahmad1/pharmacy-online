import { createUserBodySchema, updateUserBodySchema, type UserDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { parseForm } from '@/lib/form';
import {
  changedFields,
  createUserInput,
  selfGuards,
  updateUserInput,
  userFormErrors,
  type UserFormValues,
} from './user-rules';

const admin: UserDto = {
  id: '0b9f7f52-2f1b-4d8f-8b7a-6a5c4d3e2f10',
  username: 'admin',
  fullName: 'Ayesha Admin',
  email: 'admin@example.com',
  role: 'ADMIN',
  status: 'ACTIVE',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const cashier: UserDto = {
  ...admin,
  id: '7d3b1a0e-8a8f-4c8e-9d0a-1f2e3d4c5b6a',
  username: 'bilal',
  fullName: 'Bilal Cashier',
  email: null,
  role: 'CASHIER',
};

const values = (over: Partial<UserFormValues> = {}): UserFormValues => ({
  username: 'Sara.K',
  fullName: 'Sara Khan',
  email: '',
  role: 'PHARMACIST',
  password: 'Counter#2026',
  ...over,
});

describe('selfGuards', () => {
  it('locks role and deactivation on your own account only', () => {
    expect(selfGuards(admin, admin)).toEqual({
      isSelf: true,
      roleLocked: expect.stringMatching(/own role/),
      deactivateLocked: expect.stringMatching(/own account/),
    });
    expect(selfGuards(cashier, admin)).toEqual({
      isSelf: false,
      roleLocked: null,
      deactivateLocked: null,
    });
  });
});

describe('createUserInput', () => {
  it('sends a blank email as none, and the schema normalises the username', () => {
    const parsed = parseForm(createUserBodySchema, createUserInput(values()));
    expect(parsed).toEqual({
      ok: true,
      data: {
        username: 'sara.k',
        fullName: 'Sara Khan',
        email: null,
        role: 'PHARMACIST',
        password: 'Counter#2026',
      },
    });
  });

  it('reports the shared schema’s messages per field', () => {
    const parsed = parseForm(
      createUserBodySchema,
      createUserInput(values({ username: 'a b', email: 'nope', password: 'short' })),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toMatchObject({
      username: expect.stringMatching(/letters, digits/),
      email: 'Enter a valid email address',
      password: 'Password must be at least 8 characters',
    });
  });
});

describe('updates', () => {
  const parse = (v: UserFormValues) => {
    const parsed = parseForm(updateUserBodySchema, updateUserInput(v));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return parsed.data;
  };

  it('sends only what changed', () => {
    const same = parse(values({ fullName: 'Bilal Cashier', email: '', role: 'CASHIER' }));
    expect(changedFields(cashier, same)).toEqual({});

    const changed = parse(
      values({ fullName: ' Bilal Ahmed ', email: 'Bilal@Example.com', role: 'PHARMACIST' }),
    );
    expect(changedFields(cashier, changed)).toEqual({
      fullName: 'Bilal Ahmed',
      email: 'bilal@example.com',
      role: 'PHARMACIST',
    });
  });

  it('clears an email by sending null', () => {
    const cleared = parse(values({ fullName: admin.fullName, email: ' ', role: 'ADMIN' }));
    expect(changedFields(admin, cleared)).toEqual({ email: null });
  });
});

describe('userFormErrors', () => {
  it('puts a taken username on the username field', () => {
    const err = new ApiError(409, 'CONFLICT', 'A record with this value already exists', {
      fields: ['username'],
    });
    expect(userFormErrors(err)).toEqual({ username: 'This username is already taken' });
  });

  it('passes validation errors through and leaves other errors to the form alert', () => {
    const invalid = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
      body: { fieldErrors: { email: ['Invalid email'] } },
    });
    expect(userFormErrors(invalid)).toEqual({ email: 'Invalid email' });
    expect(
      userFormErrors(new ApiError(400, 'BAD_REQUEST', 'You cannot change your own role')),
    ).toEqual({});
  });
});
