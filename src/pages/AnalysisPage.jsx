import { useMemo, useState } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';
import LineChart from '../LineChart.jsx';
import {
  VPD_REF, vpd, findSegments, fitModel, rateAt, hoursToThreshold, describe, backtest,
} from '../dryingModel.js';
import { getProfile, coldStartRate } from '../plantProfiles.js';

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
function f2(n) { return Number(n).toFixed(2); }

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

  const model = useMemo(() => {
    const rows = historyReadings
      .filter((r) => Number.isFinite(r.timestamp) && Number.isFinite(r.soil))
      .map((r) => ({
        timestamp: r.timestamp,
        soil_moisture_percent: r.soil,
        temperature_c: r.temperature,
        humidity_percent: r.humidity,
      }));

    const segments = findSegments(rows, { subjectEpoch: settings.subjectEpoch || 0 });
    if (!segments.length) return null;

    const now = Math.floor(Date.now() / 1000);

    const profile = settings.plantMode === 'preset' ? getProfile(settings.plantType) : null;
    const a0 = profile ? coldStartRate(profile) : undefined;
    const fit = fitModel(segments, now, a0 != null ? { a0 } : {});

    const latest = rows.at(-1);
    const vpdNow = latest ? vpd(latest.temperature_c, latest.humidity_percent) : VPD_REF;
    const soilNow = latest ? latest.soil_moisture_percent : null;
    const threshold = settings.moistureThreshold;

    const eta =
      soilNow != null && Number.isFinite(vpdNow)
        ? hoursToThreshold(fit, soilNow, threshold, vpdNow)
        : null;

    const error = backtest(segments, now);

    return {
      segments, fit, eta, error,
      vpdNow: Number.isFinite(vpdNow) ? vpdNow : null,
      rateNow: Number.isFinite(vpdNow) ? rateAt(fit, vpdNow) : null,
      note: describe(fit),
    };
  }, [historyReadings, settings.moistureThreshold, settings.plantMode, settings.plantType, settings.subjectEpoch]);

  const labels = readings.map((r) =>
    new Date(r.timestamp * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }));

  const empty = readings.length === 0;

  return (
    <section className="page">
      <BusyBanner busy={node.busy ?? { active: false }} />
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
                  {model?.rateNow != null && (
                    <p className="aut-desc" style={{ marginTop: 12 }}>
                      At present conditions the fitted model puts the drying rate at{' '}
                      <b className="mono">{f2(model.rateNow)}% per hour</b>. The fit itself is
                      below.
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
            <div className="card-title">
              <Icon name="chart" size={14} /> Fitted drying model
            </div>

            {model ? (
              <>
                <div className="stat-value" style={{ marginTop: 10 }}>
                  {f2(model.fit.a)}<small> % per hour</small>
                </div>
                <div className="stat-sub">
                  at reference demand ({VPD_REF} kPa) &middot; fitted from {model.fit.n}{' '}
                  {model.fit.n === 1 ? 'drying cycle' : 'drying cycles'} across the whole record
                </div>

                <div className="mini-stats" style={{ marginTop: 14 }}>
                  <div className="mini-stat">
                    <div className="k">sensitivity to demand</div>
                    <div className="v">{f2(model.fit.b)} %/h per kPa</div>
                  </div>
                  <div className="mini-stat">
                    <div className="k">measured, not assumed</div>
                    <div className="v">{Math.round(model.fit.trust * 100)}%</div>
                  </div>
                  <div className="mini-stat">
                    <div className="k">demand spread seen</div>
                    <div className="v">{f2(model.fit.spread)} kPa</div>
                  </div>
                  {model.error && (
                    <div className="mini-stat">
                      <div className="k">leave-one-out error</div>
                      <div className="v">{(model.error.relative * 100).toFixed(1)}%</div>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 14, height: 6, borderRadius: 3,
                    background: 'var(--line)', overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(1.5, model.fit.trust * 100)}%`,
                      height: '100%',
                      background: model.fit.trust > 0.5 ? 'var(--ok)' : 'var(--warn)',
                    }}
                  />
                </div>

                <p className="aut-desc" style={{ marginTop: 10 }}>{model.note}</p>

                {model.eta && Number.isFinite(model.eta.hours) && (
                  <p className="aut-desc" style={{ marginTop: 10 }}>
                    From the latest reading, the soil reaches the{' '}
                    {settings.moistureThreshold}% threshold in{' '}
                    <b className="mono">{f1(model.eta.hours)} hours</b> if conditions hold
                    {Number.isFinite(model.eta.low) && Number.isFinite(model.eta.high) && (
                      <> &mdash; between {f1(model.eta.low)} and {f1(model.eta.high)} hours
                      across one standard deviation of the fitted rate</>
                    )}.
                  </p>
                )}

                <div className="table-scroll" style={{ marginTop: 16 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Cycle began</th>
                        <th>Hours</th>
                        <th>Points</th>
                        <th>Rate %/h</th>
                        <th>r&sup2;</th>
                        <th>VPD kPa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.segments.map((sg) => (
                        <tr key={sg.tStart}>
                          <td>
                            {new Date(sg.tStart * 1000).toLocaleString([], {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </td>
                          <td className="mono">{f1(sg.hours)}</td>
                          <td className="mono">{sg.points}</td>
                          <td className="mono">{f2(sg.rate)}</td>
                          <td className="mono">{sg.r2.toFixed(3)}</td>
                          <td className="mono">{f2(sg.vpd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="stat-sub" style={{ marginTop: 10 }}>
                No clean drying cycle in the record yet. A cycle needs at least four
                consecutive readings spanning three hours or more, with no watering
                and no logging gap longer than three hours inside it.
              </div>
            )}
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="bulb" size={14} /> How these figures are produced</div>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              Means, extremes and spread come from the stored readings directly.
              Watering counts come from the automation log rather than from the soil
              trace, because the log records what the controller decided while the
              trace only shows what followed.
            </p>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              The drying model is fitted rather than averaged. The record is first cut
              into drying cycles wherever soil moisture rises by three points or more,
              which is a watering, or wherever readings are more than three hours apart,
              which is a gap the trace cannot be assumed to bridge. Each cycle
              contributes its own rate, weighted by how long it ran, how cleanly it fitted
              a straight line, and how recent it is, with a twenty-one-day half-life so
              that a pot whose roots have since grown does not keep voting.
            </p>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              Two numbers come out. The rate at reference demand is determined by a single
              cycle. The sensitivity to evaporative demand cannot be determined at all
              unless conditions varied between cycles, however many cycles there are, so
              it is reported with the share of it that is measured rather than assumed. A
              low share is not a fault in the fit; it is the fit declining to claim a
              figure the record cannot support.
            </p>
          </div>
        </>
      )}
    </section>
  );
}