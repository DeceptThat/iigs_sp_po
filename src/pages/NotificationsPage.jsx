import { useState } from 'react';
import { Icon } from '../icons.jsx';

// Two sources, kept apart on purpose.
//
// The controller raises its own notifications and stores them in the
// database, so they survive a closed browser and are the same for everyone.
// The dashboard raises others locally, sooner, because it sees every reading
// as it arrives rather than waiting for the controller's rate limit. Showing
// them in one undifferentiated list would make it impossible to tell what the
// hardware decided from what this browser noticed.

const META = {
  // raised by the controller
  watered: { icon: 'droplet', tone: 'ok' },
  soil_low: { icon: 'droplet', tone: 'warn' },
  temp_out_of_range: { icon: 'thermo', tone: 'warn' },
  sensor_no_response: { icon: 'alert', tone: 'warn' },
  failsafe_active: { icon: 'shield', tone: 'crit' },
  capture_failed: { icon: 'camera', tone: 'muted' },
  // raised by the dashboard
  pump: { icon: 'droplet', tone: 'ok' },
  temp: { icon: 'thermo', tone: 'crit' },
  hum: { icon: 'droplet', tone: 'warn' },
  soil: { icon: 'droplet', tone: 'warn' },
  conn: { icon: 'alert', tone: 'warn' },
  rest: { icon: 'check', tone: 'ok' },
  info: { icon: 'bell', tone: 'muted' },
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

export default function NotificationsPage({ node }) {
  const {
    notifications, deviceNotifications,
    markAllRead, clearNotifs, toggleRead, deleteNotif, clearDeviceNotifs,
  } = node;

  const [source, setSource] = useState('device');
  const list = source === 'device' ? deviceNotifications : notifications;

  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">Notifications</div>
        <h1>Alert log</h1>
        <p>
          The controller raises its own alerts and stores them in the database,
          so they survive a closed browser. This dashboard raises others
          locally, and sooner, because it sees every reading as it arrives.
          They are listed separately so it is clear which is which.
        </p>
      </div>

      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={source === 'device' ? 'active' : ''} onClick={() => setSource('device')}>
          From the controller · {deviceNotifications.length}
        </button>
        <button className={source === 'portal' ? 'active' : ''} onClick={() => setSource('portal')}>
          From this dashboard · {notifications.length}
        </button>
      </div>

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
        {list.length === 0 ? (
          <div className="notif-empty">
            {source === 'device'
              ? 'The controller has raised nothing. A quiet plant.'
              : 'Nothing raised in this browser session.'}
          </div>
        ) : (
          list.map((n) => {
            const meta = META[n.type] || META.info;
            const tone = source === 'device' ? severityTone(n.severity) : meta.tone;
            return (
              <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`}>
                <div className="notif-ico" style={{ background: TONE_BG[tone], color: TONE_FG[tone] }}>
                  <Icon name={meta.icon} size={16} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="notif-title" style={{ textTransform: source === 'device' ? 'capitalize' : 'none' }}>
                    {n.title}
                    {source === 'device' && n.value != null && n.value >= 0 && (
                      <span className="badge" style={{ marginLeft: 8, background: TONE_BG[tone], color: TONE_FG[tone] }}>
                        {n.value}
                      </span>
                    )}
                  </div>
                  <div className="notif-body">{n.body}</div>
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
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="card-title"><Icon name="shield" size={14} /> One alert cannot be switched off</div>
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
            The failsafe notification is always sent, whatever the settings say.
            It reports that the controller became unreachable and the sensor
            board watered the plant on its own, which is the single case where a
            missing alert is indistinguishable from nothing having happened.
          </p>
        </div>
      )}
    </section>
  );
}
