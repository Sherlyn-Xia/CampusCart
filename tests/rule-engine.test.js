import test from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, offers, product, purchasePaths, user } from "../src/domain/seed.js";
import { evaluateOptions, precheck } from "../src/domain/rule-engine.js";

const now = "2026-10-02T04:00:00.000Z";

test("ranks only legal combinations and explains the winner", () => {
  const result = evaluateOptions({ product, user, offers, paths: purchasePaths, policy: defaultPolicy("success"), now });
  assert.equal(result.recommendedPlanId, "plan-campus-delivery");
  const winner = result.plans.find((plan) => plan.id === result.recommendedPlanId);
  assert.equal(winner.cashOutCents, 339900);
  assert.equal(winner.referenceCostCents, 339900);
  assert.match(winner.equation, /HK\$3,399/);
  assert.ok(result.excludedOffers.some((item) => item.offerId === "MEGA-300-OLD"));
});

test("points never exceed the user's policy cap and remain an equity cost", () => {
  const policy = { ...defaultPolicy("success"), maxPoints: 35 };
  const result = evaluateOptions({ product, user, offers, paths: purchasePaths, policy, now });
  const plan = result.plans.find((item) => item.id === "plan-harbour-points");
  assert.equal(plan.pointsUsed, 20, "redemption step is enforced");
  assert.equal(plan.pointsValueCents, 1000);
  assert.equal(plan.pointsProgram.name, "Campus Wallet Points");
  assert.equal(plan.referenceCostCents, plan.cashOutCents + plan.pointsValueCents);
});

test("budget boundary allows equality and blocks one cent above", () => {
  const baseLock = {
    status: "active",
    expiresAt: "2026-10-02T05:00:00.000Z",
    sku: product.sku,
    merchantId: "campus-demo-store",
    paymentMethodId: "mock-tap-go",
    allowPoints: false,
    maxPoints: 0,
    maxPaymentCents: 350000,
    lockedCashOutCents: 350000,
    priceIncreaseRule: "reconfirm_any_increase",
    offers: [],
  };
  const quote = {
    sku: product.sku,
    merchantId: "campus-demo-store",
    paymentMethodId: "mock-tap-go",
    pointsUsed: 0,
    cashOutCents: 350000,
  };
  assert.equal(precheck({ lock: baseLock, finalQuote: quote, currentOffers: [], now }).allowed, true);
  const blocked = precheck({ lock: baseLock, finalQuote: { ...quote, cashOutCents: 350001 }, currentOffers: [], now });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.failures.some((failure) => failure.code === "MAX_TOTAL_EXCEEDED"));
});

test("recommendation excludes every plan whose cash payment exceeds budget", () => {
  const result = evaluateOptions({
    product,
    user,
    offers,
    paths: purchasePaths,
    policy: { ...defaultPolicy("success"), budgetCents: 10000 },
    now,
  });
  assert.equal(result.recommendedPlanId, null);
  assert.equal(result.plans.every((plan) => !plan.eligible), true);
  assert.equal(result.plans.every((plan) => plan.reasons.some((reason) => reason.includes("exceeds"))), true);
});
