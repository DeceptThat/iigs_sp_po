import { useMemo, useState } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';
import LineChart from '../LineChart.jsx';
import { vpd } from '../dryingModel.js';

const RANGES = [
  { id: '1d',  label: 'Last 24 hours', hours: 24 },
  { id: '7d',  label: 'Last 7 days',   hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days',  hours: 24 * 30 },
  { id: 'all', label: 'All readings',  hours: null },
];

const RISE_PCT       = 10;
const ATTRIB_GAP_S   = 6 * 3600;
const MIN_PTS        = 4;
const MIN_HOURS      = 3;
const USABLE_DROP    = 3;
const USABLE_HOURS   = 6;

const C_SOIL = '#4f9d6e';
const C_TEMP = '#cf7a4b';
const C_HUM  = '#5f8fc9';
const C_VPD  = '#7b6bd6';

function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!clean.length) return null;
  const sum = clean.reduce((a, b) => a + b, 0);
  const mean = sum / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  return { n: clean.length, min: Math.min(...clean), max: Math.max(...clean), mean, sd: Math.sqrt(variance) };
}

function f1(n) { return Number(n).toFixed(1); }
function f2(n) { return Number(n).toFixed(2); }

function analyseDrying(readings) {

  const pts = readings
    .filter((r) => Number.isFinite(r.soil) && r.soil > 2 && r.soil < 100 && Number.isFinite(r.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (pts.length < 5) return { med: [], bounds: [], segs: [] };

  const med = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 2), i + 3).map((q) => q.soil).sort((a, b) => a - b);
    return { t: p.timestamp, m: w[Math.floor(w.length / 2)], T: p.temperature, RH: p.humidity };
  });

  const bounds = [];
  for (let i = 1; i < med.length; i++) {
    const gap = med[i].t - med[i - 1].t;
    const step = med[i].m - med[i - 1].m;

    if (gap > ATTRIB_GAP_S)        bounds.push({ i, t: med[i].t, k: 'gap', d: step, h: gap / 3600 });

    else if (step >= RISE_PCT)     bounds.push({ i, t: med[i].t, k: 'wetting', d: step, h: gap / 3600 });

    else if (step <= -RISE_PCT)    bounds.push({ i, t: med[i].t, k: 'fault', d: step, h: gap / 3600 });

    else if (gap > 2 * 1800)       bounds.push({ i, t: med[i].t, k: 'gap', d: step, h: gap / 3600 });
  }

  const edges = [0, ...bounds.map((b) => b.i), med.length];
  const segs = [];
  for (let e = 0; e < edges.length - 1; e++) {
    const g = med.slice(edges[e], edges[e + 1]);
    if (g.length < MIN_PTS) continue;
    const hours = (g[g.length - 1].t - g[0].t) / 3600;
    if (hours < MIN_HOURS) continue;

    const n = g.length;
    const x = g.map((q) => (q.t - g[0].t) / 3600);
    const y = g.map((q) => q.m);
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    const den = x.reduce((a, xi) => a + (xi - mx) ** 2, 0);
    const slope = den ? x.reduce((a, xi, k) => a + (xi - mx) * (y[k] - my), 0) / den : 0;
    const sst = y.reduce((a, yi) => a + (yi - my) ** 2, 0);
    const sse = y.reduce((a, yi, k) => a + (yi - (my + slope * (x[k] - mx))) ** 2, 0);

    const vs = g.map((q) => vpd(q.T, q.RH)).filter((v) => Number.isFinite(v));
    const drop = g[0].m - g[g.length - 1].m;

    segs.push({
      i0: edges[e], i1: edges[e + 1] - 1,
      t0: g[0].t, t1: g[g.length - 1].t,
      hours, from: g[0].m, to: g[g.length - 1].m, drop,
      rate: -slope, n,
      r2: sst > 0 ? 1 - sse / sst : null,
      vpd: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null,
      usable: drop >= USABLE_DROP && hours >= USABLE_HOURS,
    });
  }
  return { med, bounds, segs };
}

export default function AnalysisPage({ node }) {
  const { historyReadings, automationLog, settings } = node;
  const [rangeId, setRangeId] = useState('7d');
  const [allSegs, setAllSegs] = useState(false);
  const range = RANGES.find((r) => r.id === rangeId);

  const readings = useMemo(() => {
    const cutoff = range.hours ? Math.floor(Date.now() / 1000) - range.hours * 3600 : 0;
    return historyReadings
      .filter((r) => r.timestamp && r.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [historyReadings, range]);

  const temp = useMemo(() => stats(readings.map((r) => r.temperature)), [readings]);
  const hum  = useMemo(() => stats(readings.map((r) => r.humidity)), [readings]);
  const soil = useMemo(() => stats(readings.map((r) => r.soil)), [readings]);

  const vpdSeries = useMemo(
    () => readings.map((r) => {
      const v = vpd(r.temperature, r.humidity);
      return Number.isFinite(v) ? v : null;
    }),
    [readings],
  );
  const vpdStats = useMemo(() => stats(vpdSeries), [vpdSeries]);

  const drying = useMemo(() => analyseDrying(readings), [readings]);
  const usable = drying.segs.filter((s) => s.usable);
  const wettings = drying.bounds.filter((b) => b.k === 'wetting');
  const gaps = drying.bounds.filter((b) => b.k === 'gap');

  const continuity = useMemo(() => {
    if (readings.length < 2) return null;
    const spanSec = readings.at(-1).timestamp - readings[0].timestamp;
    const intervalSec = Math.max(60, (settings.collectionIntervalMins || 60) * 60);
    const expected = Math.max(1, Math.round(spanSec / intervalSec) + 1);
    let g = 0, longest = 0;
    for (let i = 1; i < readings.length; i++) {
      const d = readings[i].timestamp - readings[i - 1].timestamp;
      if (d > intervalSec * 2) g++;
      if (d > longest) longest = d;
    }
    return {
      recorded: readings.length, expected, yield: readings.length / expected,
      gaps: g, longestGapMin: Math.round(longest / 60), spanHours: spanSec / 3600,
    };
  }, [readings, settings.collectionIntervalMins]);

  const watering = useMemo(() => {
    const cutoff = range.hours ? Math.floor(Date.now() / 1000) - range.hours * 3600 : 0;
    const events = automationLog
      .filter((e) => e.watered && e.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (events.length < 1) return { count: 0 };
    const g = [];
    for (let i = 1; i < events.length; i++) g.push((events[i].timestamp - events[i - 1].timestamp) / 3600);
    return {
      count: events.length,
      meanIntervalH: g.length ? g.reduce((a, b) => a + b, 0) / g.length : null,
      shortestH: g.length ? Math.min(...g) : null,
      longestH: g.length ? Math.max(...g) : null,
      last: events.at(-1).timestamp,
    };
  }, [automationLog, range]);

  const fmtT = (ts, withTime = true) =>
    new Date(ts * 1000).toLocaleString([], withTime
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' });

  const labels = readings.map((r) =>
    new Date(r.timestamp * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }));

  const dryLabels = drying.med.map((p) =>
    new Date(p.t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }));

  const fitSeries = useMemo(() => {
    const a = new Array(drying.med.length).fill(null);
    for (const s of usable) {
      a[s.i0] = s.from;
      a[s.i1] = s.to;

      for (let i = s.i0 + 1; i < s.i1; i++) {
        a[i] = s.from + ((s.to - s.from) * (i - s.i0)) / (s.i1 - s.i0);
      }
    }
    return a;
  }, [drying.med, usable]);

  const wetRadius = useMemo(() => {
    const a = new Array(drying.med.length).fill(0);
    for (const b of wettings) a[b.i] = 6;
    return a;
  }, [drying.med, wettings]);

  const empty = readings.length === 0;

  return (
    <section className="page">
      <BusyBanner busy={node.busy ?? { active: false }} />
      <div className="page-head">
        <div className="kicker">Analysis</div>
        <h1>What the record shows</h1>
        <p>
          Summary statistics over the stored readings, with the continuity of the
          record reported alongside them. Nothing here is projected forward.
        </p>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button key={r.id} className={rangeId === r.id ? 'active' : ''} onClick={() => setRangeId(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      {empty ? (
        <div className="card card-pad">
          No readings in this period. Either the controller has not recorded any
          yet, or recording is switched off on the settings page.
        </div>
      ) : (
        <>
          <div className="grid-3">
            {[
              { k: 'Temperature', s: temp, unit: '°C', colour: C_TEMP, icon: 'thermo' },
              { k: 'Humidity',    s: hum,  unit: '%',  colour: C_HUM,  icon: 'droplet' },
              { k: 'Soil moisture', s: soil, unit: '%', colour: C_SOIL, icon: 'droplet' },
            ].map(({ k, s, unit, colour, icon }) => (
              <div className="card card-pad" key={k}>
                <div className="card-title"><Icon name={icon} size={14} /> {k}</div>
                {s ? (
                  <>
                    <div className="stat-value mono" style={{ color: colour, marginTop: 10 }}>
                      {f1(s.mean)}{unit}
                    </div>
                    <div className="stat-sub">mean of {s.n} readings</div>
                    <div className="mini-stats" style={{ marginTop: 12 }}>
                      <div className="mini-stat"><div className="k">min</div><div className="v">{f1(s.min)}{unit}</div></div>
                      <div className="mini-stat"><div className="k">max</div><div className="v">{f1(s.max)}{unit}</div></div>
                      <div className="mini-stat"><div className="k">spread</div><div className="v">±{f1(s.sd)}</div></div>
                    </div>
                  </>
                ) : <div className="stat-sub">no data</div>}
              </div>
            ))}
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="chart" size={14} /> Trend over the selected period</div>
            <div className="chart-legend" style={{ marginTop: 10 }}>
              <span><i style={{ background: C_TEMP }} />temperature</span>
              <span><i style={{ background: C_HUM }} />humidity</span>
              <span><i style={{ background: C_SOIL }} />soil</span>
              <span className="legend-current">{readings.length} readings</span>
            </div>
            <LineChart
              labels={labels}
              datasets={[
                { data: readings.map((r) => r.temperature), borderColor: C_TEMP, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                { data: readings.map((r) => r.humidity), borderColor: C_HUM, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                { data: readings.map((r) => r.soil), borderColor: C_SOIL, borderWidth: 2, pointRadius: 0, tension: 0.3 },
              ]}
              min={0}
              max={100}
            />
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="chart" size={14} /> Evaporative demand</div>
            <div className="chart-legend" style={{ marginTop: 10 }}>
              <span><i style={{ background: C_VPD }} />vapour pressure deficit, kPa</span>
              {vpdStats && (
                <span className="legend-current">
                  {f2(vpdStats.min)} – {f2(vpdStats.max)} kPa, spread {f2(vpdStats.max - vpdStats.min)}
                </span>
              )}
            </div>
            <LineChart
              labels={labels}
              datasets={[{ data: vpdSeries, borderColor: C_VPD, borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: false }]}
              min={0}
              max={vpdStats ? Math.ceil(vpdStats.max * 2) / 2 : 2}
              height={170}
            />
            <p className="aut-desc" style={{ marginTop: 10 }}>
              Computed from the same readings by the Tetens relation, and plotted on its
              own scale so the comparison is not a matter of which axis was chosen.
            </p>
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="droplet" size={14} /> Drying since each wetting event</div>

            {drying.med.length < 5 ? (
              <div className="stat-sub" style={{ marginTop: 10 }}>
                Not enough usable readings in this period. Try a longer range.
              </div>
            ) : (
              <>
                <div className="mini-stats" style={{ marginTop: 12 }}>
                  <div className="mini-stat"><div className="k">wetting events</div><div className="v">{wettings.length}</div></div>
                  <div className="mini-stat"><div className="k">segments</div><div className="v">{drying.segs.length}</div></div>
                  <div className="mini-stat"><div className="k">measurable</div><div className="v">{usable.length}</div></div>
                  <div className="mini-stat">
                    <div className="k">rate</div>
                    <div className="v">
                      {usable.length
                        ? `${f2(Math.min(...usable.map((s) => s.rate)))}–${f2(Math.max(...usable.map((s) => s.rate)))} %/h`
                        : '—'}
                    </div>
                  </div>
                </div>

                <div className="chart-legend" style={{ marginTop: 14 }}>
                  <span><i style={{ background: C_SOIL }} />soil, median-smoothed</span>
                  <span><i style={{ background: C_TEMP }} />fitted drying slope (dashed)</span>
                  <span className="legend-current">{gaps.length} gaps in the record</span>
                </div>
                <LineChart
                  labels={dryLabels}
                  datasets={[
                    {
                      data: drying.med.map((p) => p.m),
                      borderColor: C_SOIL, borderWidth: 2, tension: 0.25,
                      pointRadius: wetRadius,
                      pointBackgroundColor: C_SOIL,
                      pointBorderColor: '#fff',
                      pointBorderWidth: 2,
                    },
                    {
                      data: fitSeries,
                      borderColor: C_TEMP, borderWidth: 2.5, pointRadius: 0,
                      borderDash: [6, 3], spanGaps: false, tension: 0,
                    },
                  ]}
                  min={0}
                  max={100}
                />

                {wettings.length > 0 && (
                  <p className="aut-desc" style={{ marginTop: 12 }}>
                    {wettings.length === 1 ? 'One wetting event' : `${wettings.length} wetting events`} detected
                    in this period:{' '}
                    {wettings.map((b, i) => (
                      <span key={b.t}>
                        {i > 0 ? ', ' : ''}
                        <b className="mono">{fmtT(b.t)}</b> (+{Math.round(b.d)} points)
                      </span>
                    ))}
                    . Compare these against the automation log — a rise with no logged
                    pump event is water that reached the pot some other way, and the
                    record catching that is the detector working rather than failing.
                  </p>
                )}

                <div className="table-scroll" style={{ marginTop: 16 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Segment began</th><th>Hours</th><th>Soil</th><th>Drop</th>
                        <th>Rate %/h</th><th>r&sup2;</th><th>VPD kPa</th><th>n</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(allSegs ? drying.segs : usable).map((s) => (
                        <tr key={s.t0} style={s.usable ? undefined : { opacity: 0.6 }}>
                          <td>{fmtT(s.t0)}</td>
                          <td className="mono">{f1(s.hours)}</td>
                          <td className="mono">{Math.round(s.from)} → {Math.round(s.to)}</td>
                          <td className="mono">{Math.round(s.drop)}</td>
                          <td className="mono">{s.usable ? f2(s.rate) : '—'}</td>
                          <td className="mono">{s.r2 == null ? '—' : s.r2.toFixed(2)}</td>
                          <td className="mono">{s.vpd == null ? '—' : f2(s.vpd)}</td>
                          <td className="mono">{s.n}</td>
                        </tr>
                      ))}
                      {(allSegs ? drying.segs : usable).length === 0 && (
                        <tr><td colSpan={8} className="stat-sub">
                          No segment in this period fell far enough to measure a rate.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {drying.segs.length > usable.length && (
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
                          onClick={() => setAllSegs((v) => !v)}>
                    {allSegs
                      ? `Show only the ${usable.length} measurable`
                      : `Show all ${drying.segs.length} segments`}
                  </button>
                )}

                <p className="aut-desc" style={{ marginTop: 12 }}>
                  A rate is withheld below {USABLE_DROP} points of fall or {USABLE_HOURS} hours.
                  Soil is stored as a whole percentage, so a shorter segment moves by one or
                  two digits and its slope is quantisation noise — which is why the discarded
                  ones include impossible negative rates.
                </p>

                {usable.length >= 2 && (
                  <div className="aut-note" style={{ marginTop: 12 }}>
                    <Icon name="shield" size={17} />
                    <span>
                      <b>Rate and demand cannot be separated here.</b> The segments differ in
                      starting soil level as much as in vapour pressure deficit, so the
                      range above is a measured range of drying rates, not a response
                      to conditions.
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="card card-pad">
              <div className="card-title"><Icon name="shield" size={14} /> Continuity of the record</div>
              {continuity ? (
                <>
                  <div className="stat-value mono" style={{ marginTop: 10 }}>
                    {(continuity.yield * 100).toFixed(1)}%
                  </div>
                  <div className="stat-sub">
                    {continuity.recorded} recorded against {continuity.expected} expected over{' '}
                    {continuity.spanHours.toFixed(1)} hours
                  </div>
                  <div className="mini-stats" style={{ marginTop: 12 }}>
                    <div className="mini-stat"><div className="k">interruptions</div><div className="v">{continuity.gaps}</div></div>
                    <div className="mini-stat"><div className="k">longest gap</div><div className="v">{continuity.longestGapMin} min</div></div>
                  </div>
                  <p className="aut-desc" style={{ marginTop: 12 }}>
                    A record is written only when a cloud transaction succeeds. An interruption
                    is counted where the gap exceeds twice the acquisition interval.
                  </p>
                </>
              ) : <div className="stat-sub">not enough readings</div>}
            </div>

            <div className="card card-pad">
              <div className="card-title"><Icon name="droplet" size={14} /> Watering behaviour</div>
              {watering.count > 0 ? (
                <>
                  <div className="stat-value mono" style={{ marginTop: 10 }}>{watering.count}</div>
                  <div className="stat-sub">waterings in this period</div>
                  {watering.meanIntervalH != null && (
                    <div className="mini-stats" style={{ marginTop: 12 }}>
                      <div className="mini-stat"><div className="k">mean interval</div><div className="v">{f1(watering.meanIntervalH)} h</div></div>
                      <div className="mini-stat"><div className="k">shortest</div><div className="v">{f1(watering.shortestH)} h</div></div>
                      <div className="mini-stat"><div className="k">longest</div><div className="v">{f1(watering.longestH)} h</div></div>
                    </div>
                  )}
                  <p className="aut-desc" style={{ marginTop: 12 }}>
                    Counted from the automation log — what the controller decided — not from
                    the soil trace.
                  </p>
                </>
              ) : (
                <div className="stat-sub" style={{ marginTop: 10 }}>
                  No watering recorded in this period. Either the soil stayed above the
                  threshold or automatic watering is switched off.
                </div>
              )}
            </div>
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="bulb" size={14} /> How a segment is divided</div>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              Before any segment is cut, readings at either end of the probe&rsquo;s range
              are discarded, and what survives is smoothed with a median of five.
            </p>
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Test</th><th style={{ textAlign: 'left' }}>Boundary</th><th style={{ textAlign: 'left' }}>Why that threshold</th></tr></thead>
                <tbody>
                  <tr>
                    <td className="mono">gap &gt; 6 h</td><td>gap</td>
                    <td>Six hours is the configured watering cooldown. Across a longer hole
                        more than one watering could have happened, so no single event can
                        be claimed whatever the jump looks like.</td>
                  </tr>
                  <tr>
                    <td className="mono">rise ≥ 10 pts</td><td>wetting</td>
                    <td>The fastest drying measured anywhere is about 1 %/h, so half an hour
                        moves the soil about half a point. Ten points is roughly twenty times
                        that, and drying only ever moves downward.</td>
                  </tr>
                  <tr>
                    <td className="mono">fall ≥ 10 pts</td><td>fault</td>
                    <td>Nothing removes a tenth of the pot&rsquo;s water in half an hour. A
                        fall that fast is the instrument, not the soil.</td>
                  </tr>
                  <tr>
                    <td className="mono">gap &gt; 2 intervals</td><td>gap</td>
                    <td>A missed sample. The segment ends because a slope fitted across the
                        hole would be inventing the readings in between.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>
              None of those numbers is tuned: ten points comes from the fastest drying rate
              in the record, six hours from a setting the controller already acts on.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
