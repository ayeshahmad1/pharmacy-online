import bcrypt from 'bcrypt';
import { config } from './config';

export const hashPassword = (password: string) => bcrypt.hash(password, config.BCRYPT_ROUNDS);

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

let dummyHash: Promise<string> | undefined;

/**
 * Compares against a throwaway hash so a login for an unknown username takes
 * as long as one with a wrong password (no username enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= bcrypt.hash('timing-equaliser', config.BCRYPT_ROUNDS);
  await bcrypt.compare(password, await dummyHash);
}
