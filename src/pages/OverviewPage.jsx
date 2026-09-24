import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';

const QUICK = [
  ['analysis', 'pulse', 'Analysis', 'What the record shows'],
  ['settings', 'sliders', 'Settings', 'What the controller acts on'],
  ['camera', 'camera', 'Camera', 'Pan the view'],
  ['history', 'chart', 'History', 'Trends & insights'],
  ['notifications', 'bell', 'Notifications', 'Open alert log'],
];

const ICONS = { pump: 'droplet', temp: 'thermo', hum: 'droplet', soil: 'droplet', conn: 'alert', rest: 'check', info: 'bell' };

export default function OverviewPage({ node, go }) {
  const {
    temperature, humidity, soilMoisture, runPump, lastWateredDisplay,
    health, activity, settings, isBoardOnline,
    lightOn, checkPending, togglePump, runCheck, toggleLight,
  } = node;
  return (
    <section className="page overview-page">
      <BusyBanner busy={node.busy ?? { active: false }} />
      <div className="page-head">
        <div className="kicker">Overview</div>
        <h1>Plant status at a glance</h1>
        <p>Live readings from the IIGS controller. The dashboard is a window into the plant — watering still runs on the board even if this page is closed.</p>
      </div>

      <div className={`health ${health.level}`}>
        <div className="health-ico"><Icon name={health.level === 'ok' ? 'shield' : 'alert'} size={22} /></div>
        <div>
          <div className="health-title">{health.title}</div>
          <div className="health-sub">{health.sub}</div>
        </div>
        <div className="health-sync">last sync<br /><span className="mono">{isBoardOnline ? 'live' : 'stale'}</span></div>
      </div>

      <div className="grid-stats">
        <div className="card stat-card card-pad" style={{ '--stat-tint': 'rgba(207,122,75,.14)' }}>
          <div className="stat-top"><div className="stat-icon"><Icon name="thermo" /></div></div>
          <div className="stat-value">{Number(temperature).toFixed(1)} <small>°C</small></div>
          <div className="stat-label">Air temperature</div>
        </div>
        <div className="card stat-card card-pad" style={{ '--stat-tint': 'rgba(95,143,201,.14)' }}>
          <div className="stat-top"><div className="stat-icon"><Icon name="droplet" /></div></div>
          <div className="stat-value">{Number(humidity).toFixed(1)} <small>%</small></div>
          <div className="stat-label">Relative humidity</div>
        </div>
        <div className="card stat-card card-pad" style={{ '--stat-tint': 'rgba(79,157,110,.14)' }}>
          <div className="stat-top"><div className="stat-icon"><Icon name="droplet" /></div></div>
          <div className="stat-value">{Number(soilMoisture).toFixed(1)} <small>%</small></div>
          <div className="stat-label">Soil moisture</div>
          <div className="stat-sub">
            {soilMoisture <= settings.moistureThreshold ? 'below threshold — watering' : `threshold ${settings.moistureThreshold}%`}
          </div>
        </div>
        <div className="card stat-card card-pad" style={{ '--stat-tint': 'rgba(185,134,47,.16)' }}>
          <div className="stat-top"><div className="stat-icon"><Icon name="zap" /></div></div>
          <div className={`stat-state ${runPump ? 'on' : 'off'}`}>{runPump ? 'REQUESTED' : 'IDLE'}</div>
          <div className="stat-label" style={{ marginTop: 10 }}>Watering</div>
          <div className="stat-sub">Last watered {lastWateredDisplay}</div>
        </div>
      </div>

      <div className="overview-panels">
        <div className="card card-pad overview-panel">
          <div className="card-title"><Icon name="home" size={14} /> Quick links</div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14, marginBottom: 20 }}>
            <button className="btn btn-primary" onClick={runCheck} disabled={checkPending}>
              <Icon name="pulse" size={16} /> {checkPending ? 'Checking\u2026' : 'Run a check now'}
            </button>
            <div className="aut-desc">
              Reads the sensors, applies the threshold, and waters only if the
              soil is actually dry.
            </div>

            <button className="btn btn-danger" onClick={togglePump} disabled={runPump}>
              <Icon name="droplet" size={16} /> {runPump ? 'Watering\u2026' : 'Water now'}
            </button>
            <div className="aut-desc">
              Waters immediately, without consulting the threshold. The minimum
              interval between waterings does not apply.
            </div>

            <button className={`btn ${lightOn ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleLight()}>
              <Icon name="zap" size={16} /> Grow light is {lightOn ? 'on' : 'off'}
            </button>
          </div>

          <div className="quick-grid" style={{ marginTop: 14 }}>
            {QUICK.map(([page, ico, title, sub]) => (
              <button key={page} className="quick-btn" onClick={() => go(page)}>
                <Icon name={ico} />
                <span>{title}<br /><small>{sub}</small></span>
              </button>
            ))}
          </div>
        </div>
        <div className="card card-pad overview-panel">
          <div className="card-title"><Icon name="pulse" size={14} /> Recent activity</div>
          {activity.length === 0 ? (
            <div className="feed-empty">No activity yet — events appear when the pump, link, or alerts change.</div>
          ) : (
            <ul className="feed" style={{ marginTop: 6 }}>
              {activity.slice(0, 8).map((a, i) => (
                <li key={i}>
                  <div className={`feed-ico ${a.tone}`}><Icon name={ICONS[a.type] || 'bell'} size={15} /></div>
                  <div>
                    <div className="feed-txt"><b>{a.title}</b> — {a.body}</div>
                    <div className="feed-time">{a.time}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
