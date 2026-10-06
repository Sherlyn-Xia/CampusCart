import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("operator console keeps credentials in memory and exposes every reviewed workflow", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/operator.html", import.meta.url), "utf8"),
    readFile(new URL("../public/operator.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /CampusCart · After-sales Operations/);
  assert.match(html, /type="password"[^>]+autocomplete="off"/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(script, /"review"/);
  assert.match(script, /receive-return/);
  assert.match(script, /complete-exchange/);
  assert.match(script, /retry-refund/);
  assert.match(script, /authorization: `Bearer \$\{state\.key\}`/);
  assert.match(script, /pagehide/);
});
