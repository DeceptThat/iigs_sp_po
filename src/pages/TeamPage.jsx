import { Icon } from '../icons.jsx';

// The page a reviewer reads to find out what was promised against what
// exists. Every claim here is one the system can be made to demonstrate, and
// where something was not built it says so plainly rather than describing it
// as partial. A status table that overstates is worse than no table: a
// reviewer who checks one row and finds it generous stops trusting the rest.

const TEAM = [
  { initials: 'MP', cls: '',  name: 'Myat Phone Pyae',      role: 'Student ID 6530204' },
  { initials: 'KM', cls: 'b', name: 'Khon Min Wai Than',    role: 'Student ID 6734667' },
  { initials: 'NE', cls: 'c', name: 'Nan Ei Shwe Sin Hlaing', role: 'Student ID 6530231' },
];

// implemented  demonstrated on the running system
// partial      built and working, with a stated limit
// descoped     not built, and why
const STATUS = [
  ['Monitor temperature, humidity and soil moisture', 'implemented',
   'DHT22 and a calibrated capacitive probe, read on every cycle.'],
  ['Record readings to the cloud', 'implemented',
   'Written only on a successful transaction, so the series is itself a record of uptime.'],
  ['Automatic watering by threshold', 'implemented',
   'Observed repeatedly: soil below the configured value, pump commanded, result logged.'],
  ['Minimum interval between waterings', 'implemented',
   'Blocks a second watering inside the window; observed blocking for six hours.'],
  ['Manual override from the portal', 'implemented',
   'Pump, full check, mount and grow light, each a one-shot command.'],
  ['Local fail-safe automation', 'implemented',
   'The sensor board waters on its own after losing contact with the controller. Fired in testing.'],
  ['Camera capture and mount rotation', 'implemented',
   'Sweeps of configurable span and frame count, filed to two separate stores.'],
  ['Configurable automation from the portal', 'implemented',
   'Thresholds, intervals, sweep geometry and notifications, all read by the controller.'],
  ['Notifications', 'implemented',
   'Six types, five of them switchable. The fail-safe alert cannot be switched off.'],
  ['360 degree camera coverage', 'partial',
   'The mount sweeps 180 degrees. Beyond that it would pass its own cable, which the present mechanism has no way to route.'],
  ['Thirty days of retention', 'partial',
   'Nothing deletes and the store is unbounded, so the capacity exists. What is missing is elapsed time.'],
  ['Long-term analytics', 'implemented',
   'Means, extremes, spread, continuity yield, drying rate and watering intervals over a selectable period.'],
  ['Lighting measurement', 'descoped',
   'The module bought for it carried no photoresistor. The relay that switches a grow light does work.'],
  ['Power resiliency: battery backup and hibernation', 'descoped',
   'Not built. It needs hardware the project did not have.'],
  ['Live video feed', 'descoped',
   'Stills on request instead. A continuous feed needs a standing allocation on the board holding the network connection, and a route in from outside the network.'],
];

export default function TeamPage() {
  return (
    <section className="page">
      <div className="page-head">
        <div className="kicker">Team &amp; build</div>
        <h1>About the project</h1>
        <p>
          An IoT-based indoor agriculture monitoring and automation system,
          submitted as Senior Project 1. The prototype monitors, records,
          waters and photographs a single indoor plant, and continues to water
          it when the controller becomes unreachable.
        </p>
      </div>

      <div className="team-grid">
        {TEAM.map((m) => (
          <div key={m.name} className="card member">
            <div className={`avatar ${m.cls}`}>{m.initials}</div>
            <div>
              <h3>{m.name}</h3>
              <p>{m.role}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="users" size={14} /> Faculty advisor</div>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
          <b style={{ color: 'var(--ink)' }}>Dobri Atanassov Batovski</b> — Vincent
          Mary School of Engineering, Science and Technology, Assumption
          University of Thailand.
        </p>
      </div>

      {/* ---------------------------------------------- architecture */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="shield" size={14} /> Four devices, not one</div>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 8 }}>
          The work was driven by a recurrent failure: the device holding the
          secure cloud connection would stop responding and need power cycling.
          Five architectural revisions followed, ending in a partition where
          the network-facing task shares a processor with nothing that
          allocates memory or blocks execution.
        </p>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 10 }}>
          The consequence is the fail-safe. The sensing board carries no
          network code at all, so it cannot exhibit that fault, and it waters
          the plant whether or not the controller is alive. That is a property
          of what is compiled onto each board rather than an observed
          behaviour.
        </p>
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Device</th><th>Responsibility</th><th>Network</th></tr></thead>
            <tbody>
              <tr><td className="td-main">Controller</td>
                  <td>Wireless, cloud, scheduling, relaying commands</td><td>Wi-Fi</td></tr>
              <tr><td className="td-main">Sensing board</td>
                  <td>Sensors, pump, grow light, autonomous fail-safe</td><td>none</td></tr>
              <tr><td className="td-main">Motor board</td>
                  <td>Stepper mount, persistent diagnostic counters</td><td>none</td></tr>
              <tr><td className="td-main">Camera</td>
                  <td>Capture and upload on request</td><td>Wi-Fi, independent</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------------------------------------- stacks */}
      <div className="grid-3" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <div className="card-title"><Icon name="zap" size={14} /> Hardware</div>
          <ul className="stack-list" style={{ marginTop: 8 }}>
            <li>3 × ESP32 development boards</li>
            <li>Seeed XIAO ESP32-S3 Sense (camera)</li>
            <li>DHT22 temperature and humidity</li>
            <li>Capacitive soil moisture probe</li>
            <li>Submersible pump on a relay</li>
            <li>Grow light on a second relay</li>
            <li>28BYJ-48 stepper with ULN2003</li>
            <li>LM2596 buck converter</li>
          </ul>
        </div>

        <div className="card card-pad">
          <div className="card-title"><Icon name="sliders" size={14} /> Software</div>
          <ul className="stack-list" style={{ marginTop: 8 }}>
            <li>Arduino firmware, four programs</li>
            <li>Firebase Realtime Database</li>
            <li>Firebase Storage for photographs</li>
            <li>React dashboard with Chart.js</li>
            <li>Wired serial between the boards</li>
          </ul>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
            The proposal specified MySQL, MQTT and Node.js. All three were
            replaced by Firebase, which provides storage, push synchronisation
            and authentication in one managed service. The reason is the
            unattended-deployment requirement: a self-hosted stack needs a
            server kept running and reachable, whereas both the firmware and
            the browser connect outward and neither needs inbound access at
            the deployment site.
          </p>
        </div>

        <div className="card card-pad">
          <div className="card-title"><Icon name="check" size={14} /> What it honestly is</div>
          <ul className="vp-list" style={{ marginTop: 6 }}>
            <li><b style={{ color: 'var(--ink)' }}>One plant.</b> Validated on a single assembled instance, not a fleet.</li>
            <li><b style={{ color: 'var(--ink)' }}>Keeps watering.</b> The sensing board acts alone when the controller is unreachable.</li>
            <li><b style={{ color: 'var(--ink)' }}>No inbound access.</b> Nothing at the deployment site needs a port opened.</li>
            <li><b style={{ color: 'var(--ink)' }}>A known fault, bounded.</b> A secure-handshake failure recurs and has not been diagnosed. The system recovers from it rather than avoiding it.</li>
          </ul>
        </div>
      </div>

      {/* ---------------------------------------------- status */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="chart" size={14} /> Proposal against the prototype</div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, marginBottom: 12 }}>
          Implemented means demonstrated on the running system. Partial means
          built and working with a stated limit. Descoped means not built, with
          the reason given.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Requirement</th><th>Status</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {STATUS.map(([cap, status, notes]) => (
                <tr key={cap}>
                  <td className="td-main">{cap}</td>
                  <td>
                    <span className={`status-cell s-${status}`}>
                      <span className="s" />
                      {status === 'implemented' ? 'Implemented'
                        : status === 'partial' ? 'Partial' : 'Descoped'}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-body)', color: 'var(--ink-soft)' }}>{notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------------------------------------- known limits */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="card-title"><Icon name="alert" size={14} /> Known limits</div>
        <ul className="vp-list" style={{ marginTop: 8 }}>
          <li>
            <b style={{ color: 'var(--ink)' }}>The handshake fault is bounded, not fixed.</b>{' '}
            Memory exhaustion, heap fragmentation and interference from the
            pump were each ruled out by measurement. The cause remains
            unestablished; a back-off and a scheduled restart keep the system
            running through it.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Mount position is counted, not measured.</b>{' '}
            There is no encoder or limit switch, so a lost step accumulates
            undetected until the mount is re-zeroed by hand. A positional servo
            would remove the problem entirely.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>The boards do not handshake.</b>{' '}
            The controller pulses a wake line and assumes; the sensing board
            listens for a fixed window. Several timing faults were traced to
            this during development.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>No delivery sensing.</b>{' '}
            A commanded watering is recorded as unverified, because nothing
            reports whether water reached the plant.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Calibrated against air, not dry soil.</b>{' '}
            Oven-dried soil was not available, so the dry reference is slightly
            conservative: the probe reports marginally drier than the soil is.
          </li>
        </ul>
      </div>
    </section>
  );
}