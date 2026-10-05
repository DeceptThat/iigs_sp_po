// Adaptive drying-rate model.
//
//   rate = a + b * (VPD - VPD_REF)      percentage points of soil moisture per hour
//
// `a` is what this pot does at reference conditions; `b` is how much faster it
// dries as the air pulls harder. Both begin as priors and are drawn toward the
// observations by weighted ridge regression.
//
// The pull on `b` is governed by how much VPD actually VARIES across the
// observed segments, not by how many there are. A coefficient on a variable
// that never moves cannot be identified, and the model reports that rather
// than inventing a slope.

export const VPD_REF = 1.3;

export function svp(tempC) {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

export function vpd(tempC, rhPercent) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rhPercent)) return null;
  return svp(tempC) * (1 - rhPercent / 100);
}

// Splits a time-ordered reading list into drying segments. A segment ends at a
// rise in soil moisture (a watering) or a gap long enough that the intervening
// behaviour is unknown.
//
// SUBJECT EPOCH
//
// `a` describes THIS pot — substrate, pot volume, root mass and leaf area all
// folded into one observed rate. Replace the pot and every earlier segment
// describes a different physical system.
//
// The recency weighting cannot absorb that. It was built for slow drift (soil
// compacting, roots growing) with a 21-day half-life, and when the test
// subject was replaced on 1 Oct 2026 it still gave 67-81 % weight to segments
// from a pot that was no longer in the system. The fit was not merely
// low-confidence; it was MIS-SPECIFIED.
//
// Pooling across the change is worse than it first looks. Subject 1 was
// observed at VPD 0.69-1.08 kPa and subject 2 runs at 1.17-1.45. Pooled, that
// is ~0.3 kPa of apparent spread and ~30 % trust — entirely an artifact of the
// pot changing. Stated confidence would have RISEN as a wrong model
// accumulated data, which is the worst failure a self-assessing estimator can
// have, because the one number meant to catch the error reports the error as
// progress.
//
// Segments before the epoch are therefore EXCLUDED, not down-weighted. A
// weight can be overcome by volume; an exclusion cannot. The fit falls back
// to coldStartRate(profile), which is exactly what the a0 prior exists for.
export function findSegments(
  readings,
  { riseBreak = 3, maxGapHours = 3, subjectEpoch = 0 } = {},
) {
  const rows = readings
    .filter(r => Number.isFinite(r.soil_moisture_percent) && Number.isFinite(r.timestamp))
    .filter(r => !subjectEpoch || r.timestamp >= subjectEpoch)
    .sort((p, q) => p.timestamp - q.timestamp);

  const segs = [];
  let cur = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      const rise = rows[i].soil_moisture_percent - rows[i - 1].soil_moisture_percent;
      const gapH = (rows[i].timestamp - rows[i - 1].timestamp) / 3600;
      if (rise >= riseBreak || gapH > maxGapHours) { segs.push(cur); cur = []; }
    }
    cur.push(rows[i]);
  }
  segs.push(cur);
  return segs.map(summarise).filter(Boolean);
}

function summarise(seg, { minPoints = 4, minHours = 3 } = {}) {
  if (seg.length < minPoints) return null;
  const t0 = seg[0].timestamp;
  const hours = (seg[seg.length - 1].timestamp - t0) / 3600;
  if (hours < minHours) return null;

  const xs = seg.map(r => (r.timestamp - t0) / 3600);
  const ys = seg.map(r => r.soil_moisture_percent);
  const { slope, r2 } = ols(xs, ys);
  if (!(slope < 0)) return null;                 // not drying

  const vs = seg.map(r => vpd(r.temperature_c, r.humidity_percent)).filter(Number.isFinite);
  if (!vs.length) return null;

  return {
    tStart: t0,
    tEnd: seg[seg.length - 1].timestamp,
    hours,
    points: seg.length,
    rate: -slope,                                 // positive %/hr
    r2,
    vpd: vs.reduce((s, v) => s + v, 0) / vs.length,
    soilStart: ys[0],
    soilEnd: ys[ys.length - 1],
  };
}

function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

const DEFAULTS = {
  a0: 1.0,               // prior drying rate at VPD_REF, %/hr
  b0: 0.70,              // prior sensitivity, %/hr per kPa
  halfLifeDays: 21,      // older segments count for less: soil compacts, roots grow
  spreadScale: 0.35,     // kPa of VPD spread taken as "enough to see the slope"
};

export function fitModel(segments, now = Date.now() / 1000, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!segments.length) {
    return { a: o.a0, b: o.b0, n: 0, spread: 0, trust: 0, sd: null, prior: true };
  }

  const w = segments.map(s => {
    const ageDays = Math.max(0, (now - s.tEnd) / 86400);
    const recency = Math.pow(0.5, ageDays / o.halfLifeDays);
    return s.hours * Math.max(0, s.r2) * recency;     // long, well-fitting, recent
  });

  const W = w.reduce((s, v) => s + v, 0);
  const x = segments.map(s => s.vpd - VPD_REF);
  const y = segments.map(s => s.rate);

  const mx = x.reduce((s, v, i) => s + w[i] * v, 0) / W;
  const sxx = x.reduce((s, v, i) => s + w[i] * (v - mx) ** 2, 0);
  const spread = Math.sqrt(sxx / W);

  const lamB = 8.0 / (1 + (spread / o.spreadScale) ** 2);
  const lamA = 1.0 / (1 + W / 6);

  const Saa = W + lamA;
  const Sab = x.reduce((s, v, i) => s + w[i] * v, 0);
  const Sbb = x.reduce((s, v, i) => s + w[i] * v * v, 0) + lamB;
  const Say = y.reduce((s, v, i) => s + w[i] * v, 0) + lamA * o.a0;
  const Sby = y.reduce((s, v, i) => s + w[i] * x[i] * v, 0) + lamB * o.b0;

  const det = Saa * Sbb - Sab * Sab;
  const a = (Say * Sbb - Sby * Sab) / det;
  const b = (Saa * Sby - Sab * Say) / det;

  const resid = segments.map((s, i) => y[i] - (a + b * x[i]));
  const sd = segments.length > 2
    ? Math.sqrt(resid.reduce((s, r, i) => s + w[i] * r * r, 0) / W)
    : null;

  return {
    a, b, sd, spread,
    n: segments.length,
    trust: sxx > 0 ? 1 - lamB / (lamB + sxx) : 0,   // 0 = all prior, 1 = all data
    prior: false,
  };
}

export function rateAt(model, vpdNow) {
  return Math.max(0.05, model.a + model.b * (vpdNow - VPD_REF));
}

export function hoursToThreshold(model, soilNow, threshold, vpdNow) {
  if (soilNow <= threshold) return 0;
  const r = rateAt(model, vpdNow);
  const h = (soilNow - threshold) / r;
  if (!model.sd) return { hours: h, low: null, high: null };
  const lo = Math.max(0.05, r + model.sd);
  const hi = Math.max(0.05, r - model.sd);
  return { hours: h, low: (soilNow - threshold) / lo, high: (soilNow - threshold) / hi };
}

// Honest one-line description of what the model currently knows.
export function describe(model) {
  if (model.prior) return 'No drying cycles observed yet — using the reference values.';
  const t = Math.round(model.trust * 100);
  if (t < 25) {
    return `${model.n} cycles, but VPD has varied by only ${model.spread.toFixed(2)} kPa. `
         + `The response to evaporative demand is still the assumed one; vary the `
         + `conditions to measure it.`;
  }
  if (t < 70) {
    return `${model.n} cycles across ${model.spread.toFixed(2)} kPa of VPD. `
         + `The response to evaporative demand is partly measured (${t}%).`;
  }
  return `${model.n} cycles across ${model.spread.toFixed(2)} kPa of VPD. `
       + `The response to evaporative demand is measured from this plant (${t}%).`;
}

// Leave-one-out backtest: fit without each segment, predict it, measure the error.
export function backtest(segments, now = Date.now() / 1000, opts = {}) {
  if (segments.length < 3) return null;
  const errs = segments.map((s, i) => {
    const rest = segments.filter((_, j) => j !== i);
    return Math.abs(rateAt(fitModel(rest, now, opts), s.vpd) - s.rate);
  });
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const meanRate = segments.reduce((a, s) => a + s.rate, 0) / segments.length;
  return { meanAbsError: mean, relative: mean / meanRate, n: errs.length };
}