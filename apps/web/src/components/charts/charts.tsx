import type { ReactNode } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartMoney, compactMoney } from './chart-values';

// Shared chart look: thin marks, hairline grid, one y-axis, money in paisa
// (see chart-values.ts). Series colours come from --chart-1/--chart-2 so
// light and dark mode each get their own validated steps. Text always uses
// the text tokens, never a series colour.

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 12 };

export type LegendItem = { label: string; color: string; shape?: 'area' | 'line' };

/** HTML legend above the plot; the swatch carries identity, the text stays ink. */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span
            aria-hidden
            className={item.shape === 'line' ? 'h-0.5 w-4 rounded-full' : 'size-3 rounded-sm'}
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function TooltipBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-2 text-muted-foreground">
        {color && (
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: color }} />
        )}
        {label}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export type TrendPoint = {
  label: string;
  /** Paisa. */
  revenue: number;
  /** Paisa; can be negative. */
  profit: number;
  saleCount: number;
};

type TrendTooltipProps = { active?: boolean; payload?: readonly { payload?: TrendPoint }[] };

function TrendTooltip({ active, payload }: TrendTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <TooltipBox title={point.label}>
      <TooltipRow color="var(--chart-1)" label="Revenue" value={chartMoney(point.revenue)} />
      <TooltipRow color="var(--chart-2)" label="Gross profit" value={chartMoney(point.profit)} />
      <TooltipRow label="Sales" value={point.saleCount.toLocaleString()} />
    </TooltipBox>
  );
}

/** Revenue (area) and gross profit (line) over time, on one money axis. */
export function TrendChart({ data, height = 260 }: { data: TrendPoint[]; height?: number }) {
  return (
    <div className="space-y-3">
      <ChartLegend
        items={[
          { label: 'Revenue', color: 'var(--chart-1)' },
          { label: 'Gross profit', color: 'var(--chart-2)', shape: 'line' },
        ]}
      />
      <div style={{ height }} role="img" aria-label="Revenue and gross profit over time">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              tick={axisTick}
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-axis)' }}
              minTickGap={24}
            />
            <YAxis
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              tickFormatter={compactMoney}
              width={44}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'var(--chart-axis)' }} />
            <Area
              type="linear"
              dataKey="revenue"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="var(--chart-1)"
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="profit"
              stroke="var(--chart-2)"
              strokeWidth={2}
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type BarPoint = {
  label: string;
  /** What the bar length encodes (paisa for money). */
  value: number;
  /** Shown at the bar tip and in the tooltip. */
  display: string;
  /** Extra tooltip line, e.g. "42 units". */
  detail?: string;
};

type BarTooltipProps = { active?: boolean; payload?: readonly { payload?: BarPoint }[] };

function BarTooltip({ active, payload }: BarTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <TooltipBox title={point.label}>
      <TooltipRow color="var(--chart-1)" label="Total" value={point.display} />
      {point.detail && <p className="text-muted-foreground">{point.detail}</p>}
    </TooltipBox>
  );
}

/** One series of horizontal bars, largest first, value at each tip. */
export function BarListChart({ data, label }: { data: BarPoint[]; label: string }) {
  const height = Math.max(data.length * 40, 80);
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 96, bottom: 0, left: 0 }}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="label"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: 'var(--chart-axis)' }}
            width={128}
            tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
          />
          <Tooltip content={<BarTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.5 }} />
          <Bar
            dataKey="value"
            fill="var(--chart-1)"
            barSize={18}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
          >
            <LabelList dataKey="display" position="right" fill="var(--foreground)" fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
