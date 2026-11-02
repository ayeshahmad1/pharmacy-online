import type { DiscountType } from '@pharmacy/shared';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { FieldError } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { applyDiscount, type DiscountDraft } from './cart';
import { errorBeep } from './feedback';

export type DiscountTarget = {
  /** e.g. "Panadol 500mg × 2" or "Whole bill". */
  title: string;
  on: 'line' | 'bill';
  /** What the discount applies to, in paisa. */
  base: bigint;
  current: DiscountDraft | null;
  /** The server's last word on this discount, e.g. the cashier cap. */
  serverError?: string | null;
};

/** A cashier's limit on the whole bill's discounts; null for staff, who have none. */
export type DiscountLimit = {
  maxPercent: number;
  /** The most the bill's discounts may come to, in paisa. */
  cap: bigint;
  /** Whether the bill stays within the limit with this discount. */
  allows: (discount: DiscountDraft | null) => boolean;
};

const draftOf = (type: DiscountType, value: string): DiscountDraft | null =>
  value.trim() ? { type, value } : null;

/** What a value means while it is being typed: "10." is on its way to 10.5, but is 10 already. */
const typingDraft = (type: DiscountType, value: string) => draftOf(type, value.replace(/\.$/, ''));

/**
 * A discount as a PKR amount or a percentage. Typing "%" switches to percent
 * and "r" to rupees, so the keyboard never has to leave the box. Under a
 * cashier's limit, a keystroke that would take the bill's discounts past it
 * is refused, so an over-limit discount can't be entered at all.
 */
export function DiscountDialog({
  target,
  limit,
  onApply,
  onClose,
  onCloseAutoFocus,
}: {
  target: DiscountTarget;
  limit: DiscountLimit | null;
  onApply: (discount: DiscountDraft | null) => void;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [type, setType] = useState<DiscountType>(target.current?.type ?? 'PERCENT');
  const [value, setValue] = useState(target.current?.value ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [refused, setRefused] = useState(false);

  const draft = draftOf(type, value);
  const { amount, error } = applyDiscount(target.base, draft, target.on);
  const shownError = submitted || value.trim() ? error : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (error) return;
    onApply(draft);
  }

  /** Takes the typed value unless it would put the bill over the cashier's limit. */
  function changeValue(next: string) {
    if (limit && !limit.allows(typingDraft(type, next))) {
      errorBeep();
      setRefused(true);
      return;
    }
    setRefused(false);
    setValue(next);
  }

  /** Switching % ↔ Rs keeps the number only if it is still within the limit. */
  function changeType(next: DiscountType) {
    setType(next);
    if (limit && !limit.allows(typingDraft(next, value))) {
      setValue('');
      setRefused(true);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === '%') {
      event.preventDefault();
      changeType('PERCENT');
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      changeType('AMOUNT');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{target.on === 'bill' ? 'Bill discount' : 'Line discount'}</DialogTitle>
          <DialogDescription>
            {target.title} · {formatMoney(target.base)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Discount type">
            {(['PERCENT', 'AMOUNT'] as const).map((t) => (
              <Button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                variant={type === t ? 'default' : 'outline'}
                className="h-12 text-base"
                onClick={() => changeType(t)}
              >
                {t === 'PERCENT' ? 'Percent (%)' : 'Amount (Rs)'}
              </Button>
            ))}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="discount-value">
              {type === 'PERCENT' ? 'Percent off' : 'Rupees off'}
            </Label>
            <div className="relative">
              <Input
                id="discount-value"
                autoFocus
                inputMode="decimal"
                autoComplete="off"
                value={value}
                onChange={(e) => changeValue(e.target.value.replace(/[^\d.]/g, ''))}
                onKeyDown={onKeyDown}
                aria-invalid={!!(shownError ?? target.serverError)}
                placeholder={type === 'PERCENT' ? '10' : '50'}
                className={cn(
                  'h-14 text-right text-2xl tabular-nums',
                  type === 'PERCENT' ? 'pr-10' : 'pl-12',
                )}
              />
              <span
                className={cn(
                  'pointer-events-none absolute top-1/2 -translate-y-1/2 text-lg text-muted-foreground',
                  type === 'PERCENT' ? 'right-4' : 'left-4',
                )}
              >
                {type === 'PERCENT' ? '%' : 'Rs'}
              </span>
            </div>
            {shownError && <FieldError>{shownError}</FieldError>}
            {!shownError && target.serverError && <FieldError>{target.serverError}</FieldError>}
          </div>

          <dl className="grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-3 text-sm tabular-nums">
            <dt className="text-muted-foreground">Discount</dt>
            <dd className="text-right font-medium text-emerald-700 dark:text-emerald-400">
              −{formatMoney(amount)}
            </dd>
            <dt className="text-muted-foreground">After discount</dt>
            <dd className="text-right font-semibold">{formatMoney(target.base - amount)}</dd>
          </dl>

          {limit && (
            <p
              role={refused ? 'alert' : undefined}
              className={cn('text-sm', refused ? 'text-destructive' : 'text-muted-foreground')}
            >
              {refused && 'That’s more than you can give. '}
              {`All discounts on this bill together can be at most ${limit.maxPercent}% of it (${formatMoney(limit.cap)}). A pharmacist can give more.`}
            </p>
          )}

          <DialogFooter className="gap-2">
            {target.current && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                onClick={() => onApply(null)}
              >
                Remove discount
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
