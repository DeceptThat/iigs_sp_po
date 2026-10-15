import { useMemo } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';
import { vpd } from '../dryingModel.js';

                            
  
                                                                        
                                                                            
                                                                             
                                                                           
                                                                            
                                                                         
                                                                              
  
                                                                         
                                 

                                                          
  
                                                                        
                                                                             
                                                                            
                                    
  
                                                                          
                                                                      
                                                                           
                                                      
                                                                          
                                                              
                                                                         
                                                                            
                                                            
const WETTING_RISE_PCT = 10;
const ATTRIBUTABLE_GAP_S = 6 * 3600;                                      

function dryingSinceWetting(readings) {
  const pts = readings
    .filter((r) => Number.isFinite(r.soil) && r.soil > 2 && r.soil < 100
                   && Number.isFinite(r.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (pts.length < 5) return null;

  const med = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 2), i + 3).map((q) => q.soil).sort((a, b) => a - b);
    return { t: p.timestamp, m: w[Math.floor(w.length / 2)] };
  });

                                                             
  let start = 0;
  for (let i = 1; i < med.length; i++) {
    const gap = med[i].t - med[i - 1].t;
    const step = med[i].m - med[i - 1].m;
    if (gap > ATTRIBUTABLE_GAP_S) start = i;
    else if (step >= WETTING_RISE_PCT) start = i;
    else if (step <= -WETTING_RISE_PCT) start = i;
  }

  const seg = med.slice(start);
  if (seg.length < 4) return null;
  const hours = (seg[seg.length - 1].t - seg[0].t) / 3600;
  if (hours < 1) return null;

  const drop = seg[0].m - seg[seg.length - 1].m;
  return {
    hours,
    drop,
    rate: drop / hours,
    from: seg[0].m,
    to: seg[seg.length - 1].m,
    since: seg[0].t,
    wetted: start > 0,                                                     
  };
}

function fmtSpan(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

                                                                            
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
    <svg viewBox="0 0 980 112" preserveAspectRatio="none" className="ov-spark" role="img"
         aria-label="Soil moisture trend over the last 24 hours">
      <line x1="0" y1="96" x2="980" y2="96" />
      <line x1="0" y1="16" x2="980" y2="16" />
      <polyline points={pts} fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
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

  const drying = useMemo(() => dryingSinceWetting(historyReadings), [historyReadings]);

  const last24 = useMemo(() => {
    const cutoff = Date.now() / 1000 - 24 * 3600;
    return historyReadings
      .filter((r) => r.timestamp >= cutoff && Number.isFinite(r.soil))
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [historyReadings]);

  const soilPct = Number.isFinite(soilMoisture) ? Math.max(0, Math.min(100, soilMoisture)) : 0;
  const belowThreshold = Number.isFinite(soilMoisture) && soilMoisture <= threshold;

                                                                               
                                                   
  const reservoirPct = Number.isFinite(node.reservoirPercent) ? node.reservoirPercent : null;
  const reservoirMm = Number.isFinite(node.reservoirDepthMm) ? node.reservoirDepthMm : null;

                                                                              
                                                                       
  const motorSuspect = (controllerHealth.lastSurveyError || '').includes('motor');

  return (
    <section className="page ov">
      <BusyBanner busy={node.busy ?? { active: false }} />

                                                                             
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
            Live readings from the IIGS controller, newest first.
          </p>
        </div>
        <div className="ov-sync">
          <span className="kicker">LAST SEEN</span>
          <span className="mono">{lastSeenDisplay || '—'}</span>
        </div>
      </header>

                                                                       
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
                                                                              
                                                
          <div className="ov-mini">
            <div className="kicker">DRIED SINCE WATERING</div>
            {drying ? (
              <>
                <div className="ov-mini-val">
                  {drying.drop > 0 ? drying.drop.toFixed(0) : '0'}
                  <small> pts</small>
                </div>
                <div className="ov-mini-sub">
                  {`${drying.from.toFixed(0)}% → ${drying.to.toFixed(0)}% over ${fmtSpan(drying.hours)}`}
                  {drying.hours >= 6 && drying.drop >= 3
                    ? ` · ${drying.rate.toFixed(2)} %/h`
                    : ' · too short to rate'}
                </div>
              </>
            ) : (
              <>
                <div className="ov-mini-val muted">—</div>
                <div className="ov-mini-sub">Not enough readings since the last wetting event.</div>
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
        <div className={`card card-pad ov-stat ${reservoirPct == null ? 'ov-stat-empty' : ''}`}>
          <div className="kicker">RESERVOIR</div>
          <div className={`ov-stat-val ${reservoirPct == null ? 'muted' : ''}`}>
            {reservoirPct == null ? '—' : reservoirPct.toFixed(0)}
            {reservoirPct != null && <small> %</small>}
          </div>
          <div className="ov-stat-sub">
            {reservoirPct == null
              ? 'Awaiting a calibrated reading'
              : reservoirMm != null ? `${reservoirMm.toFixed(0)} mm of usable water` : 'of usable column'}
          </div>
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
