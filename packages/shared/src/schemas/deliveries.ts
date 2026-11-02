import { z } from 'zod';
import { DELIVERY_STATUSES, type DeliveryStatus } from '../constants';
import { optionalTextSchema, paginationQuerySchema, searchTermSchema } from './common';
import { receiveStockItemSchema } from './inventory';
import { createMedicineBodySchema, type MedicineDto } from './medicines';
import type { SaleUserRef } from './sales';

/**
 * One batch on a delivery: a catalogue medicine (`medicineId`) or, when the
 * medicine is not in the catalogue yet, a proposed one (`newMedicine`), which
 * is created when the delivery is approved.
 */
const deliveryItemSchema = receiveStockItemSchema.extend({
  medicineId: z.uuid().optional(),
  newMedicine: createMedicineBodySchema.optional(),
});
export type DeliveryItemInput = z.infer<typeof deliveryItemSchema>;

/** The same medicine proposed on two lines must be described the same way. */
const sameProposal = (
  a: NonNullable<DeliveryItemInput['newMedicine']>,
  b: NonNullable<DeliveryItemInput['newMedicine']>,
) =>
  a.name.toLowerCase() === b.name.toLowerCase() &&
  (a.genericName ?? null) === (b.genericName ?? null) &&
  (a.barcode ?? null) === (b.barcode ?? null) &&
  a.categoryId === b.categoryId &&
  a.unit === b.unit &&
  a.reorderLevel === b.reorderLevel &&
  a.sellingPrice === b.sellingPrice;

/** A key per medicine: the catalogue id, or the proposed name. */
export const deliveryMedicineKey = (item: Pick<DeliveryItemInput, 'medicineId' | 'newMedicine'>) =>
  item.medicineId ?? `new:${item.newMedicine?.name.toLowerCase() ?? ''}`;

/**
 * One supplier delivery as entered on the Deliveries screen (create, and the
 * whole delivery again when it is corrected while pending).
 */
export const deliveryBodySchema = z
  .strictObject({
    supplierId: z.uuid(),
    /** Supplier's invoice or delivery-note number. */
    invoiceNumber: optionalTextSchema(100),
    items: z.array(deliveryItemSchema).min(1, 'Add at least one item').max(200),
  })
  .superRefine((body, ctx) => {
    const seenBatches = new Set<string>();
    const proposals = new Map<string, NonNullable<DeliveryItemInput['newMedicine']>>();
    const barcodes = new Map<string, string>();
    body.items.forEach((item, i) => {
      if ((item.medicineId === undefined) === (item.newMedicine === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'medicineId'],
          message: 'Choose a medicine, or describe the new one',
        });
        return;
      }

      const key = `${deliveryMedicineKey(item)}|${item.batchNumber}`;
      if (seenBatches.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'batchNumber'],
          message: 'The same batch of this medicine appears twice; combine the lines',
        });
      }
      seenBatches.add(key);

      const proposal = item.newMedicine;
      if (!proposal) return;
      const name = proposal.name.toLowerCase();
      const earlier = proposals.get(name);
      if (earlier && !sameProposal(earlier, proposal)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'newMedicine', 'name'],
          message: `"${proposal.name}" is described differently on another line; make them match`,
        });
      }
      proposals.set(name, proposal);
      if (proposal.barcode) {
        const owner = barcodes.get(proposal.barcode);
        if (owner !== undefined && owner !== name) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'newMedicine', 'barcode'],
            message: 'Another new medicine on this delivery has the same barcode',
          });
        }
        barcodes.set(proposal.barcode, name);
      }
    });
  });
export type DeliveryBody = z.infer<typeof deliveryBodySchema>;

export const rejectDeliveryBodySchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason for rejecting the delivery').max(500),
});
export type RejectDeliveryBody = z.infer<typeof rejectDeliveryBodySchema>;

export const listDeliveriesQuerySchema = paginationQuerySchema.extend({
  /** Invoice number or supplier name, or part of either (case-insensitive). */
  q: searchTermSchema.optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  /** Ignored for cashiers, who only ever see the deliveries they entered. */
  requestedById: z.uuid().optional(),
});
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;

/** A medicine proposed on a delivery line, as entered (kept after approval). */
export type ProposedMedicineDto = {
  name: string;
  genericName: string | null;
  barcode: string | null;
  category: { id: string; name: string };
  unit: string;
  reorderLevel: number;
  sellingPrice: string;
};

export type DeliveryItemDto = {
  id: string;
  lineNo: number;
  /** The catalogue medicine; null while a proposed new medicine waits for approval. */
  medicine: MedicineDto | null;
  /** Set when the line proposed a medicine that was not in the catalogue. */
  newMedicine: ProposedMedicineDto | null;
  batchNumber: string;
  /** "YYYY-MM-DD". */
  expiryDate: string;
  /** PKR per unit, as typed from the supplier's invoice. */
  costPrice: string;
  quantity: number;
  /** quantity × costPrice. */
  lineCost: string;
  /** The batch created on approval. */
  batchId: string | null;
};

export type DeliverySummaryDto = {
  id: string;
  status: DeliveryStatus;
  supplier: { id: string; name: string };
  invoiceNumber: string | null;
  requestedBy: SaleUserRef;
  requestedAt: string;
  reviewedBy: SaleUserRef | null;
  reviewedAt: string | null;
  lineCount: number;
  units: number;
  totalCost: string;
  /** Lines proposing a medicine that is not (or was not) in the catalogue. */
  newMedicineCount: number;
};

export type DeliveryDto = DeliverySummaryDto & {
  rejectionReason: string | null;
  /** The last approver who changed it while it was pending. */
  correctedBy: SaleUserRef | null;
  correctedAt: string | null;
  items: DeliveryItemDto[];
};
