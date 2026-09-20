import { useMemo, useState } from 'react';
import { Icon } from '../icons.jsx';

// The stored record, summarised by day rather than listed row by row. A
// thousand readings tell you very little as a table; the same readings
// collapsed to a daily mean, with the extremes and the count beside it, tell
// you what the week was like and where the gaps are.

const RANGES = [
  { id: '7d',  label: 'Last 7 days',  days: 7 },
  { id: '14d', label: 'Last 14 days', days: 14 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All',          days: null },
];

function f1(n) { return n == null ? '—' : Number(n).toFixed(1); }

function dayKey(ts) {
  return new Date(ts * 1000).toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function summarise(values) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!clean.length) return null;
  return {
    mean: clean.reduce((a, b) => a + b, 0) / clean.length,
    min: Math.min(...clean),
    max: Math.max(...clean),
  };
}

export default function HistoryPage({ node }) {
  const { historyReadings, automationLog, settings, deleteReading, clearAllHistory } = node;
  const [rangeId, setRangeId] = useState('7d');
  const [expanded, setExpanded] = useState(null);
  const range = RANGES.find((r) => r.id === rangeId);

  const readings = useMemo(() => {
    const cutoff = range.days ? Math.floor(Date.now() / 1000) - range.days * 86400 : 0;
    return historyReadings
      .filter((r) => r.timestamp && r.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [historyReadings, range]);

  // Grouped by calendar day, newest first. The expected count per day comes
  // from the acquisition interval, so a day with fewer readings than it
  // should have is visible rather than merely shorter.
  const days = useMemo(() => {
    const intervalMin = settings.collectionIntervalMins || 60;
    const perDay = Math.max(1, Math.round((24 * 60) / intervalMin));
    const buckets = {};
    readings.forEach((r) => {
      (buckets[dayKey(r.timestamp)] ||= []).push(r);
    });
    const waterByDay = {};
    automationLog.filter((e) => e.watered).forEach((e) => {
      if (!e.timestamp) return;
      waterByDay[dayKey(e.timestamp)] = (waterByDay[dayKey(e.timestamp)] || 0) + 1;
    });
    return Object.entries(buckets)
      .map(([key, rows]) => ({
        key,
        rows: rows.sort((a, b) => b.timestamp - a.timestamp),
        count: rows.length,
        expected: perDay,
        temp: summarise(rows.map((r) => r.temperature)),
        hum: summarise(rows.map((r) => r.humidity)),
        soil: summarise(rows.map((r) => r.soil)),
        waterings: waterByDay[key] || 0,
      }))
      .sort((a, b) => new Date(b.rows[0].timestamp * 1000) - new Date(a.rows[0].timestamp * 1000));
  }, [readings, automationLog, settings.collectionIntervalMins]);

  const overall = useMemo(() => ({
    temp: summarise(readings.map((r) => r.temperature)),
    hum: summarise(readings.map((r) => r.humidity)),
    soil: summarise(readings.map((r) => r.soil)),
  }), [readings]);

  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">History</div>
        <h1>The stored record</h1>
        <p>
          Readings summarised by day, with the count beside each mean so a day
          that is short of readings is visible rather than merely lower. The
          system is designed to retain thirty days; the period actually held
          depends on how long it has been running.
        </p>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button key={r.id} className={rangeId === r.id ? 'active' : ''} onClick={() => setRangeId(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      {readings.length === 0 ? (
        <div className="card card-pad">
          No readings in this period. Either the controller has recorded none yet,
          or recording is switched off in settings.
        </div>
      ) : (
        <>
          <div className="grid-3">
            {[
              { k: 'Temperature', s: overall.temp, unit: '°C', colour: 'var(--temp)' },
              { k: 'Humidity',    s: overall.hum,  unit: '%',  colour: 'var(--hum)' },
              { k: 'Soil moisture', s: overall.soil, unit: '%', colour: 'var(--soil)' },
            ].map(({ k, s, unit, colour }) => (
              <div className="card card-pad" key={k}>
                <div className="card-title">{k}</div>
                <div className="stat-value mono" style={{ color: colour, marginTop: 8 }}>
                  {f1(s?.mean)}{unit}
                </div>
                <div className="stat-sub">
                  {s ? `range ${f1(s.min)}–${f1(s.max)}${unit}` : 'no data'}
                </div>
              </div>
            ))}
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title" style={{ marginBottom: 12 }}>
              <Icon name="chart" size={14} /> By day
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Readings</th>
                    <th>Temperature</th>
                    <th>Humidity</th>
                    <th>Soil</th>
                    <th>Watered</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <>
                      <tr key={d.key}>
                        <td className="td-main">{d.key}</td>
                        <td className="mono">
                          {d.count}
                          {d.count < d.expected && (
                            <span className="badge warn" style={{ marginLeft: 8 }}>
                              of {d.expected}
                            </span>
                          )}
                        </td>
                        <td className="mono">{f1(d.temp?.mean)} °C</td>
                        <td className="mono">{f1(d.hum?.mean)} %</td>
                        <td className="mono">{f1(d.soil?.mean)} %</td>
                        <td className="mono">{d.waterings || '—'}</td>
                        <td>
                          <button className="btn btn-sm btn-ghost"
                                  onClick={() => setExpanded(expanded === d.key ? null : d.key)}>
                            {expanded === d.key ? 'Hide' : 'Readings'}
                          </button>
                        </td>
                      </tr>
                      {expanded === d.key && (
                        <tr key={`${d.key}-rows`}>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <div className="stack-list">
                              {d.rows.map((r) => (
                                <div className="status-cell" key={r.id}>
                                  <span className="mono">
                                    {new Date(r.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                  <span className="mono">{f1(r.temperature)} °C</span>
                                  <span className="mono">{f1(r.humidity)} %</span>
                                  <span className="mono">{f1(r.soil)} %</span>
                                  <button className="btn btn-sm btn-danger" onClick={() => deleteReading(r.id)}>
                                    <Icon name="trash" size={13} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="aut-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-danger" onClick={clearAllHistory}>
                <Icon name="trash" size={16} /> Delete all {historyReadings.length} readings
              </button>
            </div>
            <div className="aut-sub">
              Deleting removes the record from the database for everyone, and it
              cannot be undone. Export first if the readings matter.
            </div>
          </div>
        </>
      )}
    </section>
  );
}
