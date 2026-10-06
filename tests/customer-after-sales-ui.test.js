import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("customer UI exposes after-sales lifecycle without operator credentials", async () => {
  const [api, app, styles] = await Promise.all([
    readFile(new URL("../public/api.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(api, /afterSalesCases:/);
  assert.match(api, /createAfterSales:/);
  assert.match(api, /resumeAfterSales:/);
  assert.match(api, /\/api\/v1\/after-sales\/cases/);
  assert.doesNotMatch(api, /\/api\/v1\/operator|CAMPUSCART_OPERATOR_API_KEY|authorization:\s*`Bearer/);

  assert.match(app, /id="service-form"/);
  assert.match(app, /cancel_order/);
  assert.match(app, /return/);
  assert.match(app, /exchange/);
  assert.match(app, /data-service-decision="approve"/);
  assert.match(app, /function refreshAfterSales/);
  assert.match(app, /after_sales_audit_chain_valid/);
  assert.match(app, /esc\(serviceOutcome\(c\)\)/);
  assert.match(styles, /Customer after-sales/);
  assert.match(styles, /\.service-layout/);
});
