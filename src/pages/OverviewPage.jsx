import { useMemo } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';
import { vpd, findSegments, fitModel, hoursToThreshold } from '../dryingModel.js';
import { getProfile, coldStartRate } from '../plantProfiles.js';

// A forecast has to clear TWO different tests, because they ask different
// questions and passing one says nothing about the other.
//
//   trust  — "can the response to VPD be identified from these cycles at
//            all, or is it still mostly the prior?"  Same interlock the
//            controller uses.
//
//   width  — "how far apart are the ends of the prediction?"  The first
//            version of this page checked only trust and printed
//            "between 14.9 h and 52.6 days", which is not a forecast. A
//            model can know perfectly well how VPD moves the rate and
//            still scatter badly around it: identifiability and precision
//            are independent, and a usable number needs both.
//
// Beyond MAX_ETA_SPREAD the interval is reported instead of a point, which
// is honest about what is actually known.
const TRUST_TO_FORECAST = 0.30;
const MAX_ETA_SPREAD    = 3.0;   // high/low ratio

function fmtHours(h) {
  if (h == null || !Number.isFinite(h)) return null;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

// Soil over the trailing window, drawn from the readings already in memory.
function Sparkline({ readings, accent }) {
  const pts = useMemo(() => {
    if (!readings.length) return null;
    const lo = Math.min(...readings.map((r) => r.soil));
    const hi = Math.max(...readings.map((r) => r.soil));
    const span = Math.max(1, hi - lo);
    const t0 = readings[0].timestamp;
    const tSpan = Math.max(1, readings[readings.length - 1].timestamp - t0);
    return readings
      .map((r) => {
        const x = ((r.timestamp - t0) / tSpan) * 980;
        const y = 96 - ((r.soil - lo) / span) * 80;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [readings]);

  if (!pts) {
    return <div className="ov-spark-empty">No readings in this window yet.</div>;
  }
  return (
    <svg viewBox="0 0 980 112" className="ov-spark" role="img"
         aria-label="Soil moisture trend over the last 24 hours">
      <line x1="0" y1="96" x2="980" y2="96" />
      <line x1="0" y1="16" x2="980" y2="16" />
      <polyline points={pts} fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function OverviewPage({ node, go }) {
  const {
    temperature, humidity, soilMoisture, runPump, lastWateredDisplay,
    settings, isBoardOnline, isCameraOnline, sensorStatus, controllerHealth,
    lightOn, checkPending, togglePump, runCheck, toggleLight,
    historyReadings, activity, lastSeenDisplay,
  } = node;

  const threshold = Number(settings.moistureThreshold) || 50;
  const vpdNow = vpd(Number(temperature), Number(humidity));

  // Fit over the WHOLE record, not the visible window — a drying cycle from
  // last week is as informative as one from yesterday, subject to the
  // recency weighting inside the model.
  const model = useMemo(() => {
    const rows = historyReadings.map((r) => ({
      soil_moisture_percent: r.soil,
      temperature_c: r.temperature,
      humidity_percent: r.humidity,
      timestamp: r.timestamp,
    }));
    const segments = findSegments(rows, { subjectEpoch: settings.subjectEpoch || 0 });
    const profile = settings.plantMode === 'preset' ? getProfile(settings.plantType) : null;
    const a0 = profile ? coldStartRate(profile) : undefined;
    const now = Date.now() / 1000;
    const fit = fitModel(segments, now, a0 != null ? { a0 } : {});
    const eta =
      Number.isFinite(soilMoisture) && soilMoisture > threshold && vpdNow != null
        ? hoursToThreshold(fit, soilMoisture, threshold, vpdNow)
        : null;
    return { fit, eta, n: segments.length };
  }, [historyReadings, settings.plantMode, settings.plantType, settings.subjectEpoch, soilMoisture, threshold, vpdNow]);

  const trustOk = !model.fit.prior && model.fit.trust >= TRUST_TO_FORECAST;
  const spread =
    model.eta && model.eta.low != null && model.eta.high != null && model.eta.low > 0
      ? model.eta.high / model.eta.low
      : null;
  const tightEnough = spread == null || spread <= MAX_ETA_SPREAD;
  const canForecast = trustOk && model.eta && tightEnough;

  // Why the forecast is withheld, in the user's terms rather than the model's.
  const whyNoForecast = model.fit.prior
    ? 'No drying cycles observed yet.'
    : !trustOk
      ? `Model confidence ${Math.round(model.fit.trust * 100)}% — too few cycles across too narrow a VPD range.`
      : !tightEnough
        ? `The estimate spans ${fmtHours(model.eta.low)} to ${fmtHours(model.eta.high)} — too wide to act on.`
        : 'Soil is already at or below the threshold.';

  const last24 = useMemo(() => {
    const cutoff = Date.now() / 1000 - 24 * 3600;
    return historyReadings
      .filter((r) => r.timestamp >= cutoff && Number.isFinite(r.soil))
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [historyReadings]);

  const soilPct = Number.isFinite(soilMoisture) ? Math.max(0, Math.min(100, soilMoisture)) : 0;
  const belowThreshold = Number.isFinite(soilMoisture) && soilMoisture <= threshold;

  // Board B has no heartbeat of its own; the survey log is the only place its
  // silence shows up, so that is what is reported rather than a guess.
  const motorSuspect = (controllerHealth.lastSurveyError || '').includes('motor');

  return (
    <section className="page ov">
      <BusyBanner busy={node.busy ?? { active: false }} />

      {/* Warnings sit at the TOP and only exist when something is wrong. */}
      {!isBoardOnline && (
        <div className="ov-alert">
          <span className="ov-dot" aria-hidden="true" />
          <span>The controller has not reported recently. Readings below may be stale.</span>
        </div>
      )}

      <header className="ov-head">
        <div>
          <div className="kicker">OVERVIEW</div>
          <h1>Plant status</h1>
          <p>
            Live readings from the IIGS controller, newest first. Watering is
            decided and carried out on the board itself — this page is a window
            onto it, not the mechanism, and the plant is watered on schedule
            whether or not anyone has it open.
          </p>
        </div>
        <div className="ov-sync">
          <span className="kicker">LAST SEEN</span>
          <span className="mono">{lastSeenDisplay || '—'}</span>
        </div>
      </header>

      {/* HERO — soil is the quantity the system exists to control. */}
      <section className="card card-pad ov-hero">
        <div className="ov-hero-main">
          <div className="kicker">SOIL MOISTURE</div>
          <div className="ov-big">
            {Number.isFinite(soilMoisture) ? soilMoisture.toFixed(0) : '—'}
            <small>%</small>
          </div>

          <div className="ov-bar">
            <div className="ov-bar-fill" style={{ width: `${soilPct}%` }} />
            <div className="ov-bar-mark" style={{ left: `${threshold}%` }} title={`Threshold ${threshold}%`} />
          </div>
          <div className="ov-bar-legend">
            <span>Watering threshold {threshold}%</span>
            <span className={belowThreshold ? 'warn' : ''}>
              {belowThreshold ? 'At or below threshold' : 'Above threshold'}
            </span>
          </div>
        </div>

        <div className="ov-hero-side">
          {/* A forecast and a record are two different kinds of fact. */}
          <div className="ov-mini">
            <div className="kicker">NEXT WATERING</div>
            {canForecast ? (
              <>
                <div className="ov-mini-val">{fmtHours(model.eta.hours)}</div>
                <div className="ov-mini-sub">
                  {model.eta.low != null && model.eta.high != null
                    ? `between ${fmtHours(model.eta.low)} and ${fmtHours(model.eta.high)}`
                    : `from ${model.n} observed cycles`}
                </div>
              </>
            ) : (
              <>
                <div className="ov-mini-val muted">Not forecastable</div>
                <div className="ov-mini-sub">{whyNoForecast}</div>
              </>
            )}
          </div>

          <div className="ov-mini">
            <div className="kicker">LAST WATERED</div>
            <div className="ov-mini-val mono">{lastWateredDisplay || '—'}</div>
            <div className="ov-mini-sub">{runPump ? 'watering now' : 'idle'}</div>
          </div>
        </div>
      </section>

      {/* Supporting measurements — inputs to the number above. */}
      <section className="ov-stats">
        <div className="card card-pad ov-stat">
          <div className="kicker">TEMPERATURE</div>
          <div className="ov-stat-val">
            {Number.isFinite(temperature) ? temperature.toFixed(1) : '—'}<small> °C</small>
          </div>
        </div>
        <div className="card card-pad ov-stat">
          <div className="kicker">HUMIDITY</div>
          <div className="ov-stat-val">
            {Number.isFinite(humidity) ? humidity.toFixed(0) : '—'}<small> %</small>
          </div>
        </div>
        <div className="card card-pad ov-stat">
          <div className="kicker">VPD</div>
          <div className="ov-stat-val">
            {vpdNow != null ? vpdNow.toFixed(2) : '—'}<small> kPa</small>
          </div>
        </div>
        {/* Honest empty state: Board A does not yet forward range_mm. */}
        <div className="card card-pad ov-stat ov-stat-empty">
          <div className="kicker">RESERVOIR</div>
          <div className="ov-stat-val muted">—</div>
          <div className="ov-stat-sub">Not calibrated</div>
        </div>
      </section>

      <section className="card card-pad">
        <div className="ov-row-head">
          <div className="kicker">SOIL — LAST 24 HOURS</div>
          <div className="ov-row-meta">
            {last24.length} readings
            {settings.collectionIntervalMins ? ` · ${settings.collectionIntervalMins} min interval` : ''}
          </div>
        </div>
        <Sparkline readings={last24} accent="var(--accent)" />
      </section>

      {/* Manual control: one click away, but not the headline. */}
      <section className="card card-pad ov-manual">
        <span className="kicker">MANUAL</span>
        <button className="btn btn-danger" onClick={togglePump} disabled={runPump}>
          <Icon name="droplet" size={16} /> {runPump ? 'Watering…' : 'Water now'}
        </button>
        <button className={`btn ${lightOn ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleLight()}>
          <Icon name="zap" size={16} /> Light {lightOn ? 'on' : 'off'}
        </button>
        <button className="btn btn-ghost" onClick={runCheck} disabled={checkPending}>
          <Icon name="pulse" size={16} /> {checkPending ? 'Checking…' : 'Run check'}
        </button>
        <span className="ov-spacer" />
        <button className="btn btn-ghost" onClick={() => go('settings')}>
          <Icon name="sliders" size={16} /> Settings
        </button>
      </section>

      {/* Board health — the question that is expensive to answer any other way. */}
      <section className="card card-pad ov-boards">
        <span className="kicker">BOARDS</span>
        <span className={`ov-board ${isBoardOnline ? 'ok' : 'bad'}`}>
          <span className="ov-dot" aria-hidden="true" />A — coordinator
        </span>
        <span className={`ov-board ${motorSuspect ? 'warn' : 'ok'}`}>
          <span className="ov-dot" aria-hidden="true" />B — motor
        </span>
        <span className={`ov-board ${sensorStatus === 'OK' ? 'ok' : 'bad'}`}>
          <span className="ov-dot" aria-hidden="true" />C — sensors
        </span>
        <span className={`ov-board ${isCameraOnline ? 'ok' : 'warn'}`}>
          <span className="ov-dot" aria-hidden="true" />Camera
        </span>
        <span className="ov-spacer" />
        {controllerHealth.uptimeSec != null && (
          <span className="mono ov-row-meta">
            uptime {(controllerHealth.uptimeSec / 3600).toFixed(1)} h
          </span>
        )}
      </section>

      <section className="card card-pad">
        <div className="ov-row-head">
          <div className="kicker">RECENT EVENTS</div>
          <button className="btn btn-ghost btn-sm" onClick={() => go('notifications')}>All</button>
        </div>
        {activity.length === 0 ? (
          <div className="feed-empty">Nothing yet — events appear when the pump, link or alerts change.</div>
        ) : (
          <ul className="feed ov-feed">
            {activity.slice(0, 6).map((a, i) => (
              <li key={i}>
                <span className={`ov-dot ${a.tone}`} aria-hidden="true" />
                <div>
                  <div className="feed-txt">{a.title} — {a.body}</div>
                  <div className="feed-time mono">{a.time}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}