/**
 * Escapes LIKE/ILIKE wildcards so user input matches literally: searching
 * "50%" must not match everything starting with "50". Postgres' default LIKE
 * escape character is backslash, which Prisma's `contains` also relies on.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
