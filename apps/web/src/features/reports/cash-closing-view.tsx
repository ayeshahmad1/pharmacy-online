import {
  PAYMENT_METHODS,
  type CashFlowDto,
  type MethodAmounts,
  type PaymentMethod,
} from '@pharmacy/shared';
import { AlertTriangleIcon } from 'lucide-react';
import { Link } from 'react-router';
import { ListToolbar } from '@/components/data/filters';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { reportsApi } from './reports-api';
import type { ReportParams } from './reports-page';
import {
  ExportButton,
  MoneyCell,
  Num,
  NumHead,
  ReportState,
  Section,
  StatGrid,
  StatTile,
  isLoss,
  useReport,
} from './report-parts';
import { localToday } from './report-range';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  MOBILE_WALLET: 'Wallet',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function FlowRow({ label, flow, sign }: { label: string; flow: MethodAmounts; sign?: '−' }) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        {sign && <span className="mr-1 text-muted-foreground">{sign}</span>}
        {label}
      </TableCell>
      {PAYMENT_METHODS.map((m) => (
        <Num key={m}>{formatMoney(flow[m])}</Num>
      ))}
    </TableRow>
  );
}

const count = (flow: CashFlowDto, one: string, many: string) =>
  `${flow.count} ${flow.count === 1 ? one : many}`;

/**
 * End-of-day drawer check. Follows the money: a sale counts on the day it
 * was rung up, a void or refund on the day the money went back.
 */
export function CashClosingView({ params }: { params: ReportParams }) {
  const { update } = params;
  const today = localToday();
  const date = DATE.test(params.params.filters.date) ? params.params.filters.date : today;
  const query = { date };
  const report = useReport('cash-closing', query, reportsApi.cashClosing);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="cash-closing" query={query} />}>
        <Input
          type="date"
          aria-label="Business day"
          value={date}
          max={today}
          onChange={(e) =>
            e.target.value && update({ date: e.target.value === today ? '' : e.target.value })
          }
          className="w-full sm:w-44"
        />
      </ListToolbar>

      <ReportState query={report}>
        {(data) => (
          <>
            <StatGrid>
              <StatTile
                label="Expected cash in drawer"
                value={formatMoney(data.expectedCash)}
                tone={isLoss(data.expectedCash) ? 'bad' : undefined}
                sub="Plus any opening float"
              />
              <StatTile
                label="Taken on sales"
                value={formatMoney(data.sales.total)}
                sub={count(data.sales, 'sale', 'sales')}
              />
              <StatTile
                label="Voids paid back"
                value={formatMoney(data.voids.total)}
                tone={data.voids.count > 0 ? 'warn' : undefined}
                sub={count(data.voids, 'void', 'voids')}
              />
              <StatTile
                label="Refunds paid out"
                value={formatMoney(data.refunds.total)}
                sub={count(data.refunds, 'return', 'returns')}
              />
            </StatGrid>

            {(data.pendingReturns.count > 0 || data.openOfflineConflicts.count > 0) && (
              <div
                role="status"
                className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <AlertTriangleIcon className="mt-0.5 size-5 shrink-0" />
                <ul className="space-y-1">
                  {data.openOfflineConflicts.count > 0 && (
                    <li>
                      {data.openOfflineConflicts.count} offline sale(s) from this day (
                      {formatMoney(data.openOfflineConflicts.expectedTotal)} charged) were refused
                      at sync and are not in these figures.{' '}
                      <Link to="/offline-sales" className="font-medium underline">
                        Review them
                      </Link>
                    </li>
                  )}
                  {data.pendingReturns.count > 0 && (
                    <li>
                      {data.pendingReturns.count} return(s) are waiting for approval (
                      {formatMoney(data.pendingReturns.refundTotal)}); their refunds count on the
                      day they are approved.
                    </li>
                  )}
                </ul>
              </div>
            )}

            <Section
              title={`Drawer for ${formatDate(data.date)}`}
              description={`Worked out ${formatDateTime(data.generatedAt)}. Cash taken ${formatMoney(data.sales.cashTendered)}, change given ${formatMoney(data.sales.changeGiven)}.`}
            >
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead />
                      {PAYMENT_METHODS.map((m) => (
                        <NumHead key={m}>{METHOD_LABELS[m]}</NumHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <FlowRow label="Sales" flow={data.sales.byMethod} />
                    <FlowRow label="Voids" flow={data.voids.byMethod} sign="−" />
                    <FlowRow label="Refunds" flow={data.refunds.byMethod} sign="−" />
                    <TableRow className="bg-muted/50 font-semibold hover:bg-muted/50">
                      <TableCell>Net</TableCell>
                      {PAYMENT_METHODS.map((m) => (
                        <MoneyCell key={m} amount={data.net[m]} strong />
                      ))}
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </Section>

            {data.people.length > 0 && (
              <Section
                title="By person"
                description="Sales by who rang them up; voids and refunds by who paid the money back."
              >
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <NumHead>Sales</NumHead>
                        <NumHead className="hidden sm:table-cell">Voids</NumHead>
                        <NumHead className="hidden sm:table-cell">Refunds</NumHead>
                        <NumHead className="hidden md:table-cell">Card</NumHead>
                        <NumHead className="hidden md:table-cell">Wallet</NumHead>
                        <NumHead>Cash to hand in</NumHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.people.map((p) => (
                        <TableRow key={p.user.id}>
                          <TableCell className="font-medium">
                            {p.user.fullName}
                            <p className="text-xs text-muted-foreground">@{p.user.username}</p>
                          </TableCell>
                          <Num>
                            {formatMoney(p.sales.total)}
                            <p className="text-xs text-muted-foreground">{p.sales.count} sales</p>
                          </Num>
                          <Num className="hidden sm:table-cell">{formatMoney(p.voids.total)}</Num>
                          <Num className="hidden sm:table-cell">{formatMoney(p.refunds.total)}</Num>
                          <Num className="hidden md:table-cell">{formatMoney(p.net.CARD)}</Num>
                          <Num className="hidden md:table-cell">
                            {formatMoney(p.net.MOBILE_WALLET)}
                          </Num>
                          <MoneyCell amount={p.expectedCash} strong />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Section>
            )}
          </>
        )}
      </ReportState>
    </div>
  );
}
