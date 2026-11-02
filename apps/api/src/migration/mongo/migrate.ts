// Loads the old MongoDB pharmacy data into Postgres.
//
//   pnpm --filter api migrate:mongo              dry run (the default)
//   pnpm --filter api migrate:mongo --commit     load for real
//
// Options: --batch-size 500, --actor <username> (who the opening-stock
// movements and audit entries are recorded under; default: the oldest active
// admin after users are loaded), --out <dir> (default migration-output/<run>).
// Reads MONGO_URL (database name in the path, or MONGO_DB) and DATABASE_URL.
//
// Order is parents first: users → category and suppliers → medicines →
// batches with their opening stock → sales with lines and payments → the
// delivery history (LegacyPurchase) → legacy returns (LegacyReturn). Every
// loaded row is recorded in LegacyIdMap with its Mongo _id.
//
// Dry run: everything is written inside one transaction, the verification
// totals are computed from what was written, and the transaction is rolled
// back, so the database's constraints and triggers check the data but
// nothing is kept. --commit: one transaction per batch; a re-run skips rows
// already in LegacyIdMap, so a failed run can be resumed. Freeze the old
// system first: receipt numbers are assigned from the full set of sales.
//
// Stock (decided in Session 13): the old purchase and sale history doesn't
// add up to the stock Mongo shows, so each batch gets its Mongo quantity as
// one opening ADJUSTMENT movement and legacy sales are loaded as history
// without stock movements. Purchases and returns are history only too (rule
// 15): no stock movements, and returns stay out of every report because they
// name no original sale. Medicines and cashiers deleted from Mongo get
// inactive placeholders. Rejected records go to rejects.jsonl, never
// silently dropped.

import { config } from '../../lib/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type Prisma, PrismaClient, RoleCode } from '@prisma/client';
import bcrypt from 'bcrypt';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { businessToday, fromDateOnly } from '../../lib/dates';
import { formatPaisa, type Paisa } from '../../lib/money';
import {
  Rejected,
  UNKNOWN_SUPPLIER,
  assignReceiptNumbers,
  isLegacyReturn,
  legacyCount,
  legacyMoney,
  mapLegacyReturn,
  mapMedicine,
  mapPurchase,
  mapSale,
  mapUser,
  placeholderExpiry,
  quantityReceived,
  shortId,
  supplierKey,
  uniqueName,
  unitCostFromPurchases,
  type LegacyMedicine,
  type LegacyPurchase,
  type LegacySale,
  type LegacyUser,
  type MappedMedicine,
  type MappedPurchase,
  type MappedReturn,
  type MappedSale,
  type MappedUser,
} from './transform';

const CATEGORY_NAME = 'Uncategorised';
const OPENING_STOCK_REASON = 'Opening stock from the old system';
const ROLE_NAMES: Record<RoleCode, string> = {
  ADMIN: 'Administrator',
  PHARMACIST: 'Pharmacist',
  CASHIER: 'Cashier',
};

// ─── Arguments and output ───────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    commit: { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '500' },
    actor: { type: 'string' },
    out: { type: 'string' },
  },
});
const dryRun = !args.commit;
const batchSize = Number(args['batch-size']);
if (!Number.isSafeInteger(batchSize) || batchSize < 1)
  fail('--batch-size must be a positive whole number');
const tz = config.BUSINESS_TIMEZONE;
const runStartedAt = new Date();
const runName = `${runStartedAt.toISOString().replace(/[:.]/g, '-')}-${dryRun ? 'dry-run' : 'commit'}`;
const outDir = path.resolve(args.out ?? path.join('..', '..', 'migration-output', runName));
mkdirSync(outDir, { recursive: true });

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

const rejectCounts = new Map<string, number>();
const warnCounts = new Map<string, number>();

function logReject(source: string, legacyId: string, reason: string, detail?: string) {
  const key = `${source} ${reason}`;
  rejectCounts.set(key, (rejectCounts.get(key) ?? 0) + 1);
  appendFileSync(
    path.join(outDir, 'rejects.jsonl'),
    JSON.stringify({ source, legacyId, reason, detail }) + '\n',
  );
}

function logWarning(source: string, legacyId: string, code: string, detail: string) {
  const key = `${source} ${code}`;
  warnCounts.set(key, (warnCounts.get(key) ?? 0) + 1);
  appendFileSync(
    path.join(outDir, 'warnings.jsonl'),
    JSON.stringify({ source, legacyId, code, detail }) + '\n',
  );
}

const warnFor = (source: string, legacyId: string) => (code: string, detail: string) =>
  logWarning(source, legacyId, code, detail);

// ─── Reading Mongo ──────────────────────────────────────────────────────────

const hex = (v: unknown): string | null =>
  v instanceof ObjectId ? v.toHexString() : typeof v === 'string' ? v : null;

type Source = {
  users: LegacyUser[];
  medicines: LegacyMedicine[];
  purchases: LegacyPurchase[];
  sales: LegacySale[];
  billSequenceDays: number;
};

async function readMongo(): Promise<Source> {
  const url = process.env.MONGO_URL;
  if (!url) fail('MONGO_URL is not set (apps/api/.env)');
  const client = new MongoClient(url, { readPreference: 'secondaryPreferred' });
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_DB || undefined);
    if (db.databaseName === 'test') fail('Put the database name in MONGO_URL or set MONGO_DB');
    console.log(`Reading MongoDB database "${db.databaseName}"…`);
    const all = (name: string) => db.collection<Document>(name).find().sort({ _id: 1 }).toArray();
    const [users, medicines, purchases, sales, billSequences] = await Promise.all([
      all('users'),
      all('medicines'),
      all('purchases'),
      all('sales'),
      all('billsequences'),
    ]);
    return {
      users: users.map((d) => ({ ...d, id: hex(d._id)! })),
      medicines: medicines.map((d) => ({
        ...d,
        id: hex(d._id)!,
        idTime: d._id.getTimestamp(),
      })),
      purchases: purchases.map((d) => ({ ...d, id: hex(d._id)!, medicineId: hex(d.medicineId) })),
      sales: sales.map((d) => ({
        ...d,
        id: hex(d._id)!,
        cashierId: hex(d.cashierId),
        items: ((d.items as Document[] | undefined) ?? []).map((i) => ({
          ...i,
          medicineId: hex(i.medicineId),
        })),
      })),
      billSequenceDays: billSequences.length,
    };
  } finally {
    await client.close();
  }
}

// ─── Planning: map every document and decide every row before writing ──────

type PlannedUser = MappedUser & {
  legacyId: string;
  source: string;
  username: string;
  active: boolean;
  createdAt: Date;
};
type PlannedMedicine = MappedMedicine & { legacyId: string; placeholder: boolean };
type PlannedBatch = {
  legacyId: string;
  medicineLegacyId: string;
  supplier: string;
  batchNumber: string;
  expiryDate: string;
  costPrice: Paisa;
  quantityReceived: number;
  openingQuantity: number;
  createdAt: Date;
};
type PlannedSale = MappedSale & {
  legacyId: string;
  cashierLegacyId: string;
  receiptNumber: string;
};
type PlannedPurchase = MappedPurchase & { legacyId: string };
type PlannedReturn = MappedReturn & { legacyId: string; cashierLegacyId: string };

type Plan = {
  users: PlannedUser[];
  suppliers: string[];
  medicines: PlannedMedicine[];
  batches: PlannedBatch[];
  sales: PlannedSale[];
  purchases: PlannedPurchase[];
  returns: PlannedReturn[];
  receiptDays: Map<string, number>;
  /** Mongo-side totals for the comparison. */
  source: {
    counts: Record<string, number>;
    saleLines: number;
    returnLines: number;
    salesPaisa: Paisa;
    returnsPaisa: Paisa;
    returnCount: number;
    rawTotalPrice: number;
    rejectedSalesPaisa: Paisa;
    rejectedSaleCount: number;
    rejectedReturnsPaisa: Paisa;
    rejectedReturnCount: number;
    stockByMedicine: Map<string, { name: string; quantity: number }>;
  };
};

/** Placeholder user for sales whose cashier is gone from Mongo (or was never set). */
const NO_CASHIER = 'none';

async function plan(src: Source, existingUsernames: Set<string>, existingEmails: Set<string>) {
  const usernames = new Set(existingUsernames);

  // Users.
  const users: PlannedUser[] = [];
  const userIds = new Set<string>();
  const rejectedUsers = new Set<string>();
  for (const doc of src.users) {
    try {
      const mapped = mapUser(doc);
      const username = uniqueName(mapped.username, usernames);
      if (username !== mapped.username) {
        logWarning('users', doc.id, 'USERNAME_CHANGED', `${mapped.username} → ${username}`);
      }
      let email = mapped.email;
      if (email && existingEmails.has(email)) {
        logWarning('users', doc.id, 'EMAIL_DROPPED', `${email} already belongs to another user`);
        email = null;
      }
      users.push({
        ...mapped,
        email,
        username,
        legacyId: doc.id,
        source: 'users',
        active: true,
        createdAt: new ObjectId(doc.id).getTimestamp(),
      });
      userIds.add(doc.id);
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      rejectedUsers.add(doc.id);
      logReject('users', doc.id, e.reason, e.detail);
    }
  }

  // Medicines.
  const medicines = new Map<string, PlannedMedicine>();
  const rejectedMedicines = new Set<string>();
  for (const doc of src.medicines) {
    try {
      const mapped = mapMedicine(doc, tz, warnFor('medicines', doc.id));
      medicines.set(doc.id, { ...mapped, legacyId: doc.id, placeholder: false });
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      rejectedMedicines.add(doc.id);
      logReject('medicines', doc.id, e.reason, e.detail);
    }
  }

  const mongoMedicineIds = new Set(src.medicines.map((m) => m.id));
  /**
   * Medicine deleted from Mongo but named by a sale, return or purchase →
   * units sold and returned, the latest unit price seen, first and last use.
   */
  const deletedMedicines = new Map<
    string,
    {
      sold: number;
      returned: number;
      lastPrice: Paisa;
      pricedAt: number;
      first: Date;
      last: Date;
    }
  >();
  function noteMedicine(
    legacyId: string,
    at: Date,
    line?: { quantity: number; unitPrice: Paisa; returned: boolean },
  ) {
    if (mongoMedicineIds.has(legacyId)) return;
    let d = deletedMedicines.get(legacyId);
    if (!d) {
      d = { sold: 0, returned: 0, lastPrice: 0n, pricedAt: -Infinity, first: at, last: at };
      deletedMedicines.set(legacyId, d);
    }
    if (at < d.first) d.first = at;
    if (at > d.last) d.last = at;
    if (!line) return;
    if (line.returned) d.returned += line.quantity;
    else d.sold += line.quantity;
    if (at.getTime() >= d.pricedAt) {
      d.pricedAt = at.getTime();
      d.lastPrice = line.unitPrice;
    }
  }

  /** Cashier deleted from Mongo (or never set) → their first sale or return. */
  const missingCashiers = new Map<string, Date>();
  function noteCashier(legacyId: string, at: Date) {
    if (rejectedUsers.has(legacyId)) return false;
    if (!userIds.has(legacyId)) {
      const first = missingCashiers.get(legacyId);
      if (!first || at < first) missingCashiers.set(legacyId, at);
    }
    return true;
  }

  // Purchases: the delivery history, and each batch's cost and quantity received.
  const purchases: PlannedPurchase[] = [];
  const purchasesByMedicine = new Map<string, LegacyPurchase[]>();
  for (const doc of src.purchases) {
    try {
      const mapped = mapPurchase(doc, warnFor('purchases', doc.id));
      if (rejectedMedicines.has(mapped.medicineLegacyId)) {
        throw new Rejected('PURCHASE_MEDICINE_REJECTED', `medicine ${mapped.medicineLegacyId}`);
      }
      noteMedicine(mapped.medicineLegacyId, mapped.purchasedAt);
      purchases.push({ ...mapped, legacyId: doc.id });
      const list = purchasesByMedicine.get(mapped.medicineLegacyId) ?? [];
      list.push(doc);
      purchasesByMedicine.set(mapped.medicineLegacyId, list);
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      logReject('purchases', doc.id, e.reason, e.detail);
    }
  }

  // Sales and returns (the old system kept both in "sales").
  const sales: (MappedSale & { legacyId: string; cashierLegacyId: string })[] = [];
  const returns: PlannedReturn[] = [];
  let salesPaisa = 0n;
  let returnsPaisa = 0n;
  let returnCount = 0;
  let rawTotalPrice = 0;
  let rejectedSalesPaisa = 0n;
  let rejectedSaleCount = 0;
  let rejectedReturnsPaisa = 0n;
  let rejectedReturnCount = 0;
  let saleLines = 0;
  let returnLines = 0;

  for (const doc of src.sales) {
    if (typeof doc.totalPrice === 'number') rawTotalPrice += doc.totalPrice;
    const total = typeof doc.totalPrice === 'number' ? legacyMoney(Math.abs(doc.totalPrice)) : null;

    if (isLegacyReturn(doc)) {
      returnCount++;
      returnLines += doc.items.length;
      returnsPaisa += total?.paisa ?? 0n;
      try {
        const mapped = mapLegacyReturn(doc, warnFor('sales', doc.id));
        for (const line of mapped.lines) {
          if (rejectedMedicines.has(line.medicineLegacyId)) {
            throw new Rejected('RETURN_MEDICINE_REJECTED', `medicine ${line.medicineLegacyId}`);
          }
        }
        const cashier = doc.cashierId ?? NO_CASHIER;
        if (!noteCashier(cashier, mapped.returnedAt)) {
          throw new Rejected('RETURN_CASHIER_REJECTED', `user ${cashier}`);
        }
        for (const line of mapped.lines) {
          noteMedicine(line.medicineLegacyId, mapped.returnedAt, { ...line, returned: true });
        }
        returns.push({ ...mapped, legacyId: doc.id, cashierLegacyId: cashier });
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        logReject('sales', doc.id, e.reason, e.detail);
        rejectedReturnCount++;
        rejectedReturnsPaisa += total?.paisa ?? 0n;
      }
      continue;
    }

    saleLines += doc.items.length;
    salesPaisa += total?.paisa ?? 0n;
    try {
      const mapped = mapSale(doc, warnFor('sales', doc.id));
      for (const line of mapped.lines) {
        if (rejectedMedicines.has(line.medicineLegacyId)) {
          throw new Rejected('SALE_MEDICINE_REJECTED', `medicine ${line.medicineLegacyId}`);
        }
      }
      const cashier = doc.cashierId ?? NO_CASHIER;
      if (!noteCashier(cashier, mapped.soldAt)) {
        throw new Rejected('SALE_CASHIER_REJECTED', `user ${cashier}`);
      }
      for (const line of mapped.lines) {
        noteMedicine(line.medicineLegacyId, mapped.soldAt, { ...line, returned: false });
      }
      sales.push({ ...mapped, legacyId: doc.id, cashierLegacyId: cashier });
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      logReject('sales', doc.id, e.reason, e.detail);
      rejectedSaleCount++;
      rejectedSalesPaisa += total?.paisa ?? 0n;
    }
  }

  // Placeholder users for sales and returns by cashiers deleted from Mongo.
  for (const [legacyId, firstSeen] of missingCashiers) {
    const none = legacyId === NO_CASHIER;
    const username = uniqueName(
      none ? 'legacy-unknown' : `legacy-user-${shortId(legacyId)}`,
      usernames,
    );
    users.push({
      legacyId,
      source: none ? 'sales.cashierId' : 'users',
      username,
      fullName: none
        ? 'Unknown cashier (old system)'
        : `Deleted user #${shortId(legacyId)} (old system)`,
      email: null,
      // A hash of random bytes nobody knows: the account can never log in.
      passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), config.BCRYPT_ROUNDS),
      role: RoleCode.CASHIER,
      active: false,
      createdAt: firstSeen,
    });
    logWarning(
      'users',
      legacyId,
      'PLACEHOLDER_USER',
      `${username} for sales or returns without a known cashier`,
    );
  }

  // Placeholder medicines for sales, returns and purchases of medicines
  // deleted from Mongo. Their batch expired the day after it was last used.
  for (const [legacyId, d] of deletedMedicines) {
    medicines.set(legacyId, {
      legacyId,
      placeholder: true,
      name: `Deleted item #${shortId(legacyId)} (old system)`,
      unit: 'unit',
      sellingPrice: d.lastPrice,
      active: false,
      supplier: UNKNOWN_SUPPLIER,
      batchNumber: 'LEGACY-UNKNOWN',
      expiryDate: placeholderExpiry(businessToday(d.last, tz)),
      openingQuantity: 0,
      createdAt: d.first,
    });
    logWarning(
      'medicines',
      legacyId,
      'PLACEHOLDER_MEDICINE',
      `${d.sold} units sold, ${d.returned} returned, name unknown`,
    );
  }

  // Batches: one per medicine that ever had stock. Every medicine a loaded
  // sale, return or purchase names has units there, so it gets one.
  const unitsBy = (rows: { lines: { medicineLegacyId: string; quantity: number }[] }[]) => {
    const units = new Map<string, number>();
    for (const r of rows) {
      for (const l of r.lines) {
        units.set(l.medicineLegacyId, (units.get(l.medicineLegacyId) ?? 0) + l.quantity);
      }
    }
    return units;
  };
  const soldByMedicine = unitsBy(sales);
  const returnedByMedicine = unitsBy(returns);
  const batches: PlannedBatch[] = [];
  for (const m of medicines.values()) {
    const delivered = purchasesByMedicine.get(m.legacyId) ?? [];
    const purchased = delivered.reduce((a, p) => a + (legacyCount(p.quantity) ?? 0), 0);
    const received = quantityReceived(
      purchased,
      m.openingQuantity,
      soldByMedicine.get(m.legacyId) ?? 0,
      returnedByMedicine.get(m.legacyId) ?? 0,
    );
    if (received === 0) {
      logWarning('medicines', m.legacyId, 'NO_BATCH', 'never stocked or sold: medicine only');
      continue;
    }
    let cost = unitCostFromPurchases(delivered);
    if (cost === null) {
      cost = 0n;
      if (!m.placeholder)
        logWarning('medicines', m.legacyId, 'COST_UNKNOWN', `${m.name}: cost set to 0`);
    }
    batches.push({
      legacyId: m.legacyId,
      medicineLegacyId: m.legacyId,
      supplier: m.supplier,
      batchNumber: m.batchNumber,
      expiryDate: m.expiryDate,
      costPrice: cost,
      quantityReceived: received,
      openingQuantity: m.openingQuantity,
      createdAt: m.createdAt,
    });
  }

  const suppliers = new Map<string, string>();
  for (const name of [...batches, ...purchases].map((r) => r.supplier)) {
    if (!suppliers.has(supplierKey(name))) suppliers.set(supplierKey(name), name);
  }

  const { numbers, lastPerDay } = assignReceiptNumbers(
    sales.map((s) => ({ key: s.legacyId, soldAt: s.soldAt })),
    tz,
  );

  return {
    users,
    suppliers: [...suppliers.values()],
    medicines: [...medicines.values()],
    batches,
    sales: sales.map((s) => ({ ...s, receiptNumber: numbers.get(s.legacyId)! })),
    purchases,
    returns,
    receiptDays: lastPerDay,
    source: {
      counts: {
        users: src.users.length,
        medicines: src.medicines.length,
        purchases: src.purchases.length,
        sales: src.sales.length,
        billsequences: src.billSequenceDays,
      },
      saleLines,
      returnLines,
      salesPaisa,
      returnsPaisa,
      returnCount,
      rawTotalPrice,
      rejectedSalesPaisa,
      rejectedSaleCount,
      rejectedReturnsPaisa,
      rejectedReturnCount,
      stockByMedicine: new Map(
        src.medicines.map((m) => [
          m.id,
          {
            name: typeof m.name === 'string' ? m.name.trim() : '',
            quantity: typeof m.quantity === 'number' ? m.quantity : NaN,
          },
        ]),
      ),
    },
  } satisfies Plan;
}

// ─── Loading ────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;
type RunBatch = (write: (tx: Tx) => Promise<void>) => Promise<void>;

/** Ids of rows already loaded by an earlier (committed) run, by `source|legacyId|entity`. */
type IdMap = Map<string, string>;
const mapKey = (source: string, legacyId: string, entity: string) =>
  `${source}|${legacyId}|${entity}`;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) out.push(rows.slice(i, i + batchSize));
  return out;
}

const money = (p: Paisa) => formatPaisa(p);

async function load(p: Plan, ids: IdMap, runBatch: RunBatch, actorName: string | undefined) {
  /** Our id for a legacy row, reusing the one from an earlier run. */
  const idOf = (source: string, legacyId: string, entity: string) => {
    const k = mapKey(source, legacyId, entity);
    let id = ids.get(k);
    const isNew = !id;
    if (!id) {
      id = randomUUID();
      ids.set(k, id);
    }
    return { id, isNew };
  };

  let actorId: string | null = null;

  /** Writes one batch of rows plus their LegacyIdMap rows and one audit entry. */
  async function writeBatch(
    entity: string,
    links: { source: string; legacyId: string; newId: string; entity?: string }[],
    write: (tx: Tx) => Promise<void>,
  ) {
    await runBatch(async (tx) => {
      await write(tx);
      await tx.legacyIdMap.createMany({
        data: links.map((l) => ({
          source: l.source,
          legacyId: l.legacyId,
          entity: l.entity ?? entity,
          newId: l.newId,
        })),
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: 'LEGACY_IMPORT',
          entityType: entity,
          after: { rows: links.length, from: links[0]?.legacyId, to: links.at(-1)?.legacyId },
        },
      });
    });
  }

  const progress = (label: string, done: number, total: number) =>
    process.stdout.write(`\r  ${label.padEnd(22)} ${done}/${total}   `);

  // Roles (the seed isn't run on a migration target).
  const roles = new Map<RoleCode, string>();
  await runBatch(async (tx) => {
    for (const code of Object.values(RoleCode)) {
      const role = await tx.role.upsert({
        where: { code },
        update: {},
        create: { code, name: ROLE_NAMES[code] },
      });
      roles.set(code, role.id);
    }
  });

  // Users.
  const userRows = p.users.map((u) => ({ u, ...idOf(u.source, u.legacyId, 'User') }));
  const newUsers = userRows.filter((r) => r.isNew);
  for (const chunk of chunks(newUsers)) {
    await writeBatch(
      'User',
      chunk.map((r) => ({ source: r.u.source, legacyId: r.u.legacyId, newId: r.id })),
      (tx) =>
        tx.user
          .createMany({
            data: chunk.map(({ u, id }) => ({
              id,
              username: u.username,
              fullName: u.fullName,
              email: u.email,
              passwordHash: u.passwordHash,
              roleId: roles.get(u.role)!,
              status: u.active ? 'ACTIVE' : 'INACTIVE',
              createdAt: u.createdAt,
            })),
          })
          .then(() => undefined),
    );
  }
  console.log(
    `  users                  ${newUsers.length} new, ${userRows.length - newUsers.length} already loaded`,
  );
  const userIdOf = new Map(userRows.map((r) => [r.u.legacyId, r.id]));

  // Who the stock movements and audit entries are recorded under.
  await runBatch(async (tx) => {
    const actor = await tx.user.findFirst({
      where: actorName
        ? { username: actorName.toLowerCase() }
        : { status: 'ACTIVE', role: { code: RoleCode.ADMIN } },
      orderBy: { createdAt: 'asc' },
    });
    if (!actor)
      fail(
        actorName
          ? `--actor ${actorName}: no such user`
          : 'No active admin to record the import under; pass --actor',
      );
    actorId = actor.id;
    console.log(`  recorded as            ${actor.username}`);
  });

  // Category and suppliers.
  const category = idOf('migration', 'category', 'Category');
  if (category.isNew) {
    await writeBatch(
      'Category',
      [{ source: 'migration', legacyId: 'category', newId: category.id }],
      (tx) =>
        tx.category
          .create({ data: { id: category.id, name: CATEGORY_NAME } })
          .then(() => undefined),
    );
  }
  const supplierRows = p.suppliers.map((name) => ({
    name,
    ...idOf('medicines.supplier', supplierKey(name), 'Supplier'),
  }));
  for (const chunk of chunks(supplierRows.filter((r) => r.isNew))) {
    await writeBatch(
      'Supplier',
      chunk.map((r) => ({
        source: 'medicines.supplier',
        legacyId: supplierKey(r.name),
        newId: r.id,
      })),
      (tx) =>
        tx.supplier
          .createMany({ data: chunk.map((r) => ({ id: r.id, name: r.name })) })
          .then(() => undefined),
    );
  }
  console.log(`  category + suppliers   1 + ${supplierRows.length}`);
  const supplierIdOf = new Map(supplierRows.map((r) => [supplierKey(r.name), r.id]));

  // Medicines.
  const medicineRows = p.medicines.map((m) => ({
    m,
    ...idOf('medicines', m.legacyId, 'Medicine'),
  }));
  const newMedicines = medicineRows.filter((r) => r.isNew);
  let done = 0;
  for (const chunk of chunks(newMedicines)) {
    await writeBatch(
      'Medicine',
      chunk.map((r) => ({ source: 'medicines', legacyId: r.m.legacyId, newId: r.id })),
      (tx) =>
        tx.medicine
          .createMany({
            data: chunk.map(({ m, id }) => ({
              id,
              name: m.name,
              categoryId: category.id,
              unit: m.unit,
              sellingPrice: money(m.sellingPrice),
              status: m.active ? 'ACTIVE' : 'INACTIVE',
              createdAt: m.createdAt,
            })),
          })
          .then(() => undefined),
    );
    progress('medicines', (done += chunk.length), newMedicines.length);
  }
  console.log();
  const medicineIdOf = new Map(medicineRows.map((r) => [r.m.legacyId, r.id]));

  // Batches with their opening stock.
  const batchRows = p.batches.map((b) => ({ b, ...idOf('medicines', b.legacyId, 'Batch') }));
  const newBatches = batchRows.filter((r) => r.isNew);
  done = 0;
  for (const chunk of chunks(newBatches)) {
    await writeBatch(
      'Batch',
      chunk.map((r) => ({ source: 'medicines', legacyId: r.b.legacyId, newId: r.id })),
      async (tx) => {
        await tx.batch.createMany({
          data: chunk.map(({ b, id }) => ({
            id,
            medicineId: medicineIdOf.get(b.medicineLegacyId)!,
            supplierId: supplierIdOf.get(supplierKey(b.supplier))!,
            batchNumber: b.batchNumber,
            expiryDate: fromDateOnly(b.expiryDate),
            costPrice: money(b.costPrice),
            quantityReceived: b.quantityReceived,
            createdAt: b.createdAt,
          })),
        });
        await tx.stockMovement.createMany({
          data: chunk
            .filter(({ b }) => b.openingQuantity > 0)
            .map(({ b, id }) => ({
              batchId: id,
              type: 'ADJUSTMENT' as const,
              quantity: b.openingQuantity,
              reason: OPENING_STOCK_REASON,
              userId: actorId!,
              createdAt: runStartedAt,
            })),
        });
      },
    );
    progress('batches + stock', (done += chunk.length), newBatches.length);
  }
  console.log();
  const batchIdOf = new Map(batchRows.map((r) => [r.b.medicineLegacyId, r.id]));

  // Sales with lines and one cash payment each (the old system kept no tender).
  const saleRows = p.sales.map((s) => ({ s, ...idOf('sales', s.legacyId, 'Sale') }));
  const newSales = saleRows.filter((r) => r.isNew);
  done = 0;
  for (const chunk of chunks(newSales)) {
    await writeBatch(
      'Sale',
      chunk.map((r) => ({ source: 'sales', legacyId: r.s.legacyId, newId: r.id })),
      async (tx) => {
        await tx.sale.createMany({
          data: chunk.map(({ s, id }) => ({
            id,
            receiptNumber: s.receiptNumber,
            status: 'COMPLETED' as const,
            cashierId: userIdOf.get(s.cashierLegacyId)!,
            subtotal: money(s.subtotal),
            discountTotal: money(s.discountTotal),
            grandTotal: money(s.grandTotal),
            notes: s.notes,
            soldAt: s.soldAt,
            createdAt: s.soldAt,
          })),
        });
        await tx.saleItem.createMany({
          data: chunk.flatMap(({ s, id }) =>
            s.lines.map((l, i) => ({
              saleId: id,
              lineNo: i + 1,
              batchId: batchIdOf.get(l.medicineLegacyId)!,
              quantity: l.quantity,
              unitPrice: money(l.unitPrice),
              discount: money(l.discount),
              lineTotal: money(l.lineTotal),
            })),
          ),
        });
        await tx.payment.createMany({
          data: chunk.map(({ s, id }) => ({
            saleId: id,
            method: 'CASH' as const,
            amount: money(s.grandTotal),
            createdAt: s.soldAt,
          })),
        });
      },
    );
    progress('sales', (done += chunk.length), newSales.length);
  }
  console.log();

  // Delivery history: no stock movements, the opening stock already includes it.
  const purchaseRows = p.purchases.map((x) => ({
    x,
    ...idOf('purchases', x.legacyId, 'LegacyPurchase'),
  }));
  const newPurchases = purchaseRows.filter((r) => r.isNew);
  done = 0;
  for (const chunk of chunks(newPurchases)) {
    await writeBatch(
      'LegacyPurchase',
      chunk.map((r) => ({ source: 'purchases', legacyId: r.x.legacyId, newId: r.id })),
      (tx) =>
        tx.legacyPurchase
          .createMany({
            data: chunk.map(({ x, id }) => ({
              id,
              batchId: batchIdOf.get(x.medicineLegacyId)!,
              supplierId: supplierIdOf.get(supplierKey(x.supplier))!,
              quantity: x.quantity,
              totalCost: x.totalCost === null ? null : money(x.totalCost),
              purchasedAt: x.purchasedAt,
              createdAt: x.purchasedAt,
            })),
          })
          .then(() => undefined),
    );
    progress('purchases (history)', (done += chunk.length), newPurchases.length);
  }
  console.log();

  // Returns: history only, against the batch each line names.
  const returnRows = p.returns.map((r) => ({ r, ...idOf('sales', r.legacyId, 'LegacyReturn') }));
  const newReturns = returnRows.filter((r) => r.isNew);
  done = 0;
  for (const chunk of chunks(newReturns)) {
    await writeBatch(
      'LegacyReturn',
      chunk.map((row) => ({ source: 'sales', legacyId: row.r.legacyId, newId: row.id })),
      async (tx) => {
        await tx.legacyReturn.createMany({
          data: chunk.map(({ r, id }) => ({
            id,
            cashierId: userIdOf.get(r.cashierLegacyId)!,
            refundTotal: money(r.refundTotal),
            returnedAt: r.returnedAt,
            createdAt: r.returnedAt,
          })),
        });
        await tx.legacyReturnItem.createMany({
          data: chunk.flatMap(({ r, id }) =>
            r.lines.map((l, i) => ({
              legacyReturnId: id,
              lineNo: i + 1,
              batchId: batchIdOf.get(l.medicineLegacyId)!,
              quantity: l.quantity,
              unitPrice: money(l.unitPrice),
              discount: money(l.discount),
              lineTotal: money(l.lineTotal),
            })),
          ),
        });
      },
    );
    progress('returns (history)', (done += chunk.length), newReturns.length);
  }
  console.log();

  // Receipt counters, so new sales on a migrated day continue its series.
  await runBatch(async (tx) => {
    for (const [day, last] of p.receiptDays) {
      await tx.$executeRaw`
        INSERT INTO "ReceiptCounter" ("series", "day", "lastNumber", "updatedAt")
        VALUES ('S', ${day}::date, ${last}, now())
        ON CONFLICT ("series", "day") DO UPDATE
          SET "lastNumber" = GREATEST("ReceiptCounter"."lastNumber", EXCLUDED."lastNumber"), "updatedAt" = now()`;
    }
  });
}

// ─── Verification ───────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('en-US');
const pkr = (p: Paisa) => {
  const [whole, fraction] = formatPaisa(p).split('.') as [string, string];
  return `${BigInt(whole).toLocaleString('en-US')}.${fraction}`;
};

async function verify(db: Tx | PrismaClient, p: Plan): Promise<string[]> {
  const count = async (entity: string) => db.legacyIdMap.count({ where: { entity } });
  const [users, medicines, batches, sales, purchases, returns] = await Promise.all(
    ['User', 'Medicine', 'Batch', 'Sale', 'LegacyPurchase', 'LegacyReturn'].map(count),
  );
  // The target was empty, so every legacy history row came from this script.
  const [history] = await db.$queryRaw<
    {
      returnLines: bigint;
      returnUnits: bigint | null;
      refunded: Prisma.Decimal | null;
      returnLineTotal: Prisma.Decimal | null;
      purchasedUnits: bigint | null;
      priced: bigint;
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM "LegacyReturnItem") AS "returnLines",
      (SELECT SUM("quantity") FROM "LegacyReturnItem") AS "returnUnits",
      (SELECT SUM("refundTotal") FROM "LegacyReturn") AS "refunded",
      (SELECT SUM("lineTotal") FROM "LegacyReturnItem") AS "returnLineTotal",
      (SELECT SUM("quantity") FROM "LegacyPurchase") AS "purchasedUnits",
      (SELECT COUNT(*) FROM "LegacyPurchase" WHERE "totalCost" IS NOT NULL) AS "priced"`;
  const [totals] = await db.$queryRaw<
    {
      lines: bigint;
      units: bigint | null;
      payments: bigint;
      grand: Prisma.Decimal | null;
      paid: Prisma.Decimal | null;
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM "SaleItem" si JOIN "LegacyIdMap" l ON l."newId" = si."saleId" AND l."entity" = 'Sale') AS "lines",
      (SELECT SUM(si."quantity") FROM "SaleItem" si JOIN "LegacyIdMap" l ON l."newId" = si."saleId" AND l."entity" = 'Sale') AS "units",
      (SELECT COUNT(*) FROM "Payment" pm JOIN "LegacyIdMap" l ON l."newId" = pm."saleId" AND l."entity" = 'Sale') AS "payments",
      (SELECT SUM(s."grandTotal") FROM "Sale" s JOIN "LegacyIdMap" l ON l."newId" = s."id" AND l."entity" = 'Sale') AS "grand",
      (SELECT SUM(pm."amount") FROM "Payment" pm JOIN "LegacyIdMap" l ON l."newId" = pm."saleId" AND l."entity" = 'Sale') AS "paid"`;
  const movements = await db.stockMovement.count({ where: { reason: OPENING_STOCK_REASON } });
  const stockRows = await db.$queryRaw<{ legacyId: string; name: string; qty: bigint }[]>`
    SELECT l."legacyId", m."name", COALESCE(SUM(sm."quantity"), 0) AS "qty"
    FROM "LegacyIdMap" l
    JOIN "Medicine" m ON m."id" = l."newId"
    LEFT JOIN "Batch" b ON b."medicineId" = m."id"
    LEFT JOIN "StockMovement" sm ON sm."batchId" = b."id"
    WHERE l."source" = 'medicines' AND l."entity" = 'Medicine'
    GROUP BY l."legacyId", m."name"`;

  const paisaOf = (d: Prisma.Decimal | null | undefined) =>
    d ? BigInt(d.mul(100).toFixed(0)) : 0n;
  const loadedPaisa = paisaOf(totals?.grand);
  const paidPaisa = paisaOf(totals?.paid);
  const refundedPaisa = paisaOf(history?.refunded);
  const s = p.source;
  const placeholderMeds = p.medicines.filter((m) => m.placeholder).length;
  const placeholderUsers = p.users.filter((u) => !u.active).length;
  const rejected = (prefix: string) =>
    [...rejectCounts].filter(([k]) => k.startsWith(prefix + ' ')).reduce((a, [, n]) => a + n, 0);

  // Stock per medicine: Mongo quantity vs sum of movements.
  const pg = new Map(stockRows.map((r) => [r.legacyId, Number(r.qty)]));
  const csv = ['mongo_id,name,mongo_quantity,postgres_stock,match'];
  let matched = 0;
  const mismatches: string[] = [];
  let mongoUnits = 0;
  for (const [id, m] of s.stockByMedicine) {
    mongoUnits += Number.isFinite(m.quantity) ? m.quantity : 0;
    const got = pg.get(id);
    const ok = got === m.quantity;
    if (ok) matched++;
    else
      mismatches.push(
        `    ${m.name.padEnd(32)} Mongo ${m.quantity}, Postgres ${got ?? 'not loaded'}`,
      );
    csv.push([id, JSON.stringify(m.name), m.quantity, got ?? '', ok ? 'yes' : 'NO'].join(','));
  }
  writeFileSync(path.join(outDir, 'stock-per-medicine.csv'), csv.join('\n') + '\n');
  const pgUnits = [...pg.values()].reduce((a, n) => a + n, 0);

  const check = (ok: boolean) => (ok ? '✓' : '✖');
  const salesBalance = loadedPaisa + s.rejectedSalesPaisa === s.salesPaisa;
  const returnsBalance = refundedPaisa + s.rejectedReturnsPaisa === s.returnsPaisa;
  const purchasesBalance = purchases! + rejected('purchases') === s.counts.purchases;
  const returnLinesOver = paisaOf(history?.returnLineTotal) - refundedPaisa;
  const row = (label: string, mongo: string, pgv: string, note = '') =>
    `  ${label.padEnd(18)}${mongo.padStart(12)}${pgv.padStart(12)}   ${note}`;

  return [
    'Row counts',
    row('', 'Mongo', 'Postgres'),
    row(
      'users',
      fmt(s.counts.users!),
      fmt(users!),
      `incl. ${placeholderUsers} placeholder(s); ${rejected('users')} rejected`,
    ),
    row(
      'medicines',
      fmt(s.counts.medicines!),
      fmt(medicines!),
      `incl. ${placeholderMeds} placeholders for deleted medicines; ${rejected('medicines')} rejected`,
    ),
    row('batches', '—', fmt(batches!), 'one per medicine that was ever stocked or sold'),
    row('stock movements', '—', fmt(movements), 'opening stock, one per batch with stock'),
    row(
      'purchases',
      fmt(s.counts.purchases!),
      fmt(purchases!),
      `history only, no stock movements; ${fmt(Number(history?.priced ?? 0))} with a price; ${rejected('purchases')} rejected`,
    ),
    row(
      'sales',
      fmt(s.counts.sales! - s.returnCount),
      fmt(sales!),
      `"sales" documents that aren't returns; ${s.rejectedSaleCount} rejected`,
    ),
    row(
      'sale lines',
      fmt(s.saleLines),
      fmt(Number(totals?.lines ?? 0)),
      `${fmt(Number(totals?.units ?? 0))} units`,
    ),
    row(
      'returns',
      fmt(s.returnCount),
      fmt(returns!),
      `negative "sales": history only, not in reports; ${s.rejectedReturnCount} rejected`,
    ),
    row(
      'return lines',
      fmt(s.returnLines),
      fmt(Number(history?.returnLines ?? 0)),
      `${fmt(Number(history?.returnUnits ?? 0))} units`,
    ),
    row('payments', '—', fmt(Number(totals?.payments ?? 0)), 'one CASH payment per sale'),
    row('billsequences', fmt(s.counts.billsequences!), '—', 'not copied; receipt counters rebuilt'),
    '',
    'Sales amount (PKR)',
    `  Mongo Σ totalPrice, all documents     ${pkr(s.salesPaisa - s.returnsPaisa).padStart(16)}   (raw float sum ${s.rawTotalPrice})`,
    `  − returns (negative "sales")          ${pkr(-s.returnsPaisa).padStart(16)}   ${s.returnCount} documents, checked below`,
    `  = Mongo sales                         ${pkr(s.salesPaisa).padStart(16)}`,
    `  Postgres Σ Sale.grandTotal            ${pkr(loadedPaisa).padStart(16)}`,
    `  + rejected sales                      ${pkr(s.rejectedSalesPaisa).padStart(16)}   ${s.rejectedSaleCount} documents`,
    `  ${check(salesBalance)} loaded + rejected = Mongo sales   ${salesBalance ? '' : `(off by ${pkr(s.salesPaisa - loadedPaisa - s.rejectedSalesPaisa)})`}`,
    `  ${check(paidPaisa === loadedPaisa)} payments = sale totals (${pkr(paidPaisa)})`,
    '',
    'Returns amount (PKR), history only',
    `  Mongo returns                         ${pkr(s.returnsPaisa).padStart(16)}`,
    `  Postgres Σ LegacyReturn.refundTotal   ${pkr(refundedPaisa).padStart(16)}`,
    `  + rejected returns                    ${pkr(s.rejectedReturnsPaisa).padStart(16)}   ${s.rejectedReturnCount} documents`,
    `  ${check(returnsBalance)} loaded + rejected = Mongo returns   ${returnsBalance ? '' : `(off by ${pkr(s.returnsPaisa - refundedPaisa - s.rejectedReturnsPaisa)})`}`,
    returnLinesOver === 0n
      ? `  ✓ return lines add up to the refunds`
      : `  ! return lines are ${pkr(returnLinesOver)} above the refunds (refunds above their lines: warnings.jsonl, RETURN_TOTAL_ABOVE_LINES)`,
    '',
    'Purchases (delivery history)',
    `  ${check(purchasesBalance)} loaded ${fmt(purchases!)} + rejected ${fmt(rejected('purchases'))} = Mongo ${fmt(s.counts.purchases!)}; ${fmt(Number(history?.purchasedUnits ?? 0))} units`,
    '',
    'Stock per medicine (full list: stock-per-medicine.csv)',
    `  ${check(mismatches.length === 0)} ${matched} of ${s.stockByMedicine.size} medicines match; total units Mongo ${fmt(mongoUnits)}, Postgres ${fmt(pgUnits)}`,
    ...mismatches,
  ];
}

// ─── Main ───────────────────────────────────────────────────────────────────

class DryRunRollback extends Error {}

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? fail('DATABASE_URL is not set'));
  if (target.pathname.endsWith('_test')) fail('Refusing to load into the test database');
  console.log(
    `${dryRun ? 'DRY RUN (rolled back at the end)' : 'COMMIT'} → Postgres ${target.hostname}:${target.port}${target.pathname}`,
  );
  console.log(`Logs → ${outDir}\n`);

  const src = await readMongo();
  const prisma = new PrismaClient();
  try {
    // A fresh target, or one this script already loaded into (resume).
    const ids: IdMap = new Map(
      (await prisma.legacyIdMap.findMany()).map((l) => [
        mapKey(l.source, l.legacyId, l.entity),
        l.newId,
      ]),
    );
    if (ids.size === 0) {
      const [medicines, sales, suppliers, categories] = await Promise.all([
        prisma.medicine.count(),
        prisma.sale.count(),
        prisma.supplier.count(),
        prisma.category.count(),
      ]);
      if (medicines + sales + suppliers + categories > 0) {
        fail(
          `The target already has data (${medicines} medicines, ${sales} sales, ${suppliers} suppliers, ` +
            `${categories} categories). Load into an empty database (migrations applied, no seed).`,
        );
      }
    } else {
      console.log(`Resuming: ${ids.size} rows already loaded will be skipped.`);
    }
    const legacyUserIds = new Set(
      [...ids].filter(([k]) => k.endsWith('|User')).map(([, id]) => id),
    );
    const others = (
      await prisma.user.findMany({ select: { id: true, username: true, email: true } })
    ).filter((u) => !legacyUserIds.has(u.id));

    console.log('Mapping documents…');
    const p = await plan(
      src,
      new Set(others.map((u) => u.username.toLowerCase())),
      new Set(others.flatMap((u) => (u.email ? [u.email.toLowerCase()] : []))),
    );

    console.log(`Loading in batches of ${batchSize}…`);
    let report: string[] = [];
    if (dryRun) {
      await prisma
        .$transaction(
          async (tx) => {
            await load(p, ids, (write) => write(tx), args.actor);
            report = await verify(tx, p);
            throw new DryRunRollback();
          },
          { timeout: 60 * 60_000, maxWait: 30_000 },
        )
        .catch((e: unknown) => {
          if (!(e instanceof DryRunRollback)) throw e;
        });
    } else {
      await load(
        p,
        ids,
        (write) => prisma.$transaction(write, { timeout: 5 * 60_000 }),
        args.actor,
      );
      report = await verify(prisma, p);
    }

    const rejectLines = [...rejectCounts].sort().map(([k, n]) => `  ${k.padEnd(48)} ${fmt(n)}`);
    const warnLines = [...warnCounts].sort().map(([k, n]) => `  ${k.padEnd(48)} ${fmt(n)}`);
    const summary = [
      `${dryRun ? 'DRY RUN — nothing was saved' : 'COMMITTED'}  (${new Date().toISOString()})`,
      '',
      ...report,
      '',
      `Rejected (details: rejects.jsonl)`,
      ...(rejectLines.length ? rejectLines : ['  none']),
      '',
      `Warnings (details: warnings.jsonl)`,
      ...(warnLines.length ? warnLines : ['  none']),
    ];
    writeFileSync(path.join(outDir, 'verification.txt'), summary.join('\n') + '\n');
    console.log('\n' + summary.join('\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
