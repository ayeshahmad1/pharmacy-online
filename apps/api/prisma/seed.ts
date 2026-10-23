// Seeds roles + the first admin account (always) and sample catalogue/stock
// (outside production only). Safe to re-run: existing rows are left untouched.
//
// Run with: pnpm --filter api db:seed   (reads apps/api/.env)

import { PrismaClient, RoleCode } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12;
const PLACEHOLDER_PASSWORD = 'change-me-before-seeding';

const ROLES: { code: RoleCode; name: string; description: string }[] = [
  { code: RoleCode.ADMIN, name: 'Administrator', description: 'Full access' },
  {
    code: RoleCode.PHARMACIST,
    name: 'Pharmacist',
    description: 'Inventory, sales, returns and reports',
  },
  { code: RoleCode.CASHIER, name: 'Cashier', description: 'Billing and own sales only' },
];

const CATEGORIES = [
  'Analgesics',
  'Antibiotics',
  'Gastrointestinal',
  'Vitamins & Supplements',
  'Cough & Cold',
];

const SUPPLIERS = [
  { name: 'Karachi Medical Distributors', contactPerson: 'Imran Shah', phone: '021-35550101' },
  { name: 'Lahore Pharma Traders', contactPerson: 'Sana Malik', phone: '042-35550202' },
];

type SampleBatch = {
  batchNumber: string;
  /// Months from today; negative = already expired. Expiry is the last day of that month.
  expiryInMonths: number;
  costPrice: string;
  quantity: number;
  supplier: string;
};

type SampleMedicine = {
  name: string;
  genericName: string;
  barcode: string;
  category: string;
  unit: string;
  reorderLevel: number;
  sellingPrice: string;
  batches: SampleBatch[];
};

// Money is always given as strings so no JS float ever touches it.
const MEDICINES: SampleMedicine[] = [
  {
    name: 'Panadol 500mg',
    genericName: 'Paracetamol',
    barcode: '8960000000011',
    category: 'Analgesics',
    unit: 'tablet',
    reorderLevel: 100,
    sellingPrice: '2.50',
    // Three batches (one expired) so FEFO and expiry handling have data to work on.
    batches: [
      {
        batchNumber: 'PN-2401',
        expiryInMonths: -1,
        costPrice: '1.80',
        quantity: 40,
        supplier: 'Karachi Medical Distributors',
      },
      {
        batchNumber: 'PN-2407',
        expiryInMonths: 2,
        costPrice: '1.85',
        quantity: 200,
        supplier: 'Karachi Medical Distributors',
      },
      {
        batchNumber: 'PN-2502',
        expiryInMonths: 18,
        costPrice: '1.90',
        quantity: 500,
        supplier: 'Lahore Pharma Traders',
      },
    ],
  },
  {
    name: 'Brufen 400mg',
    genericName: 'Ibuprofen',
    barcode: '8960000000028',
    category: 'Analgesics',
    unit: 'tablet',
    reorderLevel: 50,
    sellingPrice: '6.00',
    batches: [
      {
        batchNumber: 'BR-2410',
        expiryInMonths: 14,
        costPrice: '4.40',
        quantity: 300,
        supplier: 'Lahore Pharma Traders',
      },
    ],
  },
  {
    name: 'Augmentin 625mg',
    genericName: 'Amoxicillin + Clavulanic Acid',
    barcode: '8960000000035',
    category: 'Antibiotics',
    unit: 'tablet',
    reorderLevel: 30,
    sellingPrice: '48.00',
    batches: [
      // Expires at the end of this month: shows up as "expiring soon".
      {
        batchNumber: 'AG-2403',
        expiryInMonths: 0,
        costPrice: '36.50',
        quantity: 24,
        supplier: 'Karachi Medical Distributors',
      },
      {
        batchNumber: 'AG-2411',
        expiryInMonths: 20,
        costPrice: '37.00',
        quantity: 120,
        supplier: 'Karachi Medical Distributors',
      },
    ],
  },
  {
    name: 'Flagyl 400mg',
    genericName: 'Metronidazole',
    barcode: '8960000000042',
    category: 'Antibiotics',
    unit: 'tablet',
    reorderLevel: 50,
    sellingPrice: '3.20',
    // Below reorder level: shows up on the low-stock list.
    batches: [
      {
        batchNumber: 'FG-2409',
        expiryInMonths: 11,
        costPrice: '2.30',
        quantity: 20,
        supplier: 'Lahore Pharma Traders',
      },
    ],
  },
  {
    name: 'Risek 20mg',
    genericName: 'Omeprazole',
    barcode: '8960000000059',
    category: 'Gastrointestinal',
    unit: 'capsule',
    reorderLevel: 40,
    sellingPrice: '17.50',
    batches: [
      {
        batchNumber: 'RS-2408',
        expiryInMonths: 9,
        costPrice: '12.75',
        quantity: 140,
        supplier: 'Karachi Medical Distributors',
      },
    ],
  },
  {
    name: 'Gaviscon Liquid 120ml',
    genericName: 'Sodium Alginate + Sodium Bicarbonate + Calcium Carbonate',
    barcode: '8960000000066',
    category: 'Gastrointestinal',
    unit: 'bottle',
    reorderLevel: 10,
    sellingPrice: '385.00',
    batches: [
      {
        batchNumber: 'GV-2405',
        expiryInMonths: 7,
        costPrice: '300.00',
        quantity: 18,
        supplier: 'Lahore Pharma Traders',
      },
    ],
  },
  {
    name: 'Surbex-Z',
    genericName: 'Multivitamin + Zinc',
    barcode: '8960000000073',
    category: 'Vitamins & Supplements',
    unit: 'tablet',
    reorderLevel: 30,
    sellingPrice: '18.00',
    batches: [
      {
        batchNumber: 'SZ-2412',
        expiryInMonths: 22,
        costPrice: '13.20',
        quantity: 150,
        supplier: 'Karachi Medical Distributors',
      },
    ],
  },
  {
    name: 'Hydryllin Syrup 120ml',
    genericName: 'Diphenhydramine + Ammonium Chloride',
    barcode: '8960000000080',
    category: 'Cough & Cold',
    unit: 'bottle',
    reorderLevel: 10,
    sellingPrice: '140.00',
    batches: [
      {
        batchNumber: 'HY-2406',
        expiryInMonths: 5,
        costPrice: '105.00',
        quantity: 25,
        supplier: 'Lahore Pharma Traders',
      },
    ],
  },
];

/** Last day of the month `months` from now, as a UTC date (stored as Postgres DATE). */
function endOfMonthFromNow(months: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months + 1, 0));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy apps/api/.env.example to apps/api/.env.`);
  return value;
}

async function seedRolesAndAdmin() {
  const isProduction = process.env.NODE_ENV === 'production';
  const username = requireEnv('SEED_ADMIN_USERNAME').toLowerCase();
  const password = requireEnv('SEED_ADMIN_PASSWORD');
  const fullName = process.env.SEED_ADMIN_FULL_NAME?.trim() || 'System Administrator';

  if (password.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters.');
  if (isProduction && password === PLACEHOLDER_PASSWORD) {
    throw new Error('Refusing to seed production with the placeholder admin password.');
  }

  for (const role of ROLES) {
    await prisma.role.upsert({ where: { code: role.code }, update: {}, create: role });
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`Admin user "${username}" already exists, leaving it unchanged.`);
    return existing;
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: RoleCode.ADMIN } });
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    const admin = await tx.user.create({
      data: { username, fullName, passwordHash, roleId: adminRole.id },
    });
    await tx.auditLog.create({
      data: {
        action: 'USER_CREATE',
        entityType: 'User',
        entityId: admin.id,
        after: { username, fullName, role: RoleCode.ADMIN, source: 'seed' },
      },
    });
    console.log(`Created admin user "${username}".`);
    return admin;
  });
}

async function seedSampleCatalogue(adminId: string) {
  // One transaction: a batch and its PURCHASE movement are always created together.
  const created = await prisma.$transaction(
    async (tx) => {
      const counts = { categories: 0, suppliers: 0, medicines: 0, batches: 0 };

      const categoryIds = new Map<string, string>();
      for (const name of CATEGORIES) {
        const found = await tx.category.findUnique({ where: { name } });
        const category = found ?? (await tx.category.create({ data: { name } }));
        if (!found) counts.categories++;
        categoryIds.set(name, category.id);
      }

      const supplierIds = new Map<string, string>();
      for (const data of SUPPLIERS) {
        const found = await tx.supplier.findUnique({ where: { name: data.name } });
        const supplier = found ?? (await tx.supplier.create({ data }));
        if (!found) counts.suppliers++;
        supplierIds.set(data.name, supplier.id);
      }

      for (const { batches, category, ...medicineData } of MEDICINES) {
        const categoryId = categoryIds.get(category);
        if (!categoryId) throw new Error(`Unknown category "${category}"`);

        const found = await tx.medicine.findUnique({ where: { barcode: medicineData.barcode } });
        const medicine =
          found ?? (await tx.medicine.create({ data: { ...medicineData, categoryId } }));
        if (!found) counts.medicines++;

        for (const b of batches) {
          const supplierId = supplierIds.get(b.supplier);
          if (!supplierId) throw new Error(`Unknown supplier "${b.supplier}"`);

          const exists = await tx.batch.findFirst({
            where: { medicineId: medicine.id, batchNumber: b.batchNumber },
          });
          if (exists) continue;

          await tx.batch.create({
            data: {
              medicineId: medicine.id,
              supplierId,
              batchNumber: b.batchNumber,
              expiryDate: endOfMonthFromNow(b.expiryInMonths),
              costPrice: b.costPrice,
              quantityReceived: b.quantity,
              movements: {
                create: {
                  type: 'PURCHASE',
                  quantity: b.quantity,
                  reason: 'Seed: opening stock',
                  userId: adminId,
                },
              },
            },
          });
          counts.batches++;
        }
      }

      if (Object.values(counts).some((n) => n > 0)) {
        await tx.auditLog.create({
          data: {
            userId: adminId,
            action: 'SEED_SAMPLE_DATA',
            entityType: 'System',
            after: counts,
          },
        });
      }
      return counts;
    },
    { timeout: 30_000 },
  );

  console.log('Sample data created:', created);
}

async function main() {
  const admin = await seedRolesAndAdmin();

  if (process.env.NODE_ENV === 'production') {
    console.log('NODE_ENV=production: skipping sample medicines and batches.');
    return;
  }
  await seedSampleCatalogue(admin.id);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
