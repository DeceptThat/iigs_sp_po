// ===========================================================================
//  ReservoirPage.jsx — KMN / IIGS portal
//  Reservoir level display and two-point calibration.
//
//  TWO LINES TO CHECK BEFORE THIS COMPILES
//  ---------------------------------------
//  1. The import path below ('../firebase') must point at your firebase.js.
//  2. That file must export the Realtime Database instance as `db`. If it
//     exports it under another name, change the import. If it exports the
//     app instead, use:  const db = getDatabase(app);
//
//  Everything else is self-contained: no chart library, no CSS framework.
//  Class names are prefixed rsv- so they cannot collide with your styles.
//
//  READS   /sensors/current/{reservoir_gap_mm, reservoir_percent,
//                            reservoir_ok, timestamp}
//          /sensors/config/reservoir/{gap_empty_mm, gap_full_mm}
//          /sensors/history            (last 96 records)
//  WRITES  /sensors/config/reservoir/{gap_empty_mm, gap_full_mm}
//          /sensors/control/run_automation_check
// ===========================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { ref, onValue, update, set, query, limitToLast } from 'firebase/database';
import { db } from '../firebase';          // <-- 1. check this path

// Mirrors the firmware exactly. If you change these in board_a_coordinator.ino,
// change them here too, or the portal will offer saves the board then rejects.
const GAP_MIN_MM  = 30;
const GAP_MAX_MM  = 1000;
const SPAN_MIN_MM = 20;
const DEAD_ZONE_MM = 20;      // HC-SR04 blind region, for the diagram

// A reading older than this cannot be trusted to describe the bin as it is now.
const FRESH_WINDOW_S = 120;
const CHECK_TIMEOUT_S = 90;

export default function ReservoirPage() {
  const [current, setCurrent] = useState(null);
  const [cfg, setCfg]         = useState({ gap_empty_mm: 143, gap_full_mm: 50 });
  const [history, setHistory] = useState([]);
  const [now, setNow]         = useState(() => Math.floor(Date.now() / 1000));
  const [toast, setToast]     = useState(null);
  const [busy, setBusy]       = useState(null);     // 'full' | 'empty' | 'check'
  const [waitingSince, setWaitingSince] = useState(null);
  const [draft, setDraft]     = useState({ full: '', empty: '' });
  const [dims, setDims]       = useState(() => readDims());

  const tsAtRequest = useRef(null);

  // ---- live subscriptions ------------------------------------------------
  useEffect(() => {
    const offCurrent = onValue(ref(db, '/sensors/current'), s => setCurrent(s.val()));
    const offCfg = onValue(ref(db, '/sensors/config/reservoir'), s => {
      const v = s.val();
      if (v) setCfg(c => ({ ...c, ...v }));
    });
    const offHist = onValue(
      query(ref(db, '/sensors/history'), limitToLast(96)),
      s => {
        const v = s.val() || {};
        const rows = Object.values(v)
          .filter(r => r && typeof r.timestamp === 'number')
          .sort((a, b) => a.timestamp - b.timestamp);
        setHistory(rows);
      }
    );
    return () => { offCurrent(); offCfg(); offHist(); };
  }, []);

  // One ticking clock drives every age and countdown on the page.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- derived -----------------------------------------------------------
  const gapMm   = numOrNull(current?.reservoir_gap_mm);
  const readingTs = numOrNull(current?.timestamp);
  const ageS    = readingTs == null ? null : Math.max(0, now - readingTs);
  const fresh   = ageS != null && ageS <= FRESH_WINDOW_S;
  const noEcho  = current?.reservoir_ok === false || (gapMm != null && gapMm < 0);
  const hasGap  = gapMm != null && gapMm > 0;

  const gapEmpty = clampInt(cfg.gap_empty_mm, GAP_MIN_MM, GAP_MAX_MM, 143);
  const gapFull  = clampInt(cfg.gap_full_mm,  GAP_MIN_MM, GAP_MAX_MM, 50);
  const span     = gapEmpty - gapFull;
  const calOk    = span >= SPAN_MIN_MM;

  const depthMm = hasGap && calOk ? Math.max(0, gapEmpty - gapMm) : null;
  const pct     = hasGap && calOk ? pctFromGap(gapMm, gapEmpty, gapFull) : null;

  const mlPerMm = useMemo(() => {
    const L = Number(dims.l), W = Number(dims.w);
    if (!(L > 0 && W > 0)) return null;
    return (L * W) / 1000;                 // mm² × 1 mm = mm³ ; 1000 mm³ = 1 mL
  }, [dims]);

  const remainingMl = depthMm != null && mlPerMm != null
    ? Math.round(depthMm * mlPerMm) : null;

  // Did the board answer our Run-check request?
  useEffect(() => {
    if (waitingSince == null) return;
    if (readingTs != null && tsAtRequest.current != null &&
        readingTs !== tsAtRequest.current) {
      setWaitingSince(null);
      setBusy(null);
      setToast({ kind: 'ok', text: 'Fresh reading in. You can capture now.' });
      return;
    }
    if (now - waitingSince > CHECK_TIMEOUT_S) {
      setWaitingSince(null);
      setBusy(null);
      setToast({
        kind: 'warn',
        text: `No new reading after ${CHECK_TIMEOUT_S}s. The board may be offline, ` +
              `backing off, or busy with a sweep.`
      });
    }
  }, [now, readingTs, waitingSince]);

  // ---- actions -----------------------------------------------------------
  async function runCheckNow() {
    setToast(null);
    tsAtRequest.current = readingTs;
    setBusy('check');
    setWaitingSince(Math.floor(Date.now() / 1000));
    try {
      await set(ref(db, '/sensors/control/run_automation_check'), true);
    } catch (e) {
      setBusy(null); setWaitingSince(null);
      setToast({ kind: 'err', text: `Could not reach the database: ${e.message}` });
    }
  }

  function validate(which, value) {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v))               return 'Not a number.';
    if (v < GAP_MIN_MM || v > GAP_MAX_MM)
      return `Must be between ${GAP_MIN_MM} and ${GAP_MAX_MM} mm.`;
    const e = which === 'empty' ? v : gapEmpty;
    const f = which === 'full'  ? v : gapFull;
    if (e - f < SPAN_MIN_MM)
      return `Empty (${e}) must exceed full (${f}) by at least ${SPAN_MIN_MM} mm. ` +
             `The board rejects anything narrower.`;
    return null;
  }

  async function save(which, value) {
    const err = validate(which, value);
    if (err) { setToast({ kind: 'err', text: err }); return; }
    const v = Math.round(Number(value));
    const key = which === 'empty' ? 'gap_empty_mm' : 'gap_full_mm';
    setBusy(which);
    try {
      await update(ref(db, '/sensors/config/reservoir'), { [key]: v });
      setDraft(d => ({ ...d, [which]: '' }));
      setToast({
        kind: 'ok',
        text: `${which === 'empty' ? 'Empty' : 'Full'} point saved as ${v} mm. ` +
              `The board picks it up at its next check.`
      });
    } catch (e) {
      setToast({ kind: 'err', text: `Save failed: ${e.message}` });
    } finally { setBusy(null); }
  }

  function saveDims(next) {
    setDims(next);
    try { localStorage.setItem('rsv.dims', JSON.stringify(next)); } catch {}
  }

  // ---- render ------------------------------------------------------------
  const captureBlock = !hasGap
    ? (noEcho ? 'The rangefinder returned no echo. Nothing to capture.'
              : 'No reservoir reading yet. Flash Board A, then run a check.')
    : !fresh
      ? `This reading is ${fmtAge(ageS)} old. Run a check so it describes the bin as it is now.`
      : null;

  const series = history
    .filter(r => typeof r.reservoir_percent === 'number')
    .map(r => ({ t: r.timestamp, v: r.reservoir_percent }));

  return (
    <div className="rsv">
      <style>{CSS}</style>

      <header className="rsv-head">
        <div>
          <p className="rsv-eyebrow">Reservoir</p>
          <h1>Water level</h1>
        </div>
        <div className={`rsv-age rsv-age--${fresh ? 'fresh' : 'stale'}`}>
          <span className="rsv-age-dot" />
          {ageS == null ? 'no reading' : `${fmtAge(ageS)} old`}
        </div>
      </header>

      {/* ---------------- live level ---------------- */}
      <section className="rsv-card rsv-level">
        <Tank
          gapMm={gapMm}
          gapEmpty={gapEmpty}
          gapFull={gapFull}
          pct={pct}
          noEcho={noEcho}
        />

        <div className="rsv-readout">
          <div className="rsv-big">
            <span className="rsv-big-num">{depthMm != null ? depthMm : '—'}</span>
            <span className="rsv-big-unit">mm</span>
          </div>
          <p className="rsv-big-label">water depth</p>

          <dl className="rsv-facts">
            <div><dt>usable</dt><dd>{pct != null ? `${pct}%` : '—'}</dd></div>
            <div><dt>air gap</dt><dd>{hasGap ? `${gapMm} mm` : (noEcho ? 'no echo' : '—')}</dd></div>
            <div><dt>column</dt><dd>{calOk ? `${span} mm` : 'uncalibrated'}</dd></div>
            {remainingMl != null &&
              <div><dt>volume</dt><dd>{remainingMl} mL</dd></div>}
          </dl>

          {noEcho && (
            <p className="rsv-note rsv-note--warn">
              No echo. Either the bin is overfilled and the surface has risen into
              the sensor's {DEAD_ZONE_MM} mm dead zone, or the module has failed.
              Reported as unknown, never as empty.
            </p>
          )}
          {!calOk && (
            <p className="rsv-note rsv-note--warn">
              Calibration span is {span} mm, under the {SPAN_MIN_MM} mm minimum.
              The board is using its last good pair and ignoring these values.
            </p>
          )}
        </div>
      </section>

      {/* ---------------- calibration ---------------- */}
      <section className="rsv-card">
        <h2>Calibration</h2>
        <p className="rsv-lede">
          Two measured points. The air gap is small when the bin is full and large
          when it is empty, so the numbers run opposite to the level.
        </p>

        <div className="rsv-step">
          <span className="rsv-step-n">1</span>
          <div>
            <strong>Get a reading that matches the bin right now.</strong>
            <p>
              <code>/sensors/current</code> only updates when a check runs. Capturing a
              stale reading stores a calibration that is wrong in a way nothing will
              flag later.
            </p>
            <button
              className="rsv-btn"
              onClick={runCheckNow}
              disabled={busy === 'check'}
            >
              {busy === 'check'
                ? `Waiting for the board… ${waitingSince ? CHECK_TIMEOUT_S - (now - waitingSince) : ''}s`
                : 'Run check now'}
            </button>
          </div>
        </div>

        <div className="rsv-step">
          <span className="rsv-step-n">2</span>
          <div>
            <strong>Capture each end.</strong>
            <p>
              Empty the bin and capture Empty. Fill to your mark and capture Full.
              Run a check before each capture.
            </p>

            {captureBlock && <p className="rsv-note rsv-note--warn">{captureBlock}</p>}

            <div className="rsv-pair">
              <CalEnd
                label="Empty"
                hint="bin dry"
                stored={gapEmpty}
                liveGap={gapMm}
                disabled={!!captureBlock || busy === 'empty'}
                draft={draft.empty}
                onDraft={v => setDraft(d => ({ ...d, empty: v }))}
                onCapture={() => save('empty', gapMm)}
                onSaveTyped={() => save('empty', draft.empty)}
                error={draft.empty ? validate('empty', draft.empty) : null}
              />
              <CalEnd
                label="Full"
                hint="at your fill mark"
                stored={gapFull}
                liveGap={gapMm}
                disabled={!!captureBlock || busy === 'full'}
                draft={draft.full}
                onDraft={v => setDraft(d => ({ ...d, full: v }))}
                onCapture={() => save('full', gapMm)}
                onSaveTyped={() => save('full', draft.full)}
                error={draft.full ? validate('full', draft.full) : null}
              />
            </div>

            {hasGap && calOk && (
              <p className="rsv-note">
                Under the stored calibration, the current gap of {gapMm} mm reads
                as <strong>{pct}% / {depthMm} mm</strong>.
              </p>
            )}
          </div>
        </div>

        <p className="rsv-note">
          The raw air gap is stored alongside the percentage, so a calibration
          corrected later can be reapplied across the record.
        </p>
      </section>

      {/* ---------------- geometry ---------------- */}
      <section className="rsv-card">
        <h2>Bin geometry</h2>
        <p className="rsv-lede">
          Inside measurements of the reservoir, used to convert depth to volume.
        </p>
        <div className="rsv-dims">
          <label>
            <span>Length</span>
            <input type="number" inputMode="numeric" value={dims.l}
              onChange={e => saveDims({ ...dims, l: e.target.value })} />
            <span className="rsv-unit">mm</span>
          </label>
          <label>
            <span>Width</span>
            <input type="number" inputMode="numeric" value={dims.w}
              onChange={e => saveDims({ ...dims, w: e.target.value })} />
            <span className="rsv-unit">mm</span>
          </label>
        </div>

        {mlPerMm == null ? (
          <p className="rsv-note">Enter both to see the resolution figures.</p>
        ) : (
          <Resolution mlPerMm={mlPerMm} span={span} />
        )}
      </section>

      {/* ---------------- trend ---------------- */}
      <section className="rsv-card">
        <h2>Last 48 hours</h2>
        {series.length < 2 ? (
          <p className="rsv-empty">
            No reservoir readings stored yet. They begin appearing once Board A is
            flashed with the five-field parser — one point per history record.
          </p>
        ) : (
          <Trend series={series} />
        )}
      </section>

      {toast && (
        <div className={`rsv-toast rsv-toast--${toast.kind}`} role="status">
          {toast.text}
          <button className="rsv-toast-x" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
//  Sub-components
// ===========================================================================

function CalEnd({ label, hint, stored, liveGap, disabled, draft, onDraft,
                 onCapture, onSaveTyped, error }) {
  return (
    <div className="rsv-end">
      <div className="rsv-end-head">
        <strong>{label}</strong>
        <span className="rsv-end-hint">{hint}</span>
      </div>
      <div className="rsv-end-stored">
        <span className="rsv-end-num">{stored}</span><span className="rsv-end-u">mm</span>
      </div>
      <button className="rsv-btn rsv-btn--cap" onClick={onCapture} disabled={disabled}>
        {disabled || liveGap == null ? 'Capture current'
          : `Capture current (${liveGap} mm)`}
      </button>
      <div className="rsv-end-manual">
        <input
          type="number" inputMode="numeric" placeholder="or type mm"
          value={draft} onChange={e => onDraft(e.target.value)}
        />
        <button className="rsv-btn rsv-btn--ghost"
          onClick={onSaveTyped} disabled={!draft || !!error}>Save</button>
      </div>
      {error && <p className="rsv-end-err">{error}</p>}
    </div>
  );
}

function Resolution({ mlPerMm, span }) {
  // The HC-SR04's own repeatability, with the median-of-5 already applied.
  const NOISE_MM = 3;
  const totalMl = Math.round(span * mlPerMm);
  const minDrop = NOISE_MM + 2;                       // noise plus a margin
  const detectableMl = Math.round(minDrop * mlPerMm);
  return (
    <>
      <dl className="rsv-facts rsv-facts--wide">
        <div><dt>per mm of depth</dt><dd>{mlPerMm.toFixed(1)} mL</dd></div>
        <div><dt>full column holds</dt><dd>{totalMl} mL</dd></div>
        <div><dt>smallest reliable drop</dt><dd>{minDrop} mm</dd></div>
        <div><dt>i.e. a delivery of</dt><dd>{detectableMl} mL</dd></div>
      </dl>
      <p className="rsv-note">
        The rangefinder repeats to about ±{NOISE_MM} mm even with the median-of-5
        filter, so a drop under {minDrop} mm cannot be told apart from noise. If one
        watering delivers less than {detectableMl} mL, the before/after check verifies
        the trend across several waterings rather than each one individually — which
        is a smaller claim than detecting a single failed delivery, and the honest
        one to make.
      </p>
    </>
  );
}

function Tank({ gapMm, gapEmpty, gapFull, pct, noEcho }) {
  const W = 132, H = 232, PAD = 10;
  const innerH = H - PAD * 2;
  const bodyTop = PAD, bodyBot = H - PAD;

  // Map the physical gap range onto the drawing. The top of the tank is the
  // sensor's full point; above it sits the dead zone band.
  const deadFrac = Math.min(0.22, 20 / Math.max(1, gapEmpty));
  const deadH = innerH * deadFrac;
  const waterTop = bodyTop + deadH;
  const waterZone = bodyBot - waterTop;

  const fill = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const fillH = waterZone * fill;
  const fillY = bodyBot - fillH;

  return (
    <svg className="rsv-tank" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={pct == null ? 'Reservoir level unknown' : `Reservoir at ${pct}%`}>
      {/* dead zone */}
      <rect x={PAD} y={bodyTop} width={W - PAD * 2} height={deadH}
            fill="var(--rsv-dead)" />
      <line x1={PAD} y1={waterTop} x2={W - PAD} y2={waterTop}
            stroke="var(--rsv-rule)" strokeWidth="1" strokeDasharray="3 3" />
      <text x={W - PAD - 4} y={bodyTop + deadH / 2 + 3} textAnchor="end"
            className="rsv-tank-tick">dead zone</text>

      {/* water */}
      {pct != null && fillH > 0 && (
        <>
          <rect x={PAD} y={fillY} width={W - PAD * 2} height={fillH}
                fill="var(--rsv-water)" />
          <line x1={PAD} y1={fillY} x2={W - PAD} y2={fillY}
                stroke="var(--rsv-water-edge)" strokeWidth="2" />
        </>
      )}
      {pct == null && (
        <text x={W / 2} y={H / 2 + 4} textAnchor="middle" className="rsv-tank-unk">
          {noEcho ? 'no echo' : 'no reading'}
        </text>
      )}

      {/* walls */}
      <path d={`M ${PAD} ${bodyTop} L ${PAD} ${bodyBot} L ${W - PAD} ${bodyBot} L ${W - PAD} ${bodyTop}`}
            fill="none" stroke="var(--rsv-fg)" strokeWidth="2" />

      {/* end labels */}
      <text x={PAD + 4} y={waterTop + 13} className="rsv-tank-tick">
        full · {gapFull} mm gap
      </text>
      <text x={PAD + 4} y={bodyBot - 6} className="rsv-tank-tick">
        empty · {gapEmpty} mm gap
      </text>
    </svg>
  );
}

function Trend({ series }) {
  const W = 680, H = 132, L = 34, R = 10, T = 10, B = 22;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);
  const x = t => L + ((t - t0) / tSpan) * (W - L - R);
  const y = v => T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B);

  const line = series.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(t1).toFixed(1)} ${y(0)} L ${x(t0).toFixed(1)} ${y(0)} Z`;
  const last = series[series.length - 1];

  return (
    <div className="rsv-scroll">
      <svg className="rsv-trend" viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label="Reservoir level over the last 48 hours">
        {[0, 50, 100].map(g => (
          <g key={g}>
            <line x1={L} y1={y(g)} x2={W - R} y2={y(g)}
                  stroke="var(--rsv-rule)" strokeWidth="1" />
            <text x={L - 6} y={y(g) + 4} textAnchor="end" className="rsv-trend-tick">{g}%</text>
          </g>
        ))}
        <path d={area} fill="var(--rsv-water)" opacity="0.28" />
        <path d={line} fill="none" stroke="var(--rsv-water-edge)" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.t)} cy={y(last.v)} r="3.5" fill="var(--rsv-water-edge)" />
        <text x={L} y={H - 6} className="rsv-trend-tick">{fmtClock(t0)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="rsv-trend-tick">{fmtClock(t1)}</text>
      </svg>
    </div>
  );
}

// ===========================================================================
//  Helpers
// ===========================================================================
function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// null and '' are absent values, not zero. Number(null) is 0, which is finite,
// so without this a half-written config node would clamp to the 30 mm floor and
// look like a deliberate setting.
function clampInt(v, lo, hi, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Math.trunc, NOT Math.round. The firmware computes this with C integer
// division, which truncates. Rounding here would put the portal one point above
// the board at some levels — a 65 mm gap stores 83 % and would have displayed
// 84 %. The number on screen must be the number in the record.
function pctFromGap(gap, empty, full) {
  const span = empty - full;
  if (span <= 0 || gap <= 0) return null;
  return Math.max(0, Math.min(100, Math.trunc(((empty - gap) * 100) / span)));
}
function fmtAge(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ` +
         `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function readDims() {
  try {
    const raw = localStorage.getItem('rsv.dims');
    if (raw) { const v = JSON.parse(raw); if (v && 'l' in v && 'w' in v) return v; }
  } catch {}
  return { l: '', w: '' };
}

// ===========================================================================
//  Styles — prefixed, theme-aware, no framework
// ===========================================================================
const CSS = `
.rsv{
  --rsv-bg:#f4f6f7; --rsv-surface:#fff; --rsv-fg:#1b2227; --rsv-muted:#67727a;
  --rsv-rule:#d4dcdf; --rsv-accent:#1f5673; --rsv-water:#4a9ec4;
  --rsv-water-edge:#1f6f96; --rsv-dead:#e4e9eb;
  --rsv-warn:#8a5a00; --rsv-warn-bg:#f7eedb; --rsv-err:#9c3a2a; --rsv-err-bg:#f9e5e0;
  --rsv-ok:#215f3f; --rsv-ok-bg:#e0f0e7;
  color:var(--rsv-fg); font-size:15px; line-height:1.55;
  max-width:860px; margin:0 auto; padding-inline:16px; padding-block:24px 56px;
}
@media (prefers-color-scheme:dark){ .rsv{
  --rsv-bg:#14181b; --rsv-surface:#1c2227; --rsv-fg:#e4e4e1; --rsv-muted:#95a0a7;
  --rsv-rule:#2d353b; --rsv-accent:#74b4cf; --rsv-water:#2d6a8c;
  --rsv-water-edge:#8ccbe6; --rsv-dead:#232a2f;
  --rsv-warn:#dcab52; --rsv-warn-bg:#2c2518; --rsv-err:#e38672; --rsv-err-bg:#32201c;
  --rsv-ok:#6cbf8a; --rsv-ok-bg:#18291f;
}}
.rsv *{box-sizing:border-box}
.rsv-head{display:flex;justify-content:space-between;align-items:flex-start;
  gap:12px;flex-wrap:wrap;margin-bottom:20px}
.rsv-eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--rsv-muted);margin:0 0 4px;font-weight:600}
.rsv h1{font-size:28px;line-height:1.1;margin:0;letter-spacing:-.02em}
.rsv h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
.rsv-age{display:inline-flex;align-items:center;gap:7px;font-size:12px;
  font-variant-numeric:tabular-nums;padding:5px 10px;border-radius:999px;
  border:1px solid var(--rsv-rule);background:var(--rsv-surface)}
.rsv-age-dot{width:7px;height:7px;border-radius:50%}
.rsv-age--fresh .rsv-age-dot{background:var(--rsv-ok)}
.rsv-age--stale .rsv-age-dot{background:var(--rsv-warn)}
.rsv-age--stale{color:var(--rsv-warn)}

.rsv-card{background:var(--rsv-surface);border:1px solid var(--rsv-rule);
  border-radius:8px;padding:18px;margin-bottom:16px}
.rsv-lede{color:var(--rsv-muted);font-size:14px;margin:0 0 14px;max-width:62ch}

.rsv-level{display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.rsv-tank{width:132px;height:232px;flex:0 0 auto}
.rsv-tank-tick{font-size:9px;fill:var(--rsv-muted)}
.rsv-tank-unk{font-size:12px;fill:var(--rsv-muted)}
.rsv-readout{flex:1 1 240px;min-width:0}
.rsv-big{display:flex;align-items:baseline;gap:6px}
.rsv-big-num{font-size:52px;line-height:1;font-weight:700;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums}
.rsv-big-unit{font-size:18px;color:var(--rsv-muted)}
.rsv-big-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--rsv-muted);margin:6px 0 16px}
.rsv-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));
  gap:12px;margin:0}
.rsv-facts--wide{grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin:0 0 10px}
.rsv-facts dt{font-size:10px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--rsv-muted);margin-bottom:2px}
.rsv-facts dd{margin:0;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}

.rsv-step{display:grid;grid-template-columns:28px minmax(0,1fr);gap:0 12px;
  padding-block:14px;border-top:1px solid var(--rsv-rule)}
.rsv-step-n{width:24px;height:24px;border-radius:50%;background:var(--rsv-accent);
  color:var(--rsv-surface);display:grid;place-items:center;font-size:12px;
  font-weight:700}
.rsv-step p{font-size:14px;color:var(--rsv-muted);margin:4px 0 10px;max-width:60ch}
.rsv-step code{font-family:ui-monospace,Menlo,monospace;font-size:.88em;
  background:var(--rsv-dead);padding:1px 4px;border-radius:3px}

.rsv-btn{font:inherit;font-size:14px;font-weight:600;padding:8px 14px;
  border-radius:6px;border:1px solid var(--rsv-accent);background:var(--rsv-accent);
  color:#fff;cursor:pointer}
.rsv-btn:hover:not(:disabled){filter:brightness(1.08)}
.rsv-btn:disabled{opacity:.45;cursor:not-allowed}
.rsv-btn:focus-visible{outline:2px solid var(--rsv-accent);outline-offset:2px}
.rsv-btn--cap{width:100%;margin-bottom:8px}
.rsv-btn--ghost{background:transparent;color:var(--rsv-accent)}

.rsv-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:12px;margin-bottom:12px}
.rsv-end{border:1px solid var(--rsv-rule);border-radius:7px;padding:12px;min-width:0}
.rsv-end-head{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.rsv-end-hint{font-size:11px;color:var(--rsv-muted)}
.rsv-end-stored{margin:4px 0 10px}
.rsv-end-num{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.rsv-end-u{font-size:13px;color:var(--rsv-muted);margin-left:4px}
.rsv-end-manual{display:flex;gap:6px}
.rsv-end-manual input{flex:1 1 0;min-width:0}
.rsv-end-err{font-size:12px;color:var(--rsv-err);margin:8px 0 0}

.rsv input[type=number]{font:inherit;font-size:14px;padding:7px 9px;
  border:1px solid var(--rsv-rule);border-radius:6px;background:var(--rsv-bg);
  color:var(--rsv-fg);width:100%}
.rsv input:focus-visible{outline:2px solid var(--rsv-accent);outline-offset:1px}

.rsv-dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:12px;margin-bottom:14px}
.rsv-dims label{display:grid;grid-template-columns:1fr auto;
  grid-template-areas:"name name" "input unit";gap:4px 8px;align-items:center}
.rsv-dims label>span:first-child{grid-area:name;font-size:10px;
  letter-spacing:.09em;text-transform:uppercase;color:var(--rsv-muted)}
.rsv-dims input{grid-area:input}
.rsv-unit{grid-area:unit;font-size:13px;color:var(--rsv-muted)}

.rsv-note{font-size:13px;color:var(--rsv-muted);margin:10px 0 0;max-width:64ch}
.rsv-note--warn{color:var(--rsv-warn);background:var(--rsv-warn-bg);
  padding:9px 11px;border-radius:6px;border-left:3px solid var(--rsv-warn)}
.rsv-empty{font-size:14px;color:var(--rsv-muted);margin:0;
  background:var(--rsv-bg);border:1px dashed var(--rsv-rule);
  border-radius:6px;padding:16px;max-width:64ch}

.rsv-scroll{overflow-x:auto}
.rsv-trend{width:100%;min-width:480px;height:132px;display:block}
.rsv-trend-tick{font-size:9px;fill:var(--rsv-muted)}

.rsv-toast{position:sticky;bottom:12px;display:flex;align-items:flex-start;gap:10px;
  font-size:14px;padding:11px 13px;border-radius:7px;margin-top:8px}
.rsv-toast--ok{background:var(--rsv-ok-bg);color:var(--rsv-ok)}
.rsv-toast--warn{background:var(--rsv-warn-bg);color:var(--rsv-warn)}
.rsv-toast--err{background:var(--rsv-err-bg);color:var(--rsv-err)}
.rsv-toast-x{margin-left:auto;background:none;border:0;color:inherit;
  font-size:19px;line-height:1;cursor:pointer;padding:0 2px}

@media (prefers-reduced-motion:reduce){.rsv *{transition:none!important}}
`;
