import { Icon } from '../icons.jsx';

const TEAM = [
  { initials: 'MC', cls: '', name: 'Maya Chen', role: 'Systems & firmware', tag: 'ESP32 · sensors' },
  { initials: 'JW', cls: 'b', name: 'Jonas Weber', role: 'Hardware & sensing', tag: 'circuits · enclosure' },
  { initials: 'PN', cls: 'c', name: 'Priya Nair', role: 'Research & testing', tag: 'plant care · data' },
  { initials: 'SO', cls: 'd', name: 'Sam Okada', role: 'Dashboard & UX', tag: 'this UI · tooling' },
];

const STATUS = [
  ['Live sensor dashboard', 'implemented', 'Firebase RTDB → this console'],
  ['Manual pump override', 'implemented', 'Writes sensors/control/run_pump'],
  ['Alert notifications', 'implemented', 'Threshold + heartbeat events'],
  ['History & insights', 'implemented', 'sensors/history log'],
  ['Camera snapshots', 'implemented', 'Capture request + gallery'],
  ['Servo pan', 'partial', 'Angle written to the board'],
  ['On-device watering rules', 'partial', 'Controller still owns fail-safe'],
  ['Multi-plant support', 'descoped', 'Out of scope for this build'],
  ['ML growth prediction', 'descoped', 'Not enough data yet'],
];

export default function TeamPage() {
  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">Team &amp; build</div>
        <h1>About the project</h1>
        <p>GrowNode / IIGS is a senior design prototype: one plant, one tent, honest scope. The pages in this portal match the console structure — live data still comes from the real board.</p>
      </div>

      <div className="team-grid">
        {TEAM.map((m) => (
          <div key={m.name} className="card member">
            <div className={`avatar ${m.cls}`}>{m.initials}</div>
            <div>
              <h3>{m.name}</h3>
              <p>{m.role}</p>
              <span className="tag">{m.tag}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="users" size={14} /> Faculty advisor</div>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
          <b style={{ color: 'var(--ink)' }}>Dr. A. Whitfield</b> — guidance on sensing accuracy, water-delivery design, and honest evaluation methodology.
        </p>
      </div>

      <div className="grid-3" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <div className="card-title"><Icon name="zap" size={14} /> Hardware stack</div>
          <ul className="stack-list" style={{ marginTop: 8 }}>
            <li>ESP32 development board</li>
            <li>Temp / humidity sensor</li>
            <li>Capacitive soil-moisture probe</li>
            <li>Water pump + relay</li>
            <li>Servo + camera module</li>
          </ul>
        </div>
        <div className="card card-pad">
          <div className="card-title"><Icon name="sliders" size={14} /> Software stack</div>
          <ul className="stack-list" style={{ marginTop: 8 }}>
            <li>Firmware on the controller</li>
            <li>Firebase Realtime Database</li>
            <li>This dashboard: React + Chart.js</li>
            <li>Alert thresholds in browser storage</li>
            <li>Automation still runs on-device</li>
          </ul>
        </div>
        <div className="card card-pad">
          <div className="card-title"><Icon name="check" size={14} /> What it honestly is</div>
          <ul className="vp-list" style={{ marginTop: 6 }}>
            <li><b style={{ color: 'var(--ink)' }}>One plant, one tent.</b> Validated on a single setup, not a fleet.</li>
            <li><b style={{ color: 'var(--ink)' }}>Cheap parts.</b> Off-the-shelf sensors and a hobby servo.</li>
            <li><b style={{ color: 'var(--ink)' }}>Works offline.</b> The controller keeps watering when the dashboard is closed.</li>
            <li><b style={{ color: 'var(--ink)' }}>Open and inspectable.</b> Every line of this UI is readable.</li>
          </ul>
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="chart" size={14} /> Proposal vs. current prototype</div>
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr><th>Capability</th><th>Status</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {STATUS.map(([cap, status, notes]) => (
                <tr key={cap}>
                  <td className="td-main">{cap}</td>
                  <td>
                    <span className={`status-cell s-${status}`}>
                      <span className="s" />
                      {status === 'implemented' ? 'Implemented' : status === 'partial' ? 'Partial' : 'Descoped'}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-body)', color: 'var(--ink-soft)' }}>{notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
