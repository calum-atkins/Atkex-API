/**
 * Consolidate an array of MT5 deals into 1 record per positionId.
 * (Your original body unchanged)
 */
function consolidateDealsToHedges(
  deals,
  { deps: { symbolCatalog } } = {}
) {
  // Filter to actual trade legs only
  const tradeDeals = deals.filter(
    d => d.entryType === "DEAL_ENTRY_IN" || d.entryType === "DEAL_ENTRY_OUT"
  );
  
  // group by positionId; fallback to orderId -> id
  const groups = new Map();
  for (const d of tradeDeals) {
    const key = (d.positionId || d.orderId || d.id || "").toString();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const hedges = [];

  for (const [positionKey, arr] of groups.entries()) {
    // sort by time to be safe
    arr.sort((a, b) => new Date(a.time) - new Date(b.time));

    const ins  = arr.filter(x => x.entryType === "DEAL_ENTRY_IN");
    const outs = arr.filter(x => x.entryType === "DEAL_ENTRY_OUT");

    // derive some basics
    const any = arr[0] || {};
    const symbol   = any.symbol || null;
    const platform = any.platform || null;

    // open leg (first IN)
    const firstIn = ins[0];
    const openTime = firstIn ? firstIn.time : null;
    const openPrice = firstIn ? firstIn.price : null;

    // sums/volumes
    const totalInVolume  = ins.reduce((s, x) => s + (x.volume || 0), 0);
    const totalOutVolume = outs.reduce((s, x) => s + (x.volume || 0), 0);

    // Close aggregation (volume-weighted)
    const closeTime = outs.length ? outs[outs.length - 1].time : null;
    let wCloseNum = 0;
    for (const o of outs) if (o.volume && o.price) wCloseNum += o.price * o.volume;
    const closePrice = totalOutVolume > 0 ? wCloseNum / totalOutVolume : null;

    // money
    const totalProfit     = arr.reduce((s, x) => s + (Number(x.profit) || 0), 0);
    const totalCommission = arr.reduce((s, x) => s + (Number(x.commission) || 0), 0);
    const totalSwap       = arr.reduce((s, x) => s + (Number(x.swap) || 0), 0);

    const totalFees = totalCommission + totalSwap;

    // determine side from IN legs (robust for partial-ins)
    // net > 0 => BUY bias, net < 0 => SELL bias
    let net = 0;
    for (const i of ins) {
      if (i.type === "DEAL_TYPE_BUY")  net += (i.volume || 0);
      if (i.type === "DEAL_TYPE_SELL") net -= (i.volume || 0);
    }
    let side = null;
    if (net > 0) side = "BUY";
    else if (net < 0) side = "SELL";
    else if (firstIn) side = (firstIn.type === "DEAL_TYPE_SELL" ? "SELL" : "BUY");

    // optional: first OUT profit if you want that meaning for X1st_Trade_Profit__c
    const firstOutProfit = outs.length ? Number(outs[0].profit) || 0 : 0;
    
    const entryType = any.entryType;
    const time = any.time;
    const price = any.price;
    const volume = any.volume;
    const profit = any.profit;
    
    // Outcome + SL/TP extraction from OUT deals
    const { outcome, slPrice, tpPrice } = deriveOutcomeAndStops(outs);
    
    // Build SR_Hedge__c record (fixed)
    const currencyId =
      symbol &&
      symbolCatalog &&
      typeof symbolCatalog.getIdBySymbolName === "function"
        ? (symbolCatalog.getIdBySymbolName(symbol) || null)
        : null;

    // prefer explicit first OUT for "first close price" semantics;
    // keep volume-weighted closePrice for the consolidated close price.
    const firstOut = outs.length ? outs[0] : null;

    const rec = {
      UUID_Text__c: positionKey,
      attributes: { type: "SR_Hedge__c" },

      // Safe symbol lookup
      Currency__c: currencyId,

      // Side from your computed net; fixes the ternary that referenced entryType wrongly
      Side__c: side,

      // Profit consolidation (you said profit was fine)
      X1st_Trade_Profit__c: totalProfit,
      Fees__c: outs.length ? totalFees : null,

      // OPEN fields (from first IN)
      X1st_Trade_Open_Price__c: firstIn ? firstIn.price : null,
      Open_Date_Time__c: openTime || null,
      X1st_Trade_Units__c: firstIn ? firstIn.volume : null,
      Open_Comments__c: firstIn ? "API" : null,
      Open_Screenshot__c: firstIn ? "API" : null,

      // CLOSE fields (from OUT legs; use last OUT time and either first OUT price or VWAP)
      // If you want the consolidated close price, use `closePrice`; if you want first OUT, use `firstOut?.price`.
      X1st_Trade_Close_Price__c: firstOut ? firstOut.price : (closePrice ?? null),
      Close_Date_Time__c: closeTime || null,
      Closing_Comments__c: outs.length ? "API" : null,
      Close_Screenshot__c: outs.length ? "API" : null,
      
      // Reason outing
      Outcome__c: outcome || null,
      Stop_Loss_Price__c: slPrice != null && isFinite(slPrice) ? slPrice : null,
      Take_Profit_Price__c: tpPrice != null && isFinite(tpPrice) ? tpPrice : null,
    };

    hedges.push(rec);
  }

  return hedges;
}

// Helper: parse [sl 3628.00] or [tp 3628.00] from brokerComment
function parseSlTpFromComment(comment) {
  if (!comment || typeof comment !== "string") return { sl: null, tp: null };
  const m = /\[(sl|tp)\s+([\d.]+)\]/i.exec(comment);
  if (!m) return { sl: null, tp: null };
  const tag = m[1].toLowerCase();
  const price = Number(m[2]);
  if (!isFinite(price)) return { sl: null, tp: null };
  return tag === "sl" ? { sl: price, tp: null } : { sl: null, tp: price };
}

// Helper: derive Outcome + SL/TP prices from OUT legs
function deriveOutcomeAndStops(outs) {
  let outcome = null;
  let slPrice = null;
  let tpPrice = null;

  for (const o of outs) {
    const reason = (o && o.reason ? String(o.reason) : "").toUpperCase();
    // Prefer explicit fields
    if (reason.includes("SL")) {
      outcome = outcome || "SL";
      if (slPrice == null) {
        slPrice = (o.stopLoss != null ? Number(o.stopLoss) : null);
        if (slPrice == null) {
          const parsed = parseSlTpFromComment(o.brokerComment);
          if (parsed.sl != null) slPrice = parsed.sl;
        }
      }
    } else if (reason.includes("TP")) {
      outcome = outcome || "TP";
      if (tpPrice == null) {
        // MT5 may send takeProfit or not; fall back to comment
        const maybeTp = o.takeProfit != null ? Number(o.takeProfit) : null;
        if (maybeTp != null && isFinite(maybeTp)) {
          tpPrice = maybeTp;
        } else {
          const parsed = parseSlTpFromComment(o.brokerComment);
          if (parsed.tp != null) tpPrice = parsed.tp;
        }
      }
    } else {
      // Keep scanning; we only set "Manual" later if nothing was SL/TP
    }
  }

  if (!outcome && outs.length > 0) {
    // Closed but not by SL/TP (e.g., manual close / opposite hedge)
    outcome = "Manual";
  }

  return { outcome, slPrice, tpPrice };
}

module.exports = { consolidateDealsToHedges };
