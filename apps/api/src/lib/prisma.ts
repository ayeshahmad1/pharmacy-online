import { PrismaClient } from '@prisma/client';

// Single shared client. In dev, tsx watch reloads modules, so keep the
// instance on globalThis to avoid exhausting Postgres connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
