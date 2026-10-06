/* CampusCart front end (connected to the backend Agent) — English edition.
   Quotes, offers, authorization, payment and audit all come from /api/v1/agent/*.
   HTTP calls and data conversion live in api.js; this file only renders and handles interaction. */
(() => {
'use strict';
const E=CampusEngine, API=CampusAPI, KEY='campuscart-agent-en-v1', $=(s,r=document)=>r.querySelector(s);
const svg={search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',back:'<path d="m14 5-7 7 7 7"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',box:'<path d="m3 7 9-4 9 4v10l-9 4-9-4ZM3 7l9 4 9-4M12 11v10M7 5l10 4"/>',coin:'<circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 6v2m0 8v2"/>',shield:'<path d="m12 3-8 3v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/>',receipt:'<path d="M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 8h8M8 12h8M8 16h4"/>',send:'<path d="m3 4 18 8-18 8 4-8ZM7 12h14"/>',wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M21 10h-6v5h6M6 5V3h12v2M17 12.5h.1"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',truck:'<path d="M3 6h11v11H3ZM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>'};
const icon=n=>`<svg viewBox="0 0 24 24" aria-hidden="true">${svg[n]||svg.spark}</svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>'HK$'+(c/100).toLocaleString('en-HK',{maximumFractionDigits:2,minimumFractionDigits:c%100?2:0});
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const shortDate=s=>{const a=s.slice(0,10).split('-');return `${MONTHS[Number(a[1])-1]} ${Number(a[2])}`};
const clock=iso=>new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
const shortId=o=>'CC-'+o.id.slice(0,8).toUpperCase();
const PAY_LABELS={'wechat-pay':'WeChat Pay','credit-card':'Credit card','alipay-hk':'AlipayHK','octopus':'Octopus','mock-tap-go':'Tap & Go','mock-campus-wallet':'Campus Wallet'};
const GONE='The server can’t find this transaction (it may have restarted). The authorization is no longer valid and nothing was paid.';
const SERVICE_LABELS={USER_CONFIRMATION_REQUIRED:'Confirmation required',REFUND_PENDING:'Refund processing',MANUAL_REVIEW:'Under review',RETURN_AUTHORIZED:'Return authorized',RETURN_RECEIVED:'Return received',EXCHANGE_AUTHORIZED:'Exchange authorized',REFUNDED:'Refunded',COMPLETED:'Exchange completed',REVIEW_REJECTED:'Request rejected',REJECTED:'Not eligible',CANCELLED:'Request cancelled',EXPIRED:'Confirmation expired'};

let saved;try{saved=JSON.parse(localStorage.getItem(KEY)||'null')}catch{}
const state={orders:Array.isArray(saved?.orders)?saved.orders:[],meta:null,caps:null,bootError:null,query:'Help me buy this iPad, budget HK$3,600, up to 100 points.',cap:360000,pointCap:100,filter:'all',run:null,chat:[],loading:false};
let selection=null,lastFocus=null,busy=false,timer,searchToken=0;

function persist(){try{localStorage.setItem(KEY,JSON.stringify({orders:state.orders}))}catch{}}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(timer);timer=setTimeout(()=>el.classList.remove('show'),3000)}
function go(route){if(location.hash.slice(1)===route)render();else location.hash=route}
function close(){if($('#dialog').open)$('#dialog').close();lastFocus?.focus?.()}
function modal(html){lastFocus=document.activeElement;$('#dialog').innerHTML=`<div class="modal">${html}</div>`;$('#dialog').showModal()}
function head(title,desc=''){return `<div class="modal-head"><div><h2 id="dialog-title">${title}</h2>${desc?`<p>${desc}</p>`:''}</div><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('close')}</button></div>`}
function back(text='Back to shop',target='shop'){return `<button class="back" data-go="${target}">${icon('back')}${text}</button>`}
function productBlock(){return `<div class="context-product"><img src="assets/ipad.jpg" alt="Silver iPad A16 product photo"><div><h3>Selected for this purchase · ${E.PRODUCT.name}</h3><p>${E.PRODUCT.spec} · 1 unit</p></div><span class="pill">${icon('check')}Product confirmed</span></div>`}

/* ---------- Backend user profile (read-only) ---------- */
const points=()=>state.meta?.user?.pointsBalance??0;
const studentOk=()=>state.meta?.user?.studentStatus==='valid';

/* ---------- Request text ---------- */
// Write the budget / points inputs back into the text description
const BUDGET_SAFE=new RegExp(E.BUDGET_RE.source,'i');
function applyToText(text,cap,pts){
 if(cap&&BUDGET_SAFE.test(text))text=text.replace(BUDGET_SAFE,`budget ${money(cap)}`);
 if(E.POINTS_RE.test(text))text=text.replace(E.POINTS_RE,`up to ${pts} points`);
 return text;
}
// Final text sent to the Agent: budget and points cap are always written in (the Agent parses constraints from the text)
function composeMessage(text,cap,pts){
 const p=E.parse(text);let t=text.replace(/\s+$/,'').replace(/[。.]$/,'');
 if(p.cap===undefined)t+=`, budget ${money(cap)}`;
 if(p.points===undefined)t+=pts?`, up to ${pts} points`:', no points';
 return t;
}

/* ---------- Pages ---------- */
function home(){const pending=state.orders.find(o=>o.status==='pending');return `<section class="page home"><div class="home-title"><div class="eyebrow">CAMPUSCART / SHOPPING ASSISTANT</div><h1>Tell me what you want to buy.</h1><p class="subtitle">Student deals, delivery and payment, all considered together.</p></div>${pending?`<div class="note orange" style="margin-bottom:20px">You have an authorized order waiting for payment confirmation. <button class="text-button" data-go="payment/${pending.id}">Continue to payment</button></div>`:''}<form class="composer" id="search-form"><div class="query-row"><textarea id="query" aria-label="Describe what you want to buy" placeholder="What do you want to buy? Tell me your needs and budget." required>${esc(state.query)}</textarea><button type="submit" class="search-button" aria-label="Search" title="Search" ${state.loading?'disabled':''}>${state.loading?'<span class="spinner"></span>':icon('search')}</button></div><div class="constraints"><label class="field"><span>Maximum budget</span><div class="input-wrap"><span>HK$</span><input id="budget" type="number" min="0.01" max="1000000" step="0.01" value="${state.cap/100}" required aria-label="Maximum budget"></div></label><label class="field"><span>Maximum points to use</span><div class="input-wrap"><input id="points" type="number" min="0" max="100000" step="1" value="${state.pointCap}" required aria-label="Maximum points to use"><span>pts</span></div></label></div><div class="composer-bottom"><span style="margin-left:auto">Available points ${points()} · ${studentOk()?'Student status valid':'Student status not enabled'}</span></div><div id="search-error" role="alert"></div>${state.loading?'<div class="loading-line" role="status"><span class="spinner"></span>The Agent is comparing merchant quotes, available offers and payment methods…</div>':''}</form><div class="home-suggestions"><span>Try saying</span><button class="suggestion" data-preset="normal">Budget 3,600, up to 100 points</button><button class="suggestion" data-preset="nopoints">No points</button><button class="suggestion" data-preset="tight">Budget 3,300 (see what happens)</button></div>${productBlock()}</section>`}

function recommendedId(){return state.run?.proposal?.plan?.id}
function canBuy(){return state.run?.status==='needs_user_action'&&state.run.pendingAction?.type==='purchase_authorization'}
function reason(p){if(!p.eligible)return p.reasons.join(', ')+'. Adjust your request to choose this plan.';if(p.id===recommendedId()&&p.points===0)return 'Fits your budget and uses no points.';if(p.points)return `Uses ${p.points} points to save ${money(p.pointValue)}, and combines with the student discount.`;if(p.reward)return 'Includes a merchant promotion. A demo reward is earned after the order and isn’t deducted from this payment.';return 'Meets your purchase conditions. Review and confirm the plan.'}
function card(p){const rec=p.id===recommendedId()&&p.eligible,buyable=canBuy()&&p.eligible;
 const discounts=p.offers.filter(o=>o.kind==='product_discount').map(o=>`<div class="bill-line discount"><span>${esc(o.title)}</span><strong>-${money(o.valueCents)}</strong></div>`).join('')||'<div class="bill-line discount"><span>Offer</span><strong>Not applied</strong></div>';
 const label=!p.eligible?esc(p.reasons[0]||'Does not meet requirements'):buyable?'Choose this plan':'Add a budget to choose';
 return `<article class="offer-card ${rec?'recommended':''} ${!p.eligible?'out-of-range':''}"><div class="offer-top"><span class="merchant-mark">${esc(p.mark)}</span><span class="pill ${rec?'':p.eligible?'gray':''}">${rec?'Recommended':p.eligible?esc(p.caption):'Not eligible'}</span></div><h2>${esc(p.name)}</h2><p class="merchant-caption">${esc(p.note)}</p><div class="price-label">You pay now · incl. delivery</div><div class="price"><small>HK$</small>${(p.amount/100).toLocaleString('en-HK')}</div><div class="offer-breakdown"><div class="bill-line"><span>Product price</span><strong>${money(p.base)}</strong></div>${discounts}<div class="bill-line"><span>Delivery</span><strong>${p.shipping?money(p.shipping):'Free'}</strong></div><div class="bill-line"><span>Points discount</span><strong>${p.points?'-'+money(p.pointValue):'Not used'}</strong></div></div><div class="offer-meta"><div>${icon('truck')}${esc(p.fulfillment)}</div><div>${icon('coin')}Uses ${p.points} points · Future reward ${p.reward?money(p.reward):'none'}</div><div>${icon('wallet')}${esc(p.paymentName)}</div><div>${icon('receipt')}Cost incl. points value ${money(p.reference)}</div></div><p class="offer-reason">${reason(p)}</p><button class="${rec?'primary':'secondary'} choose" data-choose="${p.id}" ${buyable?'':'disabled'}>${label}</button></article>`}
function results(){if(!state.run)return home();
 const run=state.run,list=API.plansOf(run),pr=run.proposal||{},c=pr.intent?.constraints||{};
 const display=list.length===3?[list[1],list[0],list[2]]:list;
 const payPending=run.pendingAction?.type==='payment_authentication'&&state.orders.find(o=>o.id===run.id&&o.status==='pending');
 const noPlans=list.length===0;
 const overBudget=!noPlans&&list.every(p=>!p.eligible&&p.reasons.some(r=>/^Over budget/.test(r)));
 const lowest=overBudget?Math.min(...list.map(p=>p.amount)):0;
 const allowedPay=c.allowedPaymentMethodIds||[];
 const payBlocked=!noPlans&&!overBudget&&allowedPay.length>0&&list.every(p=>!p.eligible&&p.reasons.some(r=>/^Payment method not authorized/.test(r)));
 const payNames=allowedPay.map(id=>PAY_LABELS[id]||id).join(', ');
 const noCards=noPlans||overBudget||payBlocked;
 const title=payBlocked?'That payment method isn’t available':overBudget?'This is over your budget':noPlans?'Let’s confirm something first':canBuy()?`Found ${list.length} purchase plan${list.length===1?'':'s'} for you`:run.status==='needs_clarification'?'Compare plans first, add a budget to buy':payPending?'This plan is already authorized':'No plan meets all your requirements yet';
 let notice='';
 if(payPending)notice=`<div class="note orange eligibility-notice">The plan is authorized and waiting for your payment confirmation. <button class="text-button" data-go="payment/${run.id}">Continue to payment</button></div>`;
 else if(run.status==='needs_clarification')notice=`<div class="note orange eligibility-notice">${esc(API.outcomeText(run)||'More information is needed before you can buy.')}${noPlans?'':' You can tell me below, for example “budget HK$3,600”.'}</div>${noPlans?`<div class="result-buttons" style="justify-content:flex-start;margin:0 0 24px"><button class="primary" data-go="shop">Back to edit request</button></div>`:''}`;
 else if(payBlocked)notice=`<div class="note orange eligibility-notice">${esc(payNames)} is not available in this demo yet (it is only a future integration), so none of the plans can be paid with it. Nothing will go to authorization or payment. Remove the payment restriction to see purchasable plans.</div><div class="result-buttons" style="justify-content:flex-start;margin:0 0 24px"><button class="primary" data-go="shop">Back to edit request</button></div>`;
 else if(overBudget)notice=`<div class="note orange eligibility-notice">The lowest price available is ${money(lowest)}, above your ${money(c.budgetCents||state.cap)} budget. Nothing will go to payment. Raise your budget to see purchasable plans.</div><div class="result-buttons" style="justify-content:flex-start;margin:0 0 24px"><button class="primary" data-go="shop">Back to edit request</button></div>`;
 else if(run.status==='blocked')notice='<div class="note orange eligibility-notice">Here are the current quotes. No plan meets all your requirements, so nothing will go to payment.</div>';
 return `<section class="page results">${back('Adjust request')}<div class="results-top"><div><h1>${title}</h1><p class="subtitle">${E.PRODUCT.name} · ${E.PRODUCT.spec} · 1 unit</p></div><span class="pill">${icon('shield')}You confirm before paying</span></div><div class="requirement-row"><span>${c.budgetCents?'Budget '+money(c.budgetCents):'No budget given'}</span><span>${c.allowPoints&&c.maxPoints?`Up to ${c.maxPoints} points`:'No points'}</span><span>${pr.identity?.studentStatus==='valid'?'Student status valid':'Student status not used'}</span>${allowedPay.length?`<span>Pay with ${esc(payNames)} only</span>`:''}</div>${notice}${noCards?'':`<div class="cards">${display.map(card).join('')}</div><p class="quote-foot">Demo merchants and quotes. Cost incl. points value = this payment + the demo redemption value of points used; future rewards are listed separately.</p>`}<section class="chat" aria-label="Questions about the purchase plans">${state.chat.map(x=>`<div class="chat-answer"><div class="chat-question">You: ${esc(x.q)}</div><div>${esc(x.a)}</div></div>`).join('')}<form class="chat-form" id="chat-form"><input id="followup" aria-label="Ask a follow-up or adjust your request" placeholder="Ask me more, e.g. Why aren’t my 100 points used?" required><button class="send" aria-label="Send question">${icon('send')}</button></form><div class="home-suggestions"><button class="suggestion" data-question="Why aren’t my 100 points being used?">Why no points?</button><button class="suggestion" data-question="Are any coupons used?">Which offers are used?</button><button class="suggestion" data-question="How do the delivery options differ?">How does delivery differ?</button></div></section></section>`}

function showAuthorization(id){const p=API.plansOf(state.run).find(x=>x.id===id),action=state.run?.pendingAction;
 if(!canBuy()||!p?.eligible||!action){toast('This plan can no longer be chosen. Please compare again.');render();return}
 selection={id};
 const used=[...p.offers.map(o=>`<div class="benefit-applied">${icon('check')}<div><h3>${esc(o.title)}</h3><p>${o.kind==='shipping_waiver'?'This order qualifies for free shipping':/^(EDU|HT-STUDENT)/.test(o.id)?'Student status used':'Available for this order'}</p></div><strong>${o.kind==='shipping_waiver'?'Free shipping':'-'+money(o.valueCents)}</strong></div>`),p.points?`<div class="benefit-applied">${icon('check')}<div><h3>Points discount</h3><p>Uses ${p.points} points</p></div><strong>-${money(p.pointValue)}</strong></div>`:''].join('');
 const maxPts=state.run.proposal?.intent?.constraints?.maxPoints??0;
 modal(`${head('Confirm purchase plan','Review the benefits used and the payment scope.')}<div class="modal-product"><img src="assets/ipad.jpg" alt="Silver iPad A16"><div><h3>${E.PRODUCT.name}</h3><p>${E.PRODUCT.spec} · 1 unit</p><p>${esc(p.name)}</p></div></div><div class="section-label">Benefits used</div>${used.trim()||'<p class="muted">No extra offers used</p>'}<div class="modal-bill"><div class="bill-line"><span>Product price</span><strong>${money(p.base)}</strong></div><div class="bill-line"><span>Delivery</span><strong>${p.shipping?money(p.shipping):'Free'}</strong></div><div class="bill-line"><span>Points used</span><strong>${p.points} pts</strong></div><div class="total-line"><span>You pay now</span><strong>${money(p.amount)}</strong></div></div><div class="section-label" style="margin-top:18px;margin-bottom:6px">Payment method</div><div class="payment-select" style="display:flex;align-items:center">${esc(p.paymentName)} (Sandbox)</div><p class="muted" style="font-size:12px;margin-top:6px">The payment method is set by the chosen plan and can’t change after authorization; to use a different one, choose a different plan.</p><div class="mandate-summary">Maximum authorization <strong>${money(action.maxPaymentCents)}</strong> · valid for 15 minutes · single use<br>Limited to this product, merchant and payment method. Fulfillment: ${esc(p.fulfillment)}.</div><details><summary>View full authorization scope</summary><dl><dt>Product SKU</dt><dd>${esc(p.sku)}</dd><dt>Merchant</dt><dd>${esc(p.name)}</dd><dt>Offer versions</dt><dd>${p.offers.map(o=>`${esc(o.title)} v${esc(o.version)}`).join(', ')||'None'}</dd><dt>Points limit</dt><dd>${maxPts} pts, ${p.points} used this time</dd><dt>Changes</dt><dd>If the amount, offers or payment method change, you must confirm again</dd></dl></details><label class="consent"><input id="consent" type="checkbox"><span>I agree to authorize this purchase within the scope above. I will still confirm payment in the next step.</span></label><div id="approval-error" role="alert"></div><div class="modal-actions"><button class="secondary" data-action="close">Keep looking</button><button class="primary" id="approve" data-action="approve" disabled>Confirm and go to payment</button></div>`)}

function offerStatus(o){const now=Date.now();if(o.verificationStatus!=='verified_demo'||now>Date.parse(o.validUntil))return 'expired';if(now<Date.parse(o.validFrom))return 'pending';return 'ok'}
function benefits(){const m=state.meta,u=m.user,ok=studentOk();
 const rule=m.purchasePaths.find(x=>x.points)?.points;
 const pointsNote=rule?`Redeemed in steps of ${rule.redemptionStep} points, each point worth HK$${(rule.centsPerPoint/100).toLocaleString('en-HK')}, up to ${rule.maxPoints} points per purchase.`:'';
 const coupons=m.offers.map(o=>{const st=offerStatus(o),title=API.OFFER_TITLES[o.id]||o.title,merchant=API.OFFER_MERCHANTS[o.merchantId]||o.merchant||'';
  const value=o.kind==='shipping_waiver'?'Free ship':`<small>HK$</small>${o.valueCents/100}`;
  return `<div class="coupon ${st==='ok'?'':'inactive'}"><div class="coupon-value">${value}</div><div><h3>${esc(title)}</h3><p>${esc(merchant)} · valid until ${esc(o.validUntil.slice(0,10))}</p><span class="pill ${st==='ok'?'':'gray'}">${st==='ok'?'Available':st==='expired'?'Expired':'Not started'}</span></div></div>`}).join('');
 const wallets=m.paymentMethods.map((w,i)=>`<div class="wallet"><div class="wallet-logo ${i?'gray':''}">${i?'C':'Go'}</div><div><h3>${esc(API.PAYMENT_NAMES[w.id]||w.name)}</h3><p>Sandbox · Enabled</p></div><input class="switch" type="checkbox" checked disabled aria-label="${esc(w.name)} enabled (read-only)"></div>`).join('');
 return `<section class="page benefits-page"><div class="eyebrow">MY BENEFITS</div><h1>Use your benefits where they count.</h1><p class="subtitle">Comparisons only consider the status, points and payment methods you already have.</p><div class="benefit-layout"><div class="identity-card"><div class="identity-top"><h2>Student status</h2>${icon('shield')}</div><div><p>Hong Kong university student · ${esc(u.displayName)} (demo account)</p><div class="identity-bottom"><strong>${ok?'Student status enabled':'Student status not enabled'}</strong><span style="border:1px solid #ffffff66;background:#ffffff1c;border-radius:9px;padding:7px 12px;font-size:13px">Provided by the Agent identity service</span></div></div></div><div class="points-card"><span class="section-label">CAMPUS WALLET POINTS</span><div class="points-number">${u.pointsBalance}<small>points available</small></div><p>You decide the most to use; each plan shows the actual usage.</p><p class="small-note">${pointsNote}</p></div></div><div class="rights-bottom"><section class="panel"><h2>My offers</h2>${coupons}</section><section class="panel"><h2>Payment methods</h2>${wallets}<hr class="divider"><p class="muted" style="font-size:14px">The payment method is set by the chosen plan and can’t change after authorization.</p></section></div><p class="rights-foot">Status, points, offers and payment methods come from the Agent service’s demo data (read-only). No student ID, bank card or real identity details are needed.</p></section>`}

function statusLabel(o){return ({completed:'Completed',pending:'Awaiting payment',failed:'Payment failed',cancelled:'Cancelled',expired:'Expired'})[o.status]||'Stopped'}
function serviceLabel(c){return SERVICE_LABELS[c?.status]||'After-sales request'}
function serviceTone(c){return ['REFUNDED','COMPLETED'].includes(c?.status)?'green':['REVIEW_REJECTED','REJECTED','CANCELLED','EXPIRED'].includes(c?.status)?'red':''}
function orderActions(o){
 if(o.status==='pending')return `<button class="text-button" data-cancel="${o.id}">Cancel authorization</button><button class="text-button" data-go="payment/${o.id}">Continue to payment</button>`;
 return `<button class="text-button" data-go="result/${o.id}">View details</button>${o.status==='completed'?`<button class="text-button service-link" data-service="${o.id}">${o.afterSales?'View after-sales':'After-sales service'}</button>`:''}<button class="text-button" data-download="${o.id}">Download purchase record</button>`;
}
function orders(){const list=state.orders.filter(o=>state.filter==='all'||(state.filter==='stopped'?['blocked','cancelled','expired'].includes(o.status):o.status===state.filter));return `<section class="page orders-page"><div class="eyebrow">YOUR ORDERS</div><h1>Every purchase, on record.</h1><p class="subtitle">See purchase results and request a refund, return or exchange for completed orders.</p><div class="order-filters" role="group" aria-label="Order filter">${[['all','All'],['pending','To pay'],['completed','Completed'],['failed','Failed'],['stopped','Stopped']].map(([k,t])=>`<button data-filter="${k}" class="${state.filter===k?'active':''}">${t}</button>`).join('')}</div>${list.length?list.map(o=>`<article class="order-item"><div class="order-topline"><span>${shortDate(new Date(o.createdAt).toISOString())} · ${shortId(o)}</span><span class="order-statuses"><span class="pill ${o.status==='completed'?'green':o.status==='pending'?'':o.status==='failed'?'red':'gray'}">${statusLabel(o)}</span>${o.afterSales?`<span class="pill ${serviceTone(o.afterSales)}">${esc(serviceLabel(o.afterSales))}</span>`:''}</span></div><div class="order-body"><img src="assets/ipad.jpg" alt="Silver iPad A16"><div class="order-info"><h3>${E.PRODUCT.name} · ${E.PRODUCT.spec}</h3><p>${esc(o.plan.name)} · ${esc(o.plan.paymentName)}</p></div><div class="order-money">${money(o.plan.amount)}<p>${o.afterSales?.status==='REFUNDED'?'Refunded in sandbox':o.status==='completed'?'Simulated payment':o.status==='failed'?'Payment not taken':'Not paid yet'}</p></div></div><div class="order-actions">${orderActions(o)}</div></article>`).join(''):`<div class="empty">${icon('receipt')}<h2>${state.filter==='all'?'No purchase records yet':'No orders here yet'}</h2><p>${state.filter==='all'?'Start with a purchase goal and find a plan that suits you.':'Try a different filter.'}</p><button class="primary" data-go="shop">Go shopping</button></div>`}</section>`}

function payment(o){if(o.status!=='pending')return result(o);
 const until=Math.min(...[o.payment?.expiresAt,o.lock?.expiresAt].filter(Boolean).map(Date.parse));
 const late=Number.isFinite(until)&&Date.now()>=until;
 return `<section class="page payment-page">${back('Back to order history','orders')}<div class="eyebrow">PAYMENT CONFIRMATION</div><h1 style="font-size:32px">One last confirmation from you.</h1><p class="subtitle">The plan is authorized. Now confirm this payment.</p><div class="payment-grid"><aside class="payment-summary"><img src="assets/ipad.jpg" alt="Silver iPad A16"><h3>${E.PRODUCT.name}</h3><p>${E.PRODUCT.spec} · 1 unit</p><hr class="divider"><div class="bill-line"><span>Merchant</span><strong>${esc(o.plan.name)}</strong></div><div class="bill-line" style="margin-top:14px"><span>Fulfillment</span><strong>${esc(o.plan.fulfillment)}</strong></div><div class="bill-line" style="margin-top:14px"><span>Authorized limit</span><strong>${money(o.cap)}</strong></div><div class="bill-line" style="margin-top:14px"><span>Points used</span><strong>${o.plan.points} pts</strong></div></aside><section class="payment-box"><div class="provider-band"><strong>${esc(o.plan.paymentName)}</strong><span>Sandbox</span></div><div class="payment-inner"><div class="eyebrow">${icon('lock')}Payment confirmation</div><h2>Confirm this payment</h2><p>Paid to: ${esc(o.plan.name)}</p><div class="price"><small>HK$</small>${(o.plan.amount/100).toLocaleString('en-HK')}</div><div class="note">This is a second confirmation, separate from the purchase authorization. The demo takes no real money and needs no password.</div><button class="primary full" data-pay="${o.id}" ${busy?'disabled':''}>${busy?'Confirming…':`Confirm payment ${money(o.plan.amount)}`}</button><button class="cancel" data-cancel="${o.id}" ${busy?'disabled':''}>Cancel this payment</button><button class="cancel" data-payfail="${o.id}" ${busy?'disabled':''} style="margin-top:6px">Simulate a failed payment (demo)</button><div class="countdown">${Number.isFinite(until)?(late?'This payment confirmation has expired. Clicking confirm will close the transaction without paying.':`Payment confirmation valid until ${clock(until)}, single use`):'Single use'}</div></div></section></div></section>`}
function result(o){const ok=o.status==='completed';
 const title=ok?'Purchase complete.':o.status==='failed'?'Payment failed.':o.status==='cancelled'?'This purchase was cancelled.':o.status==='expired'?'This purchase has expired.':'This purchase was stopped for you.';
 const auth=ok?'Used, can’t be paid again':o.status==='failed'?'Closed, authorize again':o.status==='cancelled'?'Cancelled':o.status==='expired'?'Expired':'Stopped, authorize again';
 return `<section class="page result-page"><div class="status-icon ${ok?'':'blocked'}">${icon(ok?'check':'shield')}</div><h1>${title}</h1><p class="subtitle">${ok?'The simulated order is confirmed. No real charge or shipment.':esc(o.reason||'No payment was made for this order.')}</p><div class="result-amount"><small>HK$</small>${ok?(o.plan.amount/100).toLocaleString('en-HK'):'0'}</div><p class="muted" style="font-size:13px">${ok?'Simulated payment amount':'Payment amount'}</p><div class="receipt"><div class="bill-line"><span>Product</span><strong>${E.PRODUCT.name} · ${E.PRODUCT.spec}</strong></div><div class="bill-line"><span>Merchant</span><strong>${esc(o.plan.name)}</strong></div><div class="bill-line"><span>Payment method</span><strong>${esc(o.plan.paymentName)} Sandbox</strong></div><div class="bill-line"><span>Points used</span><strong>${ok?o.plan.points:0} pts</strong></div>${ok?`<div class="bill-line"><span>Fulfillment</span><strong>${esc(o.plan.fulfillment)}</strong></div>${o.sandboxOrderId?`<div class="bill-line"><span>Simulated order ID</span><strong>${esc(o.sandboxOrderId)}</strong></div>`:''}`:''}<div class="bill-line"><span>Purchase authorization</span><strong>${auth}</strong></div>${o.afterSales?`<div class="bill-line"><span>After-sales</span><strong>${esc(serviceLabel(o.afterSales))}</strong></div>`:''}</div><div class="result-buttons"><button class="primary" data-go="${ok?'orders':'shop'}">${ok?'View order history':o.status==='failed'?'Try again':'Adjust purchase request'}</button><button class="secondary" data-go="${ok?'shop':'orders'}">${ok?'Keep shopping':'View order history'}</button></div><div class="result-links"><button class="text-button" data-download="${o.id}">Download purchase record</button>${ok?`<button class="text-button" data-service="${o.id}">${o.afterSales?'View after-sales':'Request after-sales'}</button><button class="text-button" data-action="receipt-info">About this record</button>`:''}</div></section>`}

function serviceOutcome(c){
 if(c.status==='USER_CONFIRMATION_REQUIRED')return 'Review the amount below and confirm this request. The confirmation is single-use and expires.';
 if(c.status==='MANUAL_REVIEW')return c.outcome?.reason?.code==='MERCHANT_REVIEW_REQUIRED'?'The merchant team will review this request. No refund or replacement is issued until the required checks finish.':'This request needs an operator to resolve a provider result.';
 if(c.status==='RETURN_AUTHORIZED')return 'Your return is authorized. In this sandbox, the operator will record the item as received before the refund is issued.';
 if(c.status==='RETURN_RECEIVED'||c.status==='REFUND_PENDING')return 'The returned item was recorded and the refund is being processed.';
 if(c.status==='EXCHANGE_AUTHORIZED')return 'Your exchange is authorized. The merchant operator will create the replacement order.';
 if(c.status==='REFUNDED')return `The sandbox refund of ${money(c.outcome?.refund?.amountCents??c.refundEstimate?.amountCents??0)} is complete${c.outcome?.refund?.pointsRestored?` and ${c.outcome.refund.pointsRestored} points were restored`:''}.`;
 if(c.status==='COMPLETED')return `The sandbox replacement order ${c.outcome?.exchange?.replacementOrderId||''} was created. No refund was issued.`;
 return c.outcome?.reason?.message||'This after-sales request is closed.';
}
function serviceTimeline(c){const events=[...(c.audit||[])].reverse().slice(0,8);return `<div class="service-timeline">${events.map((e,i)=>`<div class="service-event"><span class="service-dot ${i===0?'current':''}"></span><div><strong>${esc(e.type.replaceAll('_',' '))}</strong><p>${new Date(e.at).toLocaleString('en-HK',{dateStyle:'medium',timeStyle:'short'})}</p></div></div>`).join('')}</div>`}
function serviceForm(o){return `<form class="service-form" id="service-form" data-order-id="${o.id}"><fieldset><legend>What would you like us to do?</legend><div class="service-options">${[['cancel_order','Cancel & refund','I changed my mind after ordering.'],['refund','Refund','Refund the completed sandbox payment.'],['return','Return','Send the item back for review and refund.'],['exchange','Exchange','Request an inspected replacement item.']].map(([value,title,desc],i)=>`<label class="service-option"><input type="radio" name="service-action" value="${value}" ${i===0?'checked':''}><span>${icon(value==='exchange'?'box':'receipt')}<strong>${title}</strong><small>${desc}</small></span></label>`).join('')}</div></fieldset><label class="service-reason"><span>Tell us why</span><textarea id="service-reason" minlength="3" maxlength="1000" required placeholder="Describe what happened or why you changed your mind."></textarea></label><div id="service-error" role="alert"></div><div class="service-submit"><p>Submitting does not immediately move real money or ship an item.</p><button class="primary" type="submit" ${busy?'disabled':''}>${busy?'Submitting…':'Continue'}</button></div></form>`}
function servicePage(o){if(o.status!=='completed')return orders();const c=o.afterSales;
 const summary=`<aside class="service-order-card"><img src="assets/ipad.jpg" alt="Silver iPad A16"><div><span class="section-label">ORDER ${shortId(o)}</span><h2>${E.PRODUCT.name}</h2><p>${E.PRODUCT.spec} · 1 unit</p></div><hr class="divider"><div class="bill-line"><span>Merchant</span><strong>${esc(o.plan.name)}</strong></div><div class="bill-line"><span>Paid</span><strong>${money(o.plan.amount)}</strong></div><div class="bill-line"><span>Order ID</span><strong>${esc(o.sandboxOrderId||'Sandbox order')}</strong></div></aside>`;
 if(!c)return `<section class="page service-page">${back('Back to order history','orders')}<div class="eyebrow">AFTER-SALES SERVICE</div><h1>How can we help with this order?</h1><p class="subtitle">Cancellation, refunds, returns and exchanges follow separate confirmation and review rules.</p><div class="service-layout">${summary}<section class="service-main">${serviceForm(o)}</section></div></section>`;
 const confirmation=c.status==='USER_CONFIRMATION_REQUIRED'?`<div class="service-confirm"><div><strong>Confirm ${c.requestedAction.replaceAll('_',' ')}</strong><p>This will close the sandbox order and record a simulated refund of ${money(c.refundEstimate.amountCents)}.</p></div><div class="service-confirm-actions"><button class="secondary" data-service-decision="reject" data-order-id="${o.id}" ${busy?'disabled':''}>Keep order</button><button class="primary" data-service-decision="approve" data-order-id="${o.id}" ${busy?'disabled':''}>Confirm request</button></div></div>`:'';
 return `<section class="page service-page">${back('Back to order history','orders')}<div class="service-page-head"><div><div class="eyebrow">AFTER-SALES SERVICE</div><h1>${esc(serviceLabel(c))}</h1><p class="subtitle">Case ${esc(c.id)}</p></div><span class="pill ${serviceTone(c)}">${esc(serviceLabel(c))}</span></div><div class="service-layout">${summary}<section class="service-main"><div class="service-status-card"><div class="status-icon ${['REVIEW_REJECTED','REJECTED','CANCELLED','EXPIRED'].includes(c.status)?'blocked':''}">${icon(['REFUNDED','COMPLETED'].includes(c.status)?'check':['RETURN_AUTHORIZED','EXCHANGE_AUTHORIZED'].includes(c.status)?'box':'shield')}</div><div><h2>${esc(serviceLabel(c))}</h2><p>${esc(serviceOutcome(c))}</p></div><button class="text-button" data-service-refresh="${o.id}" ${busy?'disabled':''}>Refresh status</button></div>${confirmation}<div class="service-facts"><div><span>Request</span><strong>${esc(c.requestedAction.replaceAll('_',' '))}</strong></div><div><span>Refund estimate</span><strong>${money(c.refundEstimate.amountCents)}</strong></div><div><span>Return window</span><strong>${c.eligibility?.withinWindow?'Eligible':'Outside window'}</strong></div><div><span>Audit chain</span><strong>${c.auditChainValid?'Verified':'Check failed'}</strong></div></div><div class="service-reason-display"><span>Your reason</span><p>${esc(c.reason)}</p></div><section class="service-progress"><div class="section-head"><h2>Case progress</h2><span>${c.audit?.length||0} events</span></div>${serviceTimeline(c)}</section></section></div></section>`}

function status(html){return `<section class="page"><div class="empty">${icon('shield')}${html}</div></section>`}
function render(preserveScroll=false){const viewport=preserveScroll?{x:window.scrollX,y:window.scrollY}:null;
 const [route,arg]=(location.hash.slice(1)||'shop').split('/');let html;
 if(state.bootError)html=status(`<h2>Can’t reach the Agent service</h2><p>${esc(state.bootError)}</p><button class="primary" data-action="retry">Retry</button>`);
 else if(!state.meta)html=status('<h2>Connecting to the Agent…</h2><p>One moment.</p>');
 else{const o=state.orders.find(x=>x.id===arg);
  if(['payment','result','service'].includes(route))html=o?(route==='payment'?payment(o):route==='result'?result(o):servicePage(o)):orders();
  else html=route==='benefits'?benefits():route==='orders'?orders():route==='results'?results():home()}
 $('#main').innerHTML=html;
 const nav=route==='benefits'?'benefits':['orders','result','payment','service'].includes(route)?'orders':'shop';
 document.querySelectorAll('[data-nav]').forEach(a=>{const active=a.dataset.nav===nav;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
 document.title=(nav==='benefits'?'My Benefits':nav==='orders'?'Order History':'Shop')+' · CampusCart';
 if(preserveScroll){const pg=$('#main > .page');if(pg)pg.style.animation='none';window.scrollTo({left:viewport.x,top:viewport.y,behavior:'instant'});$('#followup')?.focus({preventScroll:true})}else{window.scrollTo({top:0,behavior:'instant'});$('#main').focus({preventScroll:true})}}

/* ---------- Search: create an Agent run ---------- */
function showSearchError(msg){const el=$('#search-error');if(el)el.innerHTML=`<div class="error">${esc(msg)}</div>`}
async function startRun(text,cap,pts){
 const run=await API.createRun(composeMessage(text,cap,pts),E.PRODUCT);
 if(run.status==='failed')throw new Error('The Agent couldn’t finish this comparison. Please try again later.');
 return run;
}
async function search(){
 if(state.loading)return;
 const text=$('#query').value.trim(),cap=E.cents($('#budget').value),pts=Number($('#points').value);
 state.query=text;
 const err=!text?'Please describe what you want to buy.':!cap?'Please enter a valid budget amount.':(!Number.isInteger(pts)||pts<0||pts>100000)?'The points limit must be a whole number between 0 and 100,000.':null;
 if(err){showSearchError(err);return}
 state.cap=cap;state.pointCap=pts;
 const token=++searchToken;state.loading=true;render();
 try{
  const run=await startRun(text,cap,pts);
  if(token!==searchToken)return;
  state.loading=false;state.run=run;state.chat=[];go('results');
 }catch(e){
  if(token!==searchToken)return;
  state.loading=false;render();showSearchError(e.message);
 }
}

/* ---------- Follow-ups: Agent first; changing budget/points re-runs the comparison ---------- */
function localAnswer(q,list){
 const best=list.find(p=>p.id===recommendedId()&&p.eligible);
 if(/points?|pts/i.test(q)){const withPoints=list.find(p=>p.points>0);return best?(best.points?`The recommended plan, ${best.name}, uses ${best.points} points to save ${money(best.pointValue)}, so you pay ${money(best.amount)}. That’s within the ${state.pointCap} points you allowed.`:`The recommended plan, ${best.name}, doesn’t support Campus Wallet points. ${withPoints?`${withPoints.name} can use ${withPoints.points} points to save ${money(withPoints.pointValue)}, but you’d still pay ${money(withPoints.amount)}, more than the recommended ${money(best.amount)}.`:'No eligible plan can use points right now.'} “Up to ${state.pointCap} points” is a limit, not something you must use up.`):'No plan meets all your requirements right now, so no points will be used.'}
 if(/coupon|offer|voucher|discount|stack|combine|student/i.test(q))return best?`${best.name} uses: ${best.offers.map(o=>o.kind==='shipping_waiver'?o.title:o.title+' '+money(o.valueCents)).join(', ')||'no extra offers'}. The expired HK$300 back-to-school coupon is not counted.`:'The student discount is only used when student status is valid and the merchant supports it. The expired HK$300 back-to-school coupon is not counted.';
 if(/deliver|ship|fast|pickup|pick up|when/i.test(q))return list.map(p=>`${esc(p.name)}: ${p.fulfillment}, you pay ${money(p.amount)}${p.eligible?'':' ('+p.reasons.join(', ')+')'}`).join('; ')+'. Delivery and pickup times are demo conditions.';
 if(/why|reason|recommend/i.test(q))return best?`Within your ${money(state.cap)} budget, ${best.name} has the lowest cost including points value, at ${money(best.reference)}. Future rewards are not used to reduce this payment or your budget.`:'No plan meets all requirements right now. Try adjusting your budget or points limit.';
 if(/pay|payment|Tap|Wallet/i.test(q))return best?`The recommended plan uses ${best.paymentName} and you pay ${money(best.amount)}. The payment method is set by the plan and can’t be changed after authorization; to use a different one, choose another plan.`:'There is no plan you can pay for right now. Please adjust your budget first.';
 return 'I can explain offers, points, delivery and payment, or re-compare using a new budget or points limit. This demo only covers the confirmed iPad and won’t switch to another product.';
}
async function ask(q){
 if(!state.run)return;
 const item={q,a:'Looking at the current plans…'};state.chat.push(item);render(true);
 try{
  const parsed=E.parse(q);
  const isChange=/(change|set|adjust|raise|lower|increase|reduce|make|update|budget|no points|without points|up to|at most|max)/i.test(q)&&!/\b(why|how|what|which|are|is|do|does)\b/i.test(q);
  // A follow-up mentioning quantity/spec/colour is merged into the request and re-judged by the backend (it blocks unsupported quantities and specs)
  const changesProduct=/\b\d+\s*(?:units?|pcs?|pieces?|ipads?)\b|\b(?:two|three|four|five|a pair)\b(?:\s+(?:ipads?|units?|tablets?))?|\b(?:quantity|qty)\b|\bx\s*\d+\b|\b(?:64|256|512)\s*(?:gb|g)\b|\b[12]\s*tb\b|\b(?:pro|air|mini)\b|\b(?:blue|pink|yellow|red|purple|green|orange|black|gr[ae]y|starlight|midnight)\b|cellular/i.test(q)&&!/\b(why|how|what|which|are|is|do|does)\b/i.test(q);
  if(changesProduct||(isChange&&(parsed.cap!==undefined||parsed.points!==undefined))){
   const cap=parsed.cap??state.cap,pts=parsed.points??state.pointCap;
   const text=changesProduct?`${applyToText(state.query,cap,pts).replace(/[。.]\s*$/,'')}, ${q}`:applyToText(state.query,cap,pts);
   const old=state.run;
   const run=await startRun(text,cap,pts);
   if(old.pendingAction?.type==='purchase_authorization')API.reject(old.id,old.pendingAction.actionId).catch(()=>{});
   state.run=run;state.cap=cap;state.pointCap=pts;if(!changesProduct)state.query=text;
   const best=API.plansOf(run).find(p=>p.id===run.proposal?.plan?.id&&p.eligible);
   item.a=run.status==='needs_clarification'&&!API.plansOf(run).length?(API.outcomeText(run)||'The product details need to be confirmed first.'):`Re-compared with your new requirements. ${best&&canBuy()?`The recommended plan is now ${best.name}, paying ${money(best.amount)}.`:'No plan meets all requirements, so nothing will go to payment.'}`;
  }else{
   const res=await API.ask(state.run.id,q);
   // With an LLM configured (OPENAI_API_KEY), use the Agent’s answer directly;
   // without one the Agent only returns a fixed sentence, so explain from the backend plan data here.
   item.a=res.agentMode==='langchain_llm_tools'&&res.message?.content?res.message.content:localAnswer(q,API.plansOf(state.run));
  }
 }catch(e){item.a=e.message}
 render(true);
}

/* ---------- Authorize, pay, cancel (resume endpoint) ---------- */
async function snapshot(o,run){
 try{const [tr,tx]=await Promise.all([API.trace(o.id),API.transaction(o.id)]);
  o.snapshot={run,trace:tr.events,transaction:tx};
  o.sandboxOrderId=tx.order?.id||null;
 }catch{}
}
async function applyRun(o,run){
 o.status=API.orderStatus(run);
 o.reason=API.outcomeText(run);
 if(o.status!=='pending')await snapshot(o,run);
}
// When a call fails (expired, duplicate submit, server restart…), trust the server’s real state
async function recover(o,e){
 try{const run=await API.getRun(o.id);await applyRun(o,run);if(o.status==='pending'){toast(e.message);return false}return true}
 catch(e2){if(e2.status===404){o.status='expired';o.reason=GONE;return true}toast(e.message);return false}
}
async function approve(){
 if(!$('#consent')?.checked||!selection||busy)return;
 const run=state.run,action=run.pendingAction,plan=API.plansOf(run).find(p=>p.id===selection.id);
 const existing=state.orders.find(o=>o.id===run.id);
 if(existing){close();go((existing.status==='pending'?'payment/':'result/')+existing.id);return}
 busy=true;const btn=$('#approve');btn.disabled=true;btn.textContent='Creating authorization…';
 try{
  const next=await API.approve(run.id,action.actionId,selection.id);
  state.run=next;
  const o={id:next.id,createdAt:Date.now(),status:'pending',plan,cap:action.maxPaymentCents,payment:null,lock:null,reason:null,sandboxOrderId:null,snapshot:null};
  const pa=next.pendingAction;
  if(pa?.type==='payment_authentication'){
   o.payment={actionId:pa.actionId,paymentSessionId:pa.paymentSessionId,expiresAt:pa.expiresAt};
   try{const tx=await API.transaction(next.id);o.lock={expiresAt:tx.lock.expiresAt,digest:tx.lock.digest}}catch{}
  }else await applyRun(o,next);
  state.orders.unshift(o);persist();busy=false;close();go((o.status==='pending'?'payment/':'result/')+o.id);
 }catch(e){
  busy=false;
  const box=$('#approval-error');if(box)box.innerHTML=`<div class="error">${esc(e.message)}</div>`;
  const b=$('#approve');if(b){b.disabled=!$('#consent')?.checked;b.textContent='Confirm and go to payment'}
 }
}
async function pay(id){
 const o=state.orders.find(o=>o.id===id);if(!o||o.status!=='pending'||busy)return;
 busy=true;render();let done=true;
 try{const run=await API.authenticate(o.id,o.payment.actionId,o.payment.paymentSessionId);await applyRun(o,run)}
 catch(e){done=await recover(o,e)}
 busy=false;persist();done?go('result/'+o.id):render();
}
async function payFail(id){
 const o=state.orders.find(o=>o.id===id);if(!o||o.status!=='pending'||busy)return;
 busy=true;render();let done=true;
 try{const run=await API.failPayment(o.id,o.payment.actionId,o.payment.paymentSessionId);await applyRun(o,run);
  if(o.status==='cancelled'||o.status==='blocked'){o.status='failed';o.reason=`${esc(o.plan.paymentName)} couldn’t complete the payment (simulated). No money was taken and the authorization is closed.`}}
 catch(e){done=await recover(o,e)}
 busy=false;persist();done?go('result/'+o.id):render();
}
async function cancel(id){
 const o=state.orders.find(o=>o.id===id);if(!o||o.status!=='pending'||busy)return;
 busy=true;let done=true;
 try{const run=await API.failPayment(o.id,o.payment.actionId,o.payment.paymentSessionId);await applyRun(o,run);if(o.status==='cancelled')o.reason='You cancelled this authorization. No payment was made.'}
 catch(e){done=await recover(o,e)}
 busy=false;persist();done?go('result/'+o.id):render();
}
// On page load, check the server’s real state for orders awaiting payment
async function refreshPending(){
 let changed=false;
 for(const o of state.orders.filter(o=>o.status==='pending')){
  try{const run=await API.getRun(o.id);if(API.orderStatus(run)!=='pending'){await applyRun(o,run);changed=true}}
  catch(e){if(e.status===404){o.status='expired';o.reason=GONE;changed=true}}
 }
 if(changed){persist();render(true)}
}

/* ---------- Customer after-sales ---------- */
function newestCase(cases){return [...cases].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0]||null}
async function refreshService(o,{redraw=true}={}){
 try{
  const result=await API.afterSalesCases(o.id),latest=newestCase(result.cases||[]);
  if(latest)o.afterSales=latest;
  if(redraw){persist();render(true)}
  return latest;
 }catch(e){if(redraw)toast(e.message);return null}
}
async function refreshAfterSales(){
 let changed=false;
 await Promise.all(state.orders.filter(o=>o.status==='completed').map(async o=>{
  const before=o.afterSales?.updatedAt||'';
  const latest=await refreshService(o,{redraw:false});
  if(latest&&latest.updatedAt!==before)changed=true;
 }));
 if(changed){persist();render(true)}
}
async function requestService(id,action,reason){
 const o=state.orders.find(x=>x.id===id);if(!o||o.status!=='completed'||busy)return;
 const fingerprint=JSON.stringify({action,reason});
 if(o.afterSalesRequest?.fingerprint!==fingerprint)o.afterSalesRequest={fingerprint,idempotencyKey:`customer-ui-${crypto.randomUUID()}`};
 persist();busy=true;render();
 try{
  o.afterSales=await API.createAfterSales(o.id,action,reason,o.afterSalesRequest.idempotencyKey);
  delete o.afterSalesRequest;persist();busy=false;render();toast(action==='return'||action==='exchange'?'Request sent for merchant review':'Request created — please confirm it');
 }catch(e){
  const recovered=await refreshService(o,{redraw:false});
  busy=false;if(recovered){delete o.afterSalesRequest;persist();render();toast('Existing after-sales request restored');return}
  render();const box=$('#service-error');if(box)box.innerHTML=`<div class="error">${esc(e.message)} You can retry safely with the same request key.</div>`;
 }
}
async function decideService(id,decision){
 const o=state.orders.find(x=>x.id===id),c=o?.afterSales;if(!o||c?.status!=='USER_CONFIRMATION_REQUIRED'||busy)return;
 busy=true;render();
 try{o.afterSales=await API.resumeAfterSales(c.id,c.pendingAction.actionId,decision);toast(decision==='approve'?'After-sales request confirmed':'Your order was kept')}
 catch(e){const fresh=await refreshService(o,{redraw:false});if(!fresh)toast(e.message)}
 busy=false;persist();render();
}
async function refreshServiceStatus(id){
 const o=state.orders.find(x=>x.id===id);if(!o||busy)return;
 busy=true;render();
 try{
  if(o.afterSales)o.afterSales=await API.afterSalesCase(o.afterSales.id);else await refreshService(o,{redraw:false});
  toast('After-sales status refreshed');
 }catch(e){toast(e.message)}
 busy=false;persist();render();
}

async function download(id){
 const o=state.orders.find(o=>o.id===id);if(!o)return;
 let snap=o.snapshot;
 try{const [run,tr,tx]=await Promise.all([API.getRun(o.id),API.trace(o.id),API.transaction(o.id)]);snap={run,trace:tr.events,transaction:tx}}catch{}
 if(!snap){toast('The server no longer has this record, so it can’t be downloaded');return}
 let afterSales=o.afterSales;try{if(afterSales)afterSales=await API.afterSalesCase(afterSales.id)}catch{}
 const payload={schema:'campuscart.agent-run.v1',exported_at:new Date().toISOString(),environment:'sandbox',disclosure:'Sandbox data only. No real identity verification, merchant order, payment or shipping. Hash chains detect modification of a saved copy but are not independent attestation.',agent_run_id:o.id,run:snap.run,agent_trace:snap.trace,transaction:snap.transaction,after_sales:afterSales||null,verification:{transaction_audit_chain_valid:snap.transaction?.auditChainValid??null,after_sales_audit_chain_valid:afterSales?.auditChainValid??null,algorithm:'SHA-256'}};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=shortId(o)+'-record.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Purchase record downloaded');
}
function about(){const mode=state.caps?.modelConfigured?`Language model connected (${esc(state.caps.model||'')}); follow-up questions are answered by the model.`:'No language model configured (OPENAI_API_KEY): the Agent uses deterministic rules, and follow-ups are answered by the front end from the backend plan data.';
 modal(`${head('CampusCart demo','Complete a purchase within your authorization.')}<p style="font-size:15px;line-height:1.9">Try shopping, comparing offers, confirming authorization and paying. Comparison, authorization, pre-checks, payment and audit are all done by the backend Agent (LangChain + LangGraph). Merchants, status, offers, payments and orders are all Sandbox data, with no real charge or shipment.</p><hr class="divider"><p class="muted" style="font-size:14px">${mode} Order summaries are kept in this browser; the full record lives in the Agent service’s memory, so orders awaiting payment become invalid after the service restarts.</p><div class="modal-actions"><button class="primary" data-action="close">Got it</button></div>`)}

/* ---------- Events ---------- */
document.addEventListener('submit',e=>{if(e.target.id==='search-form'){e.preventDefault();search()}if(e.target.id==='chat-form'){e.preventDefault();const q=$('#followup').value.trim();if(q)ask(q)}if(e.target.id==='service-form'){e.preventDefault();const reason=$('#service-reason').value.trim(),action=new FormData(e.target).get('service-action');if(reason.length<3){const box=$('#service-error');box.innerHTML='<div class="error">Please add at least three characters about your request.</div>';return}requestService(e.target.dataset.orderId,action,reason)}});
document.addEventListener('input',e=>{if(e.target.id==='query'){state.query=e.target.value;const p=E.parse(state.query);if(p.cap!==undefined){state.cap=p.cap;if(p.cap)$('#budget').value=p.cap/100}if(p.points!==undefined){state.pointCap=p.points;$('#points').value=p.points}}if(e.target.id==='consent')$('#approve').disabled=!e.target.checked});
document.addEventListener('change',e=>{const el=e.target;if(el.id==='budget'){state.cap=E.cents(el.value);syncQuery()}if(el.id==='points'){state.pointCap=Number(el.value);syncQuery()}});
function syncQuery(){const q=$('#query');if(!q)return;q.value=state.query=applyToText(q.value,state.cap,state.pointCap)}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;
 if(b.dataset.go){close();go(b.dataset.go);return}
 if(b.dataset.action==='close'){close();return}
 if(b.dataset.action==='retry'){retryBoot();return}
 if(b.dataset.preset){const k=b.dataset.preset;state.cap=k==='tight'?330000:360000;state.pointCap=k==='nopoints'?0:100;state.query=`Help me buy this iPad, budget ${money(state.cap)}, ${state.pointCap?'up to 100 points':'no points'}.`;render();return}
 if(b.dataset.choose){showAuthorization(b.dataset.choose);return}
 if(b.dataset.question){ask(b.dataset.question);return}
 if(b.dataset.filter){state.filter=b.dataset.filter;render();return}
 if(b.dataset.pay){pay(b.dataset.pay);return}
 if(b.dataset.cancel){cancel(b.dataset.cancel);return}
 if(b.dataset.payfail){payFail(b.dataset.payfail);return}
 if(b.dataset.service){go('service/'+b.dataset.service);return}
 if(b.dataset.serviceDecision){decideService(b.dataset.orderId,b.dataset.serviceDecision);return}
 if(b.dataset.serviceRefresh){refreshServiceStatus(b.dataset.serviceRefresh);return}
 if(b.dataset.download){download(b.dataset.download);return}
 if(b.dataset.action==='approve'){approve();return}
 if(b.dataset.action==='about'){about();return}
 if(b.dataset.action==='receipt-info'){modal(`${head('About this purchase record')}<p style="font-size:14px;line-height:1.9">The record comes from the Agent service. It contains the tool-call trace and the transaction audit (two hash chains), plus the product, merchant, benefits and payment scope you confirmed. Save it with “Download purchase record”. It is a simulated transaction record, not a merchant invoice or real payment receipt.</p><div class="modal-actions"><button class="primary" data-action="close">Got it</button></div>`);return}
});
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const r=$('#dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}});
window.addEventListener('hashchange',()=>{if(state.loading){state.loading=false;searchToken++}close();render()});
window.addEventListener('storage',e=>{if(e.key!==KEY||!e.newValue)return;try{state.orders=JSON.parse(e.newValue).orders;close();render()}catch{}});

/* ---------- Optional: let WebMCP-capable browser assistants read/set shopping conditions ---------- */
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
 const registrations=[
 {name:'read_shopping_demo',title:'Read shopping demo state',description:'Read-only view of the current purchase conditions, plans and simulated order summaries; no real identity or account is read.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute(input){if(input&&Object.keys(input).length)throw new Error('No parameters accepted');return {environment:'agent_sandbox',run_id:state.run?.id||null,run_status:state.run?.status||null,request:{cap:state.cap,points:state.pointCap},plans:API.plansOf(state.run).map(p=>({merchant:p.merchantId,cash_cents:p.amount,points:p.points,eligible:p.eligible})),orders:state.orders.map(o=>({id:o.id,status:o.status,amount:o.plan.amount}))}}},
 {name:'stage_ipad_comparison',title:'Set shopping conditions',description:'Set the budget and points limit for the iPad demo and open the shop home page. Does not search, authorize, pay or create orders.',inputSchema:{type:'object',properties:{budget:{type:'number',minimum:.01,maximum:1000000},points:{type:'integer',minimum:0,maximum:100000}},required:['budget','points'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||Object.keys(input).some(k=>!['budget','points'].includes(k))||E.cents(input.budget)===null||!Number.isInteger(input.points)||input.points<0||input.points>100000)throw new Error('Invalid budget or points');state.cap=E.cents(input.budget);state.pointCap=input.points;state.query=`Help me buy this iPad, budget ${money(state.cap)}, up to ${state.pointCap} points.`;state.loading=false;searchToken++;go('shop');render();return {staged:true,budget:input.budget,points:input.points}}}
 ];for(const tool of registrations){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{})}catch{}}
}

/* ---------- Boot ---------- */
async function boot(){
 state.bootError=null;render();
 try{[state.meta,state.caps]=await Promise.all([API.bootstrap(),API.capabilities()])}
 catch(e){state.bootError=e.message}
 render();
 if(state.meta){refreshPending();refreshAfterSales()}
}
function retryBoot(){boot()}
boot();
})();
