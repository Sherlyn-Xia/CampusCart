export function hkd(cents) {
  return new Intl.NumberFormat("en-HK", {
    style: "currency",
    currency: "HKD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function assertCents(value, field = "amount") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer number of cents`);
  }
}

export function pointsToCents(points, centsPerPoint, redemptionStep) {
  const redeemable = Math.floor(points / redemptionStep) * redemptionStep;
  return { redeemable, cents: redeemable * centsPerPoint };
}
