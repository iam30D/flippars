import type { PricePosition } from "@flippars/contracts";

import { parsePositiveDecimal, requireFinite } from "./math.js";

export function classifyPricePosition(
  currentPrice: string | number,
  openPrice: string | number,
  deadbandBps: number,
): PricePosition {
  const current =
    typeof currentPrice === "string"
      ? parsePositiveDecimal(currentPrice, "currentPrice")
      : currentPrice;
  const open =
    typeof openPrice === "string"
      ? parsePositiveDecimal(openPrice, "openPrice")
      : openPrice;

  requireFinite(current, "currentPrice", Number.MIN_VALUE);
  requireFinite(open, "openPrice", Number.MIN_VALUE);
  requireFinite(deadbandBps, "deadbandBps", 0);

  const differenceBps = ((current - open) / open) * 10_000;
  if (Math.abs(differenceBps) <= deadbandBps) {
    return "AT_OPEN";
  }
  return differenceBps > 0 ? "ABOVE_OPEN" : "BELOW_OPEN";
}
