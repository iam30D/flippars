const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export const formatUsd = (value: number | null): string =>
  value === null || !Number.isFinite(value)
    ? "Unavailable"
    : usdFormatter.format(value);

export const formatSignedUsd = (value: number): string => {
  if (!Number.isFinite(value)) return "Unavailable";
  const magnitude = usdFormatter.format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${magnitude}`;
};

export const formatPercent = (fraction: number, maximumFractionDigits = 0): string => {
  if (!Number.isFinite(fraction)) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits,
  }).format(Math.min(1, Math.max(0, fraction)));
};

export const formatObservedTime = (iso: string | null): string => {
  if (!iso) return "Not yet received";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : "Unknown time";
};

export const relativeDelta = (opening: number, current: number): number => {
  if (!Number.isFinite(opening) || !Number.isFinite(current) || opening === 0) return 0;
  return (current - opening) / opening;
};
