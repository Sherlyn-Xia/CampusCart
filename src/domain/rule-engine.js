import { hkd, pointsToCents } from "./money.js";

function offerById(offers, id) {
  return offers.find((offer) => offer.id === id);
}

export function validateOffer(offer, { user, path, now }) {
  const reasons = [];
  if (!offer) return { eligible: false, reasons: ["Rule was not found"] };
  if (offer.verificationStatus !== "verified_demo") reasons.push("Rule is not verified for execution");
  if (new Date(now) < new Date(offer.validFrom)) reasons.push("Offer has not started");
  if (new Date(now) > new Date(offer.validUntil)) reasons.push("Offer has expired");
  if (offer.merchantId !== path.merchantId) reasons.push("Offer belongs to a different merchant");
  if (!offer.paymentRestrictions.includes(path.paymentMethodId)) reasons.push("Payment method is not accepted by this offer");
  if (path.productCents < offer.minimumSpendCents) reasons.push("Minimum spend is not met");
  if (offer.id.startsWith("EDU-") && (user.studentStatus !== "valid" || user.credentialStatus !== "active")) {
    reasons.push("Active student credential is required");
  }
  if (offer.id.startsWith("HT-STUDENT") && user.studentStatus !== "valid") reasons.push("Valid student status is required");
  return { eligible: reasons.length === 0, reasons };
}

function validateStack(offerList) {
  const reasons = [];
  for (const offer of offerList) {
    for (const other of offerList) {
      if (offer.id === other.id) continue;
      if (!offer.stackableWith.includes(other.id)) reasons.push(`${offer.id} cannot stack with ${other.id}`);
    }
  }
  return [...new Set(reasons)];
}

export function evaluatePath(path, { product, user, offers, policy, now }) {
  const reasons = [];
  if (path.sku !== product.sku) reasons.push("SKU does not match the requested product");
  if (!policy.acceptableMerchantIds.includes(path.merchantId)) reasons.push("Merchant is outside the user's allow-list");
  if (!policy.paymentMethodIds.includes(path.paymentMethodId)) reasons.push("Payment method is not authorized");

  const appliedOffers = path.appliedOfferIds.map((id) => offerById(offers, id));
  for (const offer of appliedOffers) {
    const verdict = validateOffer(offer, { user, path, now });
    reasons.push(...verdict.reasons);
  }
  reasons.push(...validateStack(appliedOffers));

  const discountCents = appliedOffers.reduce(
    (sum, offer) => sum + (offer?.kind === "product_discount" ? offer.valueCents : 0),
    0,
  );
  let pointsUsed = 0;
  let pointsValueCents = 0;
  if (path.points && policy.allowPoints) {
    const requested = Math.min(path.points.maxPoints, policy.maxPoints, user.pointsBalance);
    const redemption = pointsToCents(requested, path.points.centsPerPoint, path.points.redemptionStep);
    pointsUsed = redemption.redeemable;
    pointsValueCents = redemption.cents;
  }

  const cashOutCents = path.productCents + path.shippingCents - discountCents - pointsValueCents;
  const referenceCostCents = cashOutCents + pointsValueCents - path.rewardCents;
  if (Number.isInteger(policy.budgetCents) && cashOutCents > policy.budgetCents) {
    reasons.push(`Cash payment ${hkd(cashOutCents)} exceeds the user's ${hkd(policy.budgetCents)} budget`);
  }

  return {
    id: `plan-${path.id}`,
    pathId: path.id,
    merchantId: path.merchantId,
    merchant: path.merchant,
    channel: path.channel,
    sku: path.sku,
    fulfillment: path.fulfillment,
    paymentMethodId: path.paymentMethodId,
    appliedOffers: appliedOffers.map((offer) => ({ id: offer.id, version: offer.version, title: offer.title })),
    productCents: path.productCents,
    shippingCents: path.shippingCents,
    discountCents,
    pointsUsed,
    pointsValueCents,
    rewardCents: path.rewardCents,
    cashOutCents,
    referenceCostCents,
    eligible: reasons.length === 0,
    reasons,
    equation: `${hkd(path.productCents)} + ${hkd(path.shippingCents)} − ${hkd(discountCents)} − ${hkd(pointsValueCents)} points = ${hkd(cashOutCents)}`,
  };
}

export function evaluateOptions({ product, user, offers, paths, policy, now }) {
  const plans = paths.map((path) => evaluatePath(path, { product, user, offers, policy, now }));
  const eligiblePlans = plans
    .filter((plan) => plan.eligible)
    .sort((a, b) => a.referenceCostCents - b.referenceCostCents || a.cashOutCents - b.cashOutCents);
  const recommended = eligiblePlans[0] ?? null;
  const excludedOffers = offers
    .filter((offer) => !paths.some((path) => path.appliedOfferIds.includes(offer.id)))
    .map((offer) => {
      const matchingPath = paths.find((path) => path.merchantId === offer.merchantId) ?? paths[0];
      const verdict = validateOffer(offer, { user, path: matchingPath, now });
      return { offerId: offer.id, title: offer.title, reasons: verdict.reasons };
    })
    .filter((item) => item.reasons.length);

  return {
    plans,
    recommendedPlanId: recommended?.id ?? null,
    excludedOffers,
    evaluatedAt: now,
    objective: Number.isInteger(policy.budgetCents)
      ? "Lowest verified reference cost; cash payment remains a hard budget constraint"
      : "Comparison only by verified reference cost; no purchase authorization is permitted without a budget",
  };
}

export function precheck({ lock, finalQuote, currentOffers, now }) {
  const failures = [];
  if (lock.status !== "active") failures.push({ code: "LOCK_ALREADY_FINALIZED", message: "Benefit Lock has already been used or closed." });
  if (new Date(now) > new Date(lock.expiresAt)) failures.push({ code: "LOCK_EXPIRED", message: "Benefit Lock has expired." });
  if (lock.sku !== finalQuote.sku) failures.push({ code: "SKU_CHANGED", message: "The checkout SKU no longer matches the locked item." });
  if (lock.merchantId !== finalQuote.merchantId) failures.push({ code: "MERCHANT_CHANGED", message: "The checkout merchant no longer matches the locked merchant." });
  if (lock.paymentMethodId !== finalQuote.paymentMethodId) failures.push({ code: "PAYMENT_METHOD_CHANGED", message: "The payment method no longer matches the lock." });
  if (finalQuote.pointsUsed > lock.maxPoints) failures.push({ code: "POINTS_LIMIT_EXCEEDED", message: "Checkout would use more points than authorized." });
  if (!lock.allowPoints && finalQuote.pointsUsed > 0) failures.push({ code: "POINTS_NOT_AUTHORIZED", message: "Points use was not authorized." });

  for (const lockedOffer of lock.offers) {
    const current = currentOffers.find((offer) => offer.id === lockedOffer.id);
    if (
      !current ||
      current.version !== lockedOffer.version ||
      current.verificationStatus !== "verified_demo" ||
      new Date(now) < new Date(current.validFrom) ||
      new Date(now) > new Date(current.validUntil)
    ) {
      failures.push({ code: "OFFER_INVALID", message: `${lockedOffer.id} is no longer valid at the locked version.` });
    }
  }

  if (finalQuote.cashOutCents > lock.maxPaymentCents) {
    failures.push({
      code: "MAX_TOTAL_EXCEEDED",
      message: `Shipping changed the total from ${hkd(lock.lockedCashOutCents)} to ${hkd(finalQuote.cashOutCents)}, above your ${hkd(lock.maxPaymentCents)} authorization limit.`,
      deltaCents: finalQuote.cashOutCents - lock.maxPaymentCents,
    });
  }
  if (finalQuote.cashOutCents > lock.lockedCashOutCents && lock.priceIncreaseRule === "reconfirm_any_increase") {
    failures.push({ code: "PRICE_INCREASE_REQUIRES_CONFIRMATION", message: "Your policy requires confirmation for any price increase." });
  }

  return { allowed: failures.length === 0, failures };
}
