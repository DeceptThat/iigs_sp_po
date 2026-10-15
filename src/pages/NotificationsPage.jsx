import { useMemo, useState } from 'react';
import { Icon } from '../icons.jsx';

                                                   
  
                                                                               
                                                                            
                                                                       
                                         
  
                                                                            
                                                                             
                                                                              
                                                                    
const META = {
                                  
  watered:              { icon: 'droplet', tone: 'ok',    unit: '%'  },
  soil_low:             { icon: 'droplet', tone: 'warn',  unit: '%',  family: 'soil' },
  soil_recovered:       { icon: 'check',   tone: 'ok',    unit: '%',  clears: 'soil' },
  temp_out_of_range:    { icon: 'thermo',  tone: 'warn',  unit: '°C', family: 'temp' },
  temp_recovered:       { icon: 'check',   tone: 'ok',    unit: '°C', clears: 'temp' },
  reservoir_low:        { icon: 'droplet', tone: 'warn',  unit: '%',  family: 'reservoir' },
  reservoir_empty:      { icon: 'alert',   tone: 'crit',  unit: '%',  family: 'reservoir' },
  reservoir_unknown:    { icon: 'alert',   tone: 'warn',               family: 'reservoir' },
  reservoir_refilled:   { icon: 'check',   tone: 'ok',    unit: '%',  clears: 'reservoir' },
  sensor_no_response:   { icon: 'alert',   tone: 'warn',               family: 'sensor' },
  sensor_reset:         { icon: 'alert',   tone: 'warn',               family: 'sensor' },
  sensor_unrecoverable: { icon: 'alert',   tone: 'crit',               family: 'sensor' },
  sensor_recovered:     { icon: 'check',   tone: 'ok',    unit: '%',  clears: 'sensor' },
  failsafe_active:      { icon: 'shield',  tone: 'crit',  unit: '%'  },
  capture_failed:       { icon: 'camera',  tone: 'muted'              },

                                       
  pump: { icon: 'droplet', tone: 'ok' },
  temp: { icon: 'thermo',  tone: 'crit' },
  hum:  { icon: 'droplet', tone: 'warn' },
  soil: { icon: 'droplet', tone: 'warn' },
  conn: { icon: 'alert',   tone: 'warn' },
  rest: { icon: 'check',   tone: 'ok' },
  info: { icon: 'bell',    tone: 'muted' },
};

const TONE_BG = {
  ok: 'var(--ok-bg)', warn: 'var(--warn-bg)', crit: 'var(--crit-bg)',
  muted: 'rgba(139,148,139,.16)',
};
const TONE_FG = {
  ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)', muted: 'var(--muted)',
};

function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'ok';
}

const FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'open',    label: 'Unresolved' },
  { id: 'crit',    label: 'Critical' },
];

export default function NotificationsPage({ node }) {
  const {
    notifications, deviceNotifications,
    markAllRead, clearNotifs, toggleRead, deleteNotif, clearDeviceNotifs,
  } = node;

  const [source, setSource] = useState('device');
  const [filter, setFilter] = useState('all');
  const raw = source === 'device' ? deviceNotifications : notifications;

                                                 
    
                                                                                
                                                                           
                                                                            
                                                  
  const { list, pairable, counts } = useMemo(() => {
    const dated = raw.length > 0 && raw.every((n) => Number.isFinite(n.timestamp));
    const items = raw.map((n) => ({ ...n, meta: META[n.type] || META.info }));

    if (dated) {
      const byTime = [...items].sort((a, b) => b.timestamp - a.timestamp);                
      const openByFamily = new Map();                                              
                                                                            
                                         
      for (let i = byTime.length - 1; i >= 0; i--) {
        const n = byTime[i];
        const { family, clears } = n.meta;
        if (family) {
                                                                                
            
                                                                              
                                                                             
                                                                            
                                                                               
                                                 
          const openList = openByFamily.get(family) || [];
          for (const prev of openList) prev.supersededBy = n;
          if (openList.length) n.supersedes = openList[openList.length - 1];
          openList.push(n);
          openByFamily.set(family, openList);
        } else if (clears) {
          const openList = openByFamily.get(clears);
          if (openList && openList.length) {
            for (const o of openList) o.resolvedBy = n;
            n.resolves = openList[openList.length - 1];
            openByFamily.delete(clears);
          }
        }
      }
      const c = {
        all: byTime.length,
        open: byTime.filter((n) => n.meta.family && !n.resolvedBy && !n.supersededBy).length,
        crit: byTime.filter((n) => n.severity === 'critical' || n.meta.tone === 'crit').length,
      };
      return { list: byTime, pairable: true, counts: c };
    }

    return {
      list: items,
      pairable: false,
      counts: {
        all: items.length,
        open: items.filter((n) => n.meta.family).length,
        crit: items.filter((n) => n.severity === 'critical' || n.meta.tone === 'crit').length,
      },
    };
  }, [raw]);

  const shown = useMemo(() => {
    let v = list;
    if (filter === 'open') v = v.filter((n) => n.meta.family && !n.resolvedBy && !n.supersededBy);
    if (filter === 'crit') v = v.filter((n) => n.severity === 'critical' || n.meta.tone === 'crit');
                                                                             
                                                        
                                                                            
                                                                           
    if (pairable) v = v.filter((n) => !n.resolves && !n.supersededBy);
    return v;
  }, [list, filter, pairable]);

  const fmtGap = (a, b) => {
    const s = Math.abs(b - a);
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} days`;
  };

  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">Notifications</div>
        <h1>Alert log</h1>
        <p>
          Alerts from the controller are stored in the database and survive a closed
          browser. The dashboard raises its own locally, listed separately.
        </p>
      </div>

      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={source === 'device' ? 'active' : ''}
                onClick={() => { setSource('device'); setFilter('all'); }}>
          From the controller · {deviceNotifications.length}
        </button>
        <button className={source === 'portal' ? 'active' : ''}
                onClick={() => { setSource('portal'); setFilter('all'); }}>
          From this dashboard · {notifications.length}
        </button>
      </div>

      {raw.length > 0 && (
        <div className="seg" style={{ marginBottom: 14 }}>
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'active' : ''}
                    onClick={() => setFilter(f.id)}>
              {f.label} · {counts[f.id]}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {source === 'portal' ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={markAllRead}>
              <Icon name="check" size={15} /> Mark all read
            </button>
            <button className="btn btn-ghost btn-sm" onClick={clearNotifs}>
              <Icon name="trash" size={15} /> Clear this browser
            </button>
          </>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={clearDeviceNotifs}>
            <Icon name="trash" size={15} /> Clear for everyone
          </button>
        )}
      </div>

      <div className="card">
        {shown.length === 0 ? (
          <div className="notif-empty">
            {raw.length === 0
              ? (source === 'device'
                  ? 'The controller has raised nothing. A quiet plant.'
                  : 'Nothing raised in this browser session.')
              : filter === 'open'
                ? 'Nothing outstanding. Every warning in the log has since cleared.'
                : 'Nothing matches this filter.'}
          </div>
        ) : (
          shown.map((n) => {
            const tone = n.resolvedBy
              ? 'muted'
              : source === 'device' ? severityTone(n.severity) : n.meta.tone;
            const showValue =
              n.value != null && Number.isFinite(n.value) && n.value > -2000000000;
            return (
              <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`}
                   style={n.resolvedBy ? { opacity: 0.72 } : undefined}>
                <div className="notif-ico" style={{ background: TONE_BG[tone], color: TONE_FG[tone] }}>
                  <Icon name={n.resolvedBy ? 'check' : n.meta.icon} size={16} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="notif-title" style={{ textTransform: source === 'device' ? 'capitalize' : 'none' }}>
                    {n.title}
                    {source === 'device' && showValue && (
                      <span className="badge" style={{ marginLeft: 8, background: TONE_BG[tone], color: TONE_FG[tone] }}>
                        {n.value}{n.meta.unit || ''}
                      </span>
                    )}
                    {n.resolvedBy && (
                      <span className="badge" style={{ marginLeft: 8, background: 'var(--ok-bg)', color: 'var(--ok)' }}>
                        resolved
                      </span>
                    )}
                    {!n.resolvedBy && n.meta.family && (
                      <span className="badge" style={{ marginLeft: 8, background: TONE_BG.muted, color: TONE_FG.muted }}>
                        open
                      </span>
                    )}
                  </div>
                  <div className="notif-body">{n.body}</div>
                  {n.supersedes && (
                    <div className="notif-body" style={{ color: 'var(--muted)', marginTop: 4 }}>
                      Escalated from an earlier warning {fmtGap(n.supersedes.timestamp, n.timestamp)} before this.
                    </div>
                  )}
                  {n.resolvedBy && (
                    <div className="notif-body" style={{ color: 'var(--ok)', marginTop: 4 }}>
                      Cleared after {fmtGap(n.timestamp, n.resolvedBy.timestamp)} — {n.resolvedBy.body}
                    </div>
                  )}
                  <div className="notif-time">{n.time}</div>
                </div>
                {source === 'portal' && (
                  <div className="notif-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleRead(n.id)}>
                      {n.read ? 'Unread' : 'Read'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteNotif(n.id)} aria-label="Delete">
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {source === 'device' && (
        <>
          <div className="card card-pad" style={{ marginTop: 16 }}>
            <div className="card-title"><Icon name="shield" size={14} /> Two alerts cannot be switched off</div>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              The failsafe notification is always sent, whatever the settings say.
              It reports that the controller became unreachable and the sensor
              board watered the plant on its own, which is the single case where a
              missing alert is indistinguishable from nothing having happened.
            </p>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
              An empty reservoir is sent on the same terms. Below that level the
              pump would draw air, and a system that cannot deliver water has
              stopped doing its job even though every reading still looks normal.
            </p>
          </div>

          {pairable && (
            <div className="card card-pad" style={{ marginTop: 16 }}>
              <div className="card-title"><Icon name="check" size={14} /> How a warning closes</div>
              <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
                The controller sends a recovery notice when a condition ends, and each
                one is folded into the warning it closes rather than listed separately.
                A warning still marked <b>open</b> has not cleared — which is the
                question worth being able to answer at a glance, and the one a log of
                repeating identical warnings cannot.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
