/* CampusCart Agent API adapter
   The only file that connects the front end to the backend Agent:
   - All HTTP calls live here (see docs/openapi.yaml)
   - Converts the backend plan / run / outcome into the structures the UI uses, with friendly English copy
   If the backend runs elsewhere (split deployment), add this line before api.js in index.html:
   <script>window.CAMPUSCART_API_BASE='http://localhost:3000'</script>
   (the backend must also allow CORS; see the 'split deployment' section of the docs) */
window.CampusAPI = (() => {
 const BASE = (window.CAMPUSCART_API_BASE || '').replace(/\/$/, '');

 /* ---------- Copy mapping (backend data -> UI copy) ---------- */
 const MERCHANTS = {
  'campus-demo-store': {name:'Campus Education Store', mark:'C', caption:'Student plan', note:'Student discount and free shipping combine'},
  'harbour-tech-sandbox': {name:'Harbour Digital', mark:'H', caption:'Points plan', note:'Student discount and points combine'},
  'unimall-demo': {name:'UniMall', mark:'U', caption:'Merchant promo', note:'Regular promotion, no student status needed'}
 };
 const PAYMENT_NAMES = {'mock-tap-go':'Tap & Go', 'mock-campus-wallet':'Campus Wallet'};
 const FULFILLMENT = {
  'Standard delivery · Sandbox promise':'Standard delivery · demo promise',
  'Campus pickup · 3–5 demo days':'Campus pickup · 3–5 demo days',
  'Store pickup · 2–4 demo days':'Store pickup · 2–4 demo days'
 };
 const OFFER_TITLES = {
  'EDU-200':'Student discount', 'SHIP-0':'Student free shipping', 'HT-STUDENT-100':'Harbour student discount',
  'UM-VOUCHER-120':'UniMall online voucher', 'MEGA-300-OLD':'Back-to-school coupon'
 };
 const OFFER_MERCHANTS = {'campus-demo-store':'Campus Education Store','harbour-tech-sandbox':'Harbour Digital','unimall-demo':'UniMall'};
 const OUTCOME_TEXT = {
  NO_EXECUTABLE_PLAN:'No plan meets both your budget and eligibility requirements. We stopped before authorization, so nothing will be paid.',
  USER_REJECTED:'You cancelled this purchase. No payment was made.',
  PAYMENT_AUTHENTICATION_FAILED:'Payment confirmation was cancelled or did not pass. No payment was made and the authorization is closed.',
  ACTION_EXPIRED:'This confirmation has expired. The transaction was closed safely and nothing was paid.',
  BUDGET_REQUIRED_FOR_AUTHORIZATION:'No budget was given, so plans can be compared but not purchased.',
  BUDGET_FORMAT_UNCLEAR:'Couldn’t read the budget amount. Please write it like “budget HK$3,600”.',
  PRODUCT_CONTEXT_REQUIRED:'The specific product needs to be confirmed first.',
  AMBIGUOUS_QUANTITY:'This demo can only buy 1 unit at a time, so it can’t compare or authorize multiple units. Please change the request to 1 unit and try again.',
  AMBIGUOUS_PRODUCT_SPEC:'The demo product is only the iPad (A16) 128GB · Wi-Fi · Silver. It will not silently switch to a different spec or colour.',
  LOCK_EXPIRED:'The 15-minute authorization has expired. Please confirm the purchase plan again.',
  LOCK_ALREADY_FINALIZED:'This authorization has already been used or closed and can’t be paid again.',
  PRICE_INCREASE_REQUIRES_CONFIRMATION:'The price is higher than when you authorized, so you need to confirm again. Payment stopped.',
  MAX_TOTAL_EXCEEDED:'The final amount exceeds your authorized limit. Payment stopped.',
  OFFER_INVALID:'An offer used is no longer valid or has changed. Please compare again.',
  PAYMENT_METHOD_CHANGED:'The payment method changed. Please authorize again.',
  MERCHANT_CHANGED:'The merchant changed. Please authorize again.',
  SKU_CHANGED:'The product changed. Please authorize again.',
  POINTS_LIMIT_EXCEEDED:'Points usage exceeds what you authorized. Payment stopped.',
  POINTS_NOT_AUTHORIZED:'Points were not authorized for this purchase. Payment stopped.'
 };
 const ERROR_TEXT = {
  UNSUPPORTED_PRODUCT:'This demo only supports the confirmed iPad and will not silently switch to a different product.',
  PRODUCT_CONTEXT_MISMATCH:'The product you described doesn’t match the confirmed product. Please describe it again.',
  ACTION_EXPIRED:'This confirmation has expired. The transaction was closed safely.',
  ACTION_NOT_CURRENT:'This confirmation was already handled or is no longer valid.',
  PAYMENT_ACTION_BINDING_MISMATCH:'The payment session doesn’t match this transaction and was rejected.',
  PLAN_NOT_AVAILABLE:'The selected plan is no longer available. Please compare again.'
 };
 function enReason(r){
  let m;
  if((m=r.match(/exceeds the user's (HK\$[\d,.]+) budget/)))return `Over budget (${m[1]})`;
  if(/outside the user's allow-list/.test(r))return 'Merchant is not on your allow-list';
  if(/Payment method is not authorized/.test(r))return 'Payment method not authorized';
  if(/student (credential|status)/i.test(r))return 'Valid student status required';
  if(/expired/i.test(r))return 'Offer has expired';
  if(/has not started/i.test(r))return 'Offer has not started yet';
  if(/Minimum spend/i.test(r))return 'Minimum spend for the offer not met';
  if(/Payment method is not accepted/i.test(r))return 'Offer doesn’t support this payment method';
  return r;
 }
 const enFulfillment = s => FULFILLMENT[s] || s;
 const offerTitle = o => OFFER_TITLES[o.id] || o.title;

 /* ---------- HTTP ---------- */
 async function request(path, {method='GET', body} = {}) {
  let res;
  try {
   res = await fetch(BASE + path, {method, headers: body ? {'content-type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined});
  } catch {
   const e = new Error('Can’t reach the Agent service. Please make sure the backend is running (npm start).'); e.code = 'NETWORK'; throw e;
  }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
   const raw = data?.error || '';
   const msg = ERROR_TEXT[data?.code]
    || (res.status === 404 ? 'The server can’t find this transaction (it may have restarted).'
    : res.status === 422 && data?.issues ? 'The request format is invalid. Please check your input.' : raw || 'Request failed');
   const e = new Error(msg); e.status = res.status; e.code = data?.code; e.raw = raw; throw e;
  }
  return data;
 }
 const enc = encodeURIComponent;
 const api = {
  bootstrap: () => request('/api/bootstrap'),
  capabilities: () => request('/api/v1/agent/capabilities'),
  createRun: (message, product) => request('/api/v1/agent/runs', {method:'POST', body:{
   message,
   context:{demoScenario:'success', selectedProduct:{sku:product.sku, source:'product_page', userConfirmed:true}}
  }}),
  getRun: id => request(`/api/v1/agent/runs/${enc(id)}`),
  trace: id => request(`/api/v1/agent/runs/${enc(id)}/trace`),
  transaction: id => request(`/api/v1/agent/runs/${enc(id)}/transaction`),
  ask: (id, message) => request(`/api/v1/agent/runs/${enc(id)}/messages`, {method:'POST', body:{message}}),
  approve: (id, actionId, planId) => request(`/api/v1/agent/runs/${enc(id)}/resume`, {method:'POST', body:{actionId, decision:'approve', planId}}),
  reject: (id, actionId) => request(`/api/v1/agent/runs/${enc(id)}/resume`, {method:'POST', body:{actionId, decision:'reject'}}),
  authenticate: (id, actionId, paymentSessionId) => request(`/api/v1/agent/runs/${enc(id)}/resume`, {method:'POST', body:{actionId, decision:'authenticated', paymentSessionId}}),
  failPayment: (id, actionId, paymentSessionId) => request(`/api/v1/agent/runs/${enc(id)}/resume`, {method:'POST', body:{actionId, decision:'failed', paymentSessionId}})
 };

 /* ---------- Backend data -> UI data ---------- */
 function toPlan(p) {
  const m = MERCHANTS[p.merchantId] || {name:p.merchant, mark:(p.merchant||'?')[0], caption:'Purchase plan', note:''};
  return {
   id:p.id, merchantId:p.merchantId, name:m.name, mark:m.mark, caption:m.caption, note:m.note,
   sku:p.sku, amount:p.cashOutCents, base:p.productCents, shipping:p.shippingCents, discount:p.discountCents,
   offers:p.appliedOffers.map(o => ({...o, title:offerTitle(o)})),
   points:p.pointsUsed, pointValue:p.pointsValueCents, payment:p.paymentMethodId,
   paymentName:PAYMENT_NAMES[p.paymentMethodId] || p.paymentMethodId,
   fulfillment:enFulfillment(p.fulfillment), reference:p.referenceCostCents, reward:p.rewardCents,
   eligible:p.eligible, reasons:p.reasons.map(enReason)
  };
 }
 // Sorted by eligible -> points-inclusive cost -> cash amount, matching the backend recommendation logic
 function plansOf(run) {
  const pr = run?.proposal;
  if (!pr) return [];
  const raw = [...(pr.plan ? [pr.plan] : []), ...(pr.alternativePlans || [])];
  return raw.map(toPlan).sort((a,b) => Number(b.eligible)-Number(a.eligible) || a.reference-b.reference || a.amount-b.amount);
 }
 function outcomeText(run) {
  const o = run?.outcome;
  const r = o?.reason || o?.failures?.[0];
  if (!r) return null;
  return OUTCOME_TEXT[r.code] || r.message || null;
 }
 // run.status -> order status
 function orderStatus(run) {
  return ({completed:'completed', cancelled:'cancelled', blocked:'blocked', expired:'expired', failed:'blocked'})[run.status]
   || (run.pendingAction?.type === 'payment_authentication' ? 'pending' : 'blocked');
 }
 return {...api, MERCHANTS, PAYMENT_NAMES, OFFER_TITLES, OFFER_MERCHANTS, toPlan, plansOf, outcomeText, orderStatus, enFulfillment, offerTitle};
})();
