/* Small front-end helpers: money conversion and parsing of the request text
   (only used to keep the input boxes and the text description in sync).
   Pricing, offers, authorization, payment and audit are all done by the backend Agent. */
window.CampusEngine = (() => {
 // Display copy; the sku must match the product SKU in the backend src/domain/seed.js.
 const PRODUCT={sku:'EDU-IPAD-A16-128-SLV',name:'iPad (A16)',spec:'128GB · Wi-Fi · Silver',base:359900};
 function cents(value){const s=String(value).replace(/,/g,'');if(!/^\d+(\.\d{1,2})?$/.test(s))return null;const [w,d='']=s.split('.');const n=Number(w)*100+Number(d.padEnd(2,'0'));return Number.isSafeInteger(n)&&n>0&&n<=100000000?n:null}
 const NUM='((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)';
 const BUDGET_SRC='(?:budget|up to|at most|no more than|under|max(?:imum)?|cap|limit)(?:\\s+(?:is|of|to|at))?\\s*(?:HK\\s*\\$|HKD\\s*|\\$)?\\s*'+NUM+'(?!\\d|[,.]\\d|\\s*(?:points?|pts?)\\b)';
 const BUDGET_RE=new RegExp(BUDGET_SRC,'i');
 const POINTS_RE=/(?:up to|at most|max(?:imum)?(?: of)?|use|limit)\s*(\d+)\s*(?:points?|pts?)\b/i;
 function parse(text){const t=text;const r={};
  const budget=t.match(BUDGET_RE);
  if(budget)r.cap=cents(budget[1]);
  const points=t.match(POINTS_RE);if(points)r.points=Number(points[1]);
  if(/\bno points\b|(?:do not|don't|dont) use (?:any )?points|without points/i.test(t))r.points=0;
  return r}
 return {PRODUCT,cents,parse,BUDGET_RE,POINTS_RE};
})();
