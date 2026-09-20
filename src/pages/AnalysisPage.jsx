import { useMemo, useState } from 'react';
import { Icon } from '../icons.jsx';
import LineChart from '../LineChart.jsx';

// Replaces the live monitor. A rolling ten-point window showed what was
// happening at this instant; this page shows what the record says over a
// period, which is the question the readings were collected to answer.

const RANGES = [
  { id: '1d',  label: 'Last 24 hours', hours: 24 },
  { id: '7d',  label: 'Last 7 days',   hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days',  hours: 24 * 30 },
  { id: 'all', label: 'All readings',  hours: null },
];

function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!clean.length) return null;
  const sum = clean.reduce((a, b) => a + b, 0);
  const mean = sum / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  return {
    n: clean.length,
    min: Math.min(...clean),
    max: Math.max(...clean),
    mean,
    sd: Math.sqrt(variance),
  };
}

function f1(n) { return Number(n).toFixed(1); }

export default function AnalysisPage({ node }) {
  const { historyReadings, automationLog, settings } = node;
  const [rangeId, setRangeId] = useState('7d');
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

  // Continuity: how many of the readings the schedule should have produced
  // actually arrived. A gap of more than twice the interval is counted as an
  // interruption, the factor of two admitting one missed acquisition without
  // inferring that the device failed.
  const continuity = useMemo(() => {
    if (readings.length < 2) return null;
    const spanSec = readings.at(-1).timestamp - readings[0].timestamp;
    const intervalSec = Math.max(60, (settings.collectionIntervalMins || 60) * 60);
    const expected = Math.max(1, Math.round(spanSec / intervalSec) + 1);
    let gaps = 0;
    let longest = 0;
    for (let i = 1; i < readings.length; i++) {
      const d = readings[i].timestamp - readings[i - 1].timestamp;
      if (d > intervalSec * 2) gaps++;
      if (d > longest) longest = d;
    }
    return {
      recorded: readings.length,
      expected,
      yield: readings.length / expected,
      gaps,
      longestGapMin: Math.round(longest / 60),
      spanHours: spanSec / 3600,
    };
  }, [readings, settings.collectionIntervalMins]);

  // Watering behaviour, read from the automation log rather than inferred
  // from the soil trace. Each entry records whether watering was commanded,
  // so the interval between them is a fact rather than an interpretation.
  const watering = useMemo(() => {
    const cutoff = range.hours ? Math.floor(Date.now() / 1000) - range.hours * 3600 : 0;
    const events = automationLog
      .filter((e) => e.watered && e.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (events.length < 1) return { count: 0 };
    const gaps = [];
    for (let i = 1; i < events.length; i++) gaps.push((events[i].timestamp - events[i - 1].timestamp) / 3600);
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    return {
      count: events.length,
      meanIntervalH: mean,
      shortestH: gaps.length ? Math.min(...gaps) : null,
      longestH: gaps.length ? Math.max(...gaps) : null,
      last: events.at(-1).timestamp,
    };
  }, [automationLog, range]);

  // How fast the soil dries between waterings, taken from consecutive falls
  // in the trace. Rises are watering events and are excluded.
  const dryingRate = useMemo(() => {
    const rates = [];
    for (let i = 1; i < readings.length; i++) {
      const dv = readings[i].soil - readings[i - 1].soil;
      const dtH = (readings[i].timestamp - readings[i - 1].timestamp) / 3600;
      if (dv < 0 && dtH > 0 && dtH < 6) rates.push(-dv / dtH);
    }
    if (!rates.length) return null;
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  }, [readings]);

  const labels = readings.map((r) =>
    new Date(r.timestamp * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }));

  const empty = readings.length === 0;

  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">Analysis</div>
        <h1>What the record shows</h1>
        <p>
          Summary statistics over the stored readings, with the continuity of the
          record reported alongside them. A mean computed over a series with gaps
          in it is not the same claim as one computed over a complete series, so
          both are shown together.
        </p>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button
            key={r.id}
            className={rangeId === r.id ? 'active' : ''}
            onClick={() => setRangeId(r.id)}
          >
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
              { k: 'Temperature', s: temp, unit: '°C', colour: 'var(--temp)', icon: 'thermo' },
              { k: 'Humidity',    s: hum,  unit: '%',  colour: 'var(--hum)',  icon: 'droplet' },
              { k: 'Soil moisture', s: soil, unit: '%', colour: 'var(--soil)', icon: 'droplet' },
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
              <span><i style={{ background: 'var(--temp)' }} />temperature</span>
              <span><i style={{ background: 'var(--hum)' }} />humidity</span>
              <span><i style={{ background: 'var(--soil)' }} />soil</span>
              <span className="legend-current">{readings.length} readings</span>
            </div>
            <LineChart
              labels={labels}
              datasets={[
                { data: readings.map((r) => r.temperature), borderColor: '#cf7a4b', borderWidth: 2, pointRadius: 0, tension: 0.3 },
                { data: readings.map((r) => r.humidity), borderColor: '#5f8fc9', borderWidth: 2, pointRadius: 0, tension: 0.3 },
                { data: readings.map((r) => r.soil), borderColor: '#4f9d6e', borderWidth: 2, pointRadius: 0, tension: 0.3 },
              ]}
              min={0}
              max={100}
            />
          </div>

          <div className="grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
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
                    A record is written only when a cloud transaction succeeds, so an
                    unbroken series is evidence that the system stayed reachable.
                    An interruption is counted where the gap exceeds twice the
                    acquisition interval.
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
                  {dryingRate != null && (
                    <p className="aut-desc" style={{ marginTop: 12 }}>
                      Soil falls at about <b className="mono">{f1(dryingRate)}% per hour</b> between
                      waterings. At the current threshold of {settings.moistureThreshold}% that
                      implies roughly {f1((100 - settings.moistureThreshold) / dryingRate)} hours
                      from saturated to dry.
                    </p>
                  )}
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
            <div className="card-title"><Icon name="bulb" size={14} /> How these figures are produced</div>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              Means, extremes and spread come from the stored readings directly.
              Watering counts come from the automation log rather than from the soil
              trace, because the log records what the controller decided while the
              trace only shows what followed. The drying rate is the mean of
              consecutive falls in soil moisture, excluding rises, which are
              waterings.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
