import { createHash, randomBytes } from 'node:crypto';
import type { RoleCode } from '@pharmacy/shared';
import jwt from 'jsonwebtoken';
import { config } from '../../lib/config';

const ISSUER = 'pharmacy-pos-api';
const AUDIENCE = 'pharmacy-pos';

export type AccessTokenClaims = { sub: string; username: string; role: RoleCode };

export function signAccessToken(user: { id: string; username: string; role: RoleCode }): string {
  return jwt.sign({ username: user.username, role: user.role }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: config.JWT_ACCESS_TTL_SECONDS,
  });
}

/** Returns the claims, or null if the token is malformed, expired or forged. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/** Opaque refresh token: 256 random bits. Only its hash is stored. */
export const generateRefreshToken = () => randomBytes(32).toString('base64url');

export const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');
