/* ============================================================
   SolarSizer ZA — sizing engine v0.9.0
   Pure functions. No DOM. Loaded by index.html; also runs under
   node (tests/engine.test.js) via the module.exports guard below.

   Data source: ERA5 reanalysis via Open-Meteo Archive API
   (attribution: Open-Meteo / ECMWF–Copernicus, CC BY 4.0).
   Methodology documented in index.html §Methodology.
   ============================================================ */

const CFG = {
  VERSION: '0.9.0',
  PANEL_W_DEFAULT: 590,
  // Single-phase hybrid classes sold in SA (Deye/Sunsynk/Goodwe style ladder)
  LADDER_1P: [3.6, 5, 6, 8, 10, 12],
  LADDER_3P: [16, 20, 25, 30],
  BATT_MODULE_KWH: 5.12,      // 51.2 V 100 Ah LiFePO4 — the SA standard module
  BATT_DOD: 0.90,             // usable depth of discharge (LiFePO4)
  INV_EFF: 0.96,              // battery→load conversion efficiency
  GAMMA_TEMP: -0.0034,        // module power temp coefficient per °C (mono PERC typical)
  CELL_RISE: 28,              // cell temp above ambient at operating point (flush roof mount)
  FIXED_LOSS: { soiling: 0.97, mismatch: 0.98, dcWiring: 0.98, inverter: 0.96, acWiring: 0.995, availability: 0.99 },
  DIVERSITY_ABOVE_W: 3000,    // above this raw sum, apply diversity factor
  DIVERSITY: 0.75,
  INV_CONT_HEADROOM: 1.25,    // continuous sizing headroom
  INV_SURGE_FACTOR: 2,        // typical hybrid: 2× rated for ~10 s
  COSTS: { panelR: 2400, invPerKwR: 5800, battPerKwhR: 5000, bosBaseR: 15000, bosPctOfHw: 0.10 },
  SELFUSE: { noBatt: 0.55, oneModule: 0.85, multiModule: 0.95 },
  TARIFF_DEFAULT_R: 3.00,     // editable; Eskom direct ≈ R2.71–2.90 (2026), municipal varies
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* Appliance table — South African household averages.
   w = average watts while running (24 h items already averaged over
   compressor cycling). surgeW = start-up peak for motor loads.
   heat = resistive/thermal load — keep off backup circuits. */
const APPLIANCES = [
  // Essentials — typical backup circuits
  { id:'fridge',  n:'Fridge + freezer',                 w:160,  h:24,  cat:'ess', on:true,  motor:true, surgeW:700,  note:'averaged over compressor cycling' },
  { id:'lights',  n:'Lights (LED, whole home)',         w:100,  h:5,   cat:'ess', on:true },
  { id:'router',  n:'Wi-Fi router + fibre ONT',         w:15,   h:24,  cat:'ess', on:true },
  { id:'tv',      n:'TV + decoder / streaming',         w:150,  h:5,   cat:'ess', on:true },
  { id:'charge',  n:'Laptops & phone charging',         w:100,  h:4,   cat:'ess', on:true },
  { id:'alarm',   n:'Alarm, electric fence, cameras',   w:45,   h:24,  cat:'ess', on:true },
  { id:'gatem',   n:'Gate motor',                       w:300,  h:0.2, cat:'ess', on:true,  motor:true, surgeW:1000 },
  { id:'freezer', n:'Chest freezer (separate)',         w:90,   h:24,  cat:'ess', on:false, motor:true, surgeW:450, note:'averaged over compressor cycling' },
  // Kitchen & laundry — usually OFF backup circuits
  { id:'geyser',  n:'Geyser (electric, 150 ℓ)',         w:2000, h:3,   cat:'kit', on:false, heat:true },
  { id:'hob',     n:'Stove plate / hob',                w:1500, h:1,   cat:'kit', on:false, heat:true },
  { id:'oven',    n:'Oven',                             w:2200, h:0.75,cat:'kit', on:false, heat:true },
  { id:'kettle',  n:'Kettle',                           w:2200, h:0.25,cat:'kit', on:false },
  { id:'micro',   n:'Microwave',                        w:1200, h:0.5, cat:'kit', on:false },
  { id:'wash',    n:'Washing machine',                  w:500,  h:1,   cat:'kit', on:false, motor:true, surgeW:1200 },
  { id:'dryer',   n:'Tumble dryer',                     w:2400, h:1,   cat:'kit', on:false, heat:true },
  { id:'dish',    n:'Dishwasher',                       w:1300, h:1,   cat:'kit', on:false, heat:true },
  { id:'iron',    n:'Iron',                             w:1400, h:0.5, cat:'kit', on:false, heat:true },
  // Heating, cooling & outdoor
  { id:'aircon',  n:'Aircon (bedroom, inverter type)',  w:900,  h:5,   cat:'out', on:false, motor:true, surgeW:1800 },
  { id:'heater',  n:'Heater (panel / fan)',             w:1500, h:4,   cat:'out', on:false, heat:true },
  { id:'pool',    n:'Pool pump',                        w:1100, h:6,   cat:'out', on:false, motor:true, surgeW:3300 },
  { id:'pump',    n:'Water pressure / borehole pump',   w:750,  h:1,   cat:'out', on:false, motor:true, surgeW:2800 },
  { id:'office',  n:'Home office (PC + monitors)',      w:200,  h:8,   cat:'out', on:false },
];

/* ---- radiation + temperature → monthly yield ------------------ */

function monthAgg(dates, radMJ, tempC) {
  const buckets = MONTHS.map(() => ({ rad: [], t: [] }));
  dates.forEach((iso, i) => {
    const m = parseInt(iso.slice(5, 7), 10) - 1;
    if (radMJ[i] != null) buckets[m].rad.push(radMJ[i]);
    if (tempC && tempC[i] != null) buckets[m].t.push(tempC[i]);
  });
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return buckets.map((b, i) => {
    const psh = b.rad.length ? mean(b.rad) / 3.6 : null;   // MJ/m²/day → kWh/m²/day (= peak sun hours)
    return {
      m: i,
      name: MONTHS[i],
      days: b.rad.length,
      psh,
      tavg: mean(b.t),
    };
  }).filter(x => x.days > 0);
}

function derateFor(tavg) {
  const f = CFG.FIXED_LOSS;
  const hw = f.soiling * f.mismatch * f.dcWiring * f.inverter * f.acWiring * f.availability;
  const cellTemp = (tavg ?? 18) + CFG.CELL_RISE;
  let tempF = 1 + CFG.GAMMA_TEMP * (cellTemp - 25);
  tempF = Math.max(0.80, tempF);                            // safety floor
  return { hw, tempF, total: hw * tempF, cellTemp };
}

function enrichMonths(monthsRaw) {
  return monthsRaw.map(m => {
    const d = derateFor(m.tavg);
    return { ...m, derate: d.total, tempF: d.tempF, cellTemp: d.cellTemp, yieldPerKwpDay: m.psh * d.total };
  });
}

/* ---- inverter ladder ------------------------------------------- */

function snapInverter(kwNeedCont, surgeNeedW) {
  let cls = CFG.LADDER_1P.find(k => k >= kwNeedCont);
  let threePhase = false;
  if (cls === undefined) {
    cls = CFG.LADDER_3P.find(k => k >= kwNeedCont);
    threePhase = true;
  }
  if (cls === undefined) cls = Math.ceil(kwNeedCont / 5) * 5;
  const surgeOk = !surgeNeedW || (cls * 1000 * CFG.INV_SURGE_FACTOR >= surgeNeedW);
  return { cls, threePhase, surgeOk };
}

/* ---- main sizing ------------------------------------------------
   inp = { goal:'backup'|'offset'|'offgrid',
           kwhM, hours, pct, tariffR, panelW,
           apps:[{id,w,h,on,...}] (resolved appliance states),
           months: enriched months (from enrichMonths) }
   returns full result object for rendering. */

function sizeSystem(inp) {
  const kwhM = clamp(inp.kwhM || 600, 50, 5000);
  const hours = clamp(inp.hours || 4, 2, 12);
  const pct = clamp(inp.pct || 70, 10, 100) / 100;
  const tariffR = inp.tariffR > 0 ? inp.tariffR : CFG.TARIFF_DEFAULT_R;
  const panelW = inp.panelW || CFG.PANEL_W_DEFAULT;

  const checked = inp.apps.filter(a => a.on);
  const essKwhDay = sum(checked.map(a => a.w * a.h / 1000));          // kWh/day
  const contPeakRaw = sum(checked.map(a => a.w));                      // W, everything at once
  const divPeak = contPeakRaw > CFG.DIVERSITY_ABOVE_W ? contPeakRaw * CFG.DIVERSITY : contPeakRaw;
  const motors = checked.filter(a => a.motor);
  const biggestSurge = motors.length ? Math.max(...motors.map(a => a.surgeW)) : 0;
  const nonMotorW = sum(checked.filter(a => !a.motor).map(a => a.w));
  const surgeNeedW = nonMotorW + biggestSurge;                          // largest motor starts, rest running

  const months = inp.months;
  const pshAnnual = weightedMean(months.map(m => m.psh), months.map(m => m.days));
  const worst = months.reduce((a, b) => (b.psh < a.psh ? b : a), months[0]);
  const annualYieldPerKwp = sum(months.map(m => m.yieldPerKwpDay * m.days)); // kWh/kWp/yr

  const dailyUse = kwhM / 30;
  let kwArrayIdeal, battNominalKwh = 0, invKwNeed, notes = [], selfUse;

  if (inp.goal === 'backup') {
    // Battery: outage window + evening essentials, through DoD and inverter
    const windowShare = Math.min(1, hours / 24) + 0.35;
    const battOutKwh = Math.min(essKwhDay, essKwhDay * windowShare);
    battNominalKwh = battOutKwh / (CFG.BATT_DOD * CFG.INV_EFF);
    // Array: cover daily essentials (+10%) and recover one battery every 3 days, on worst-month sun
    const ePerDay = essKwhDay * 1.1 + (battNominalKwh * CFG.BATT_DOD) / 3;
    kwArrayIdeal = ePerDay / (worst.psh * worst.derate);
    invKwNeed = divPeak * CFG.INV_CONT_HEADROOM / 1000;
    selfUse = 0.95;
    if (checked.some(a => a.heat)) {
      notes.push('Heat loads are ticked (geyser/stove/heater…). Keep them OFF backup circuits — one geyser element empties a 5 kWh battery in about 2 hours. They belong in the “cut my bill” plan.');
    }
  } else if (inp.goal === 'offset') {
    kwArrayIdeal = dailyUse * pct / (pshAnnual * weightedMean(months.map(m => m.derate), months.map(m => m.days)));
    battNominalKwh = inp.battStarter ? CFG.BATT_MODULE_KWH : 0; // optional evening self-use module
    invKwNeed = Math.max(divPeak * CFG.INV_CONT_HEADROOM / 1000, dailyUse * 0.30); // ≈1 kW per 100–120 kWh/month
    selfUse = inp.battStarter ? CFG.SELFUSE.oneModule : CFG.SELFUSE.noBatt;
    if (pct >= 0.8) notes.push('At ≥80% offset your system may export to the grid. Your municipality requires SSEG registration and a NRS 097-compliant inverter for that — your installer handles it.');
    if (!inp.battStarter) notes.push('Without a battery you use roughly ' + Math.round(CFG.SELFUSE.noBatt * 100) + '% of what you generate yourself (the rest is exported or clipped). Adding one 5.12 kWh module lifts self-use to ≈' + Math.round(CFG.SELFUSE.oneModule * 100) + '%.');
  } else { // offgrid
    battNominalKwh = dailyUse * 1.5 / (CFG.BATT_DOD * CFG.INV_EFF);   // 1.5 days autonomy
    kwArrayIdeal = dailyUse * 1.25 / (worst.psh * worst.derate);      // winter + recovery margin
    invKwNeed = Math.max(divPeak * 1.3 / 1000, dailyUse * 0.30);
    selfUse = 1;
    if (checked.some(a => a.heat)) {
      notes.push('Off-grid rule of thumb: cooking, water heating and space heating go gas / solar-thermal / wood. Electric heating off batteries is brutally expensive per kWh.');
    }
    if (battNominalKwh > 4 * CFG.BATT_MODULE_KWH) notes.push('Battery bank above ~20 kWh: budget for a backup generator for long cloudy spells in June–July.');
  }

  // Hardware snap
  const panels = Math.max(1, Math.ceil(kwArrayIdeal * 1000 / panelW));
  const kwActual = panels * panelW / 1000;
  const battModules = battNominalKwh > 0 ? Math.max(1, Math.ceil(battNominalKwh / CFG.BATT_MODULE_KWH)) : 0;
  const battInstalledKwh = battModules * CFG.BATT_MODULE_KWH;
  const inv = snapInverter(invKwNeed, surgeNeedW);
  if (!inv.surgeOk) notes.push('Motor start-up surge is tight on a ' + inv.cls + ' kW unit — your installer may specify a soft-start kit or step up one size.');
  const dcAcRatio = inv.cls > 0 ? kwActual / inv.cls : 0;
  if (dcAcRatio > 1.5) notes.push('Array-to-inverter ratio is high (' + dcAcRatio.toFixed(2) + '). Fine for winter-biased designs; expect summer midday clipping.');

  // Monthly generation for THIS array
  const genM = months.map(m => ({ ...m, genKwh: kwActual * m.yieldPerKwpDay * m.days }));
  const genAnnual = sum(genM.map(g => g.genKwh));

  // Costs (editable defaults; indicative Aug 2026 hardware pricing)
  const C = { ...CFG.COSTS };
  for (const [k, v] of Object.entries(inp.costOverrides || {})) {
    if (typeof v === 'number' && isFinite(v) && v > 0) C[k] = v; // empty UI fields can't poison the maths
  }
  const costPanels = panels * C.panelR;
  const costInv = inv.cls * C.invPerKwR;
  const costBatt = battInstalledKwh * C.battPerKwhR;
  const hw = costPanels + costInv + costBatt;
  const costBos = battModules > 0 || panels > 0 ? C.bosBaseR + hw * C.bosPctOfHw : 0;
  const totalCost = hw + costBos;

  // Savings & payback. Backup-only systems offset only their essential
  // circuits (the rest of the house still buys grid power), so cap the
  // claim at what the essentials actually consume.
  const savingsCap = inp.goal === 'backup' ? essKwhDay * 365 : genAnnual;
  const savingsAnnual = Math.min(genAnnual, savingsCap) * selfUse * tariffR;
  const paybackYears = savingsAnnual > 0 ? totalCost / savingsAnnual : null;
  const juneIdx = genM.findIndex(g => g.name === 'Jun');
  const juneGen = juneIdx >= 0 ? genM[juneIdx].genKwh : null;

  return {
    version: CFG.VERSION, goal: inp.goal, kwhM, hours, pct: pct * 100, tariffR, panelW,
    essKwhDay, contPeakRaw, divPeak, surgeNeedW,
    pshAnnual, worstMonth: { name: worst.name, psh: worst.psh, derate: worst.derate, tavg: worst.tavg },
    annualYieldPerKwp,
    panels, panelWKw: kwActual, kwArrayIdeal,
    battModules, battInstalledKwh, battNominalKwh,
    inverter: inv, invKwNeed: round(invKwNeed, 2), dcAcRatio: round(dcAcRatio, 2),
    months: genM, genAnnual,
    costs: { panels: costPanels, inverter: costInv, battery: costBatt, bos: costBos, total: totalCost, hw },
    savingsAnnual, paybackYears: paybackYears != null ? round(paybackYears, 1) : null,
    juneCoveragePct: (inp.goal === 'offset' && kwhM > 0 && juneGen != null) ? round(juneGen / kwhM * 100, 0) : null,
    selfUse, notes,
  };
}

/* ---- helpers ---------------------------------------------------- */
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round(v, d) { const p = Math.pow(10, d); return Math.round(v * p) / p; }
function weightedMean(vals, weights) {
  const tw = sum(weights);
  return tw ? sum(vals.map((v, i) => v * weights[i])) / tw : null;
}

/* node interop for tests */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CFG, MONTHS, APPLIANCES, monthAgg, derateFor, enrichMonths, snapInverter, sizeSystem, sum, clamp };
}
