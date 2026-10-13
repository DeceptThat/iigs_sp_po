import { useEffect, useState } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';
import { PLANT_PROFILES, getProfile } from '../plantProfiles.js';

 
 
 
 
 

function Row({ name, value, desc, children }) {
  return (
    <div className="aut-row">
      <div className="aut-head">
        <div className="aut-name">{name}</div>
        <div className="aut-val mono">{value}</div>
      </div>
      {children}
      {desc && <div className="aut-desc">{desc}</div>}
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        width: 46, height: 26, borderRadius: 999, border: 'none', padding: 3,
        background: on ? 'var(--accent)' : 'var(--card-border-strong)',
        display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
        transition: 'background .15s',
      }}
    >
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#fff', display: 'block' }} />
    </button>
  );
}

export default function SettingsPage({ node }) {
  const {
    settings, setSettings, saveSettings, saveSweep, saveNotificationPrefs,
    resetSettings, configLoaded, controllerHealth,
  } = node;

  const [draft, setDraft] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');

   
   
  useEffect(() => { if (!dirty) setDraft(settings); }, [settings, dirty]);

  const edit = (patch) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };

  const byPreset = draft.plantMode === 'preset';
  const profile = byPreset ? getProfile(draft.plantType) : null;

   
   
   
  const applyProfile = (id) => {
    const pr = getProfile(id);
    if (!pr) return;
    edit({ plantType: id, moistureThreshold: pr.threshold, cooldownHours: pr.cooldownHours });
  };

   
   
   
  const setMode = (mode) => {
    if (mode === 'preset') {
      const pr = getProfile(draft.plantType) || PLANT_PROFILES[0];
      edit({ plantMode: 'preset', plantType: pr.id,
             moistureThreshold: pr.threshold, cooldownHours: pr.cooldownHours });
    } else {
      edit({ plantMode: 'manual', cooldownHours: Math.min(24, draft.cooldownHours) });
    }
  };

  const save = async () => {
    setSettings(draft);
    await saveSettings(draft);
    await saveSweep({
      routine_span_deg: Number(draft.routineSpanDeg),
      routine_frames: Number(draft.routineFrames),
      check_sweep_enabled: !!draft.checkSweepEnabled,
    });
    await saveNotificationPrefs({
      watered: !!draft.notifyWatered,
      sensor_no_response: !!draft.notifySensorFail,
      soil_low: !!draft.notifySoilLow,
      temp_out_of_range: !!draft.notifyTempRange,
      capture_failed: !!draft.notifyCaptureFail,
      interval_hours: Number(draft.notifyIntervalHours),
    });
    setDirty(false);
    setNote(`Saved at ${new Date().toLocaleTimeString()}. The controller applies these on its next cycle.`);
  };

  return (
    <section className="page">
      <BusyBanner busy={node.busy ?? { active: false }} />
      <div className="page-head">
        <div className="kicker">Settings</div>
        <h1>What the controller acts on</h1>
        <p>
          Every value on this page lives on the controller, not in this browser.
          The acquisition interval is read once at startup, so a change there
          takes effect after the next restart; the rest apply on the following
          cycle.
        </p>
      </div>

      {!configLoaded && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          Waiting for the controller&rsquo;s configuration. The values below are the
          compiled defaults until it arrives.
        </div>
      )}

      {dirty && (
        <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
          <b>Unsaved changes.</b> Nothing has been sent to the controller yet.
        </div>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>

        
        <div className="card card-pad">
          <div className="card-title"><Icon name="droplet" size={14} /> Watering</div>
          <div style={{ marginTop: 14 }}>
            <div className="aut-row">
              <div className="aut-head">
                <div className="aut-name">Automatic watering</div>
                <Toggle on={draft.autoWater} onChange={(v) => edit({ autoWater: v })} />
              </div>
              <div className="aut-desc">
                When off, moisture is still read and logged but the pump is never
                commanded. The failsafe on the sensor board is unaffected.
              </div>
            </div>

            <div className="aut-row">
              <div className="aut-head">
                <div className="aut-name">How the target is set</div>
              </div>
              <div className="seg" style={{ marginTop: 8 }}>
                <button className={!byPreset ? 'active' : ''} onClick={() => setMode('manual')}>
                  Manual
                </button>
                <button className={byPreset ? 'active' : ''} onClick={() => setMode('preset')}>
                  By plant type
                </button>
              </div>
              <div className="aut-desc">
                Manual is the original behaviour: you set the two numbers below
                yourself. By plant type fills them from a profile instead. Both
                write the same values to the controller, so switching modes
                changes who decides the numbers, never what the hardware does
                with them.
              </div>
            </div>

            {byPreset && (
              <div className="aut-row">
                <div className="aut-head">
                  <div className="aut-name">Plant type</div>
                  <div className="aut-val mono">{profile ? profile.label : '—'}</div>
                </div>
                <select
                  className="sel"
                  value={draft.plantType}
                  onChange={(e) => applyProfile(e.target.value)}
                  style={{ width: '100%', marginTop: 8 }}
                >
                  {PLANT_PROFILES.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.label} — {pr.threshold}%, {pr.cooldownHours} h
                    </option>
                  ))}
                </select>
                {profile && (
                  <div className="aut-desc">
                    {profile.note} The profile sets the two numbers below and nothing
                    else. It does not influence any measurement, and no drying rate is
                    inferred from it — the analysis page reports what the probe recorded,
                    whichever profile is selected here.
                  </div>
                )}
              </div>
            )}

            


            <Row
              name="Moisture threshold"
              value={`${draft.moistureThreshold}%`}
              desc={byPreset
                ? 'Set by the plant type above. Switch to Manual to override it.'
                : 'Water below this. The sensor board\u2019s failsafe uses its own lower, fixed value and ignores this one.'}
            >
              {!byPreset && (
                <input type="range" min="10" max="90" value={draft.moistureThreshold}
                  onChange={(e) => edit({ moistureThreshold: +e.target.value })} />
              )}
            </Row>

            <Row
              name="Pump run time"
              value={`${draft.waterDurationSec} s`}
              desc="How long the pump runs each time it is commanded."
            >
              <input type="range" min="1" max="30" value={draft.waterDurationSec}
                onChange={(e) => edit({ waterDurationSec: +e.target.value })} />
            </Row>

            <Row
              name="Minimum interval between waterings"
              value={`${draft.cooldownHours} h`}
              desc={byPreset
                ? 'Set by the plant type above. Profiles may exceed the manual slider\u2019s 24-hour range; switching back to Manual clamps it to 24.'
                : 'Blocks a second watering inside this window, so a slow-responding probe cannot cause repeated watering.'}
            >
              {!byPreset && (
                <input type="range" min="1" max="24" value={draft.cooldownHours}
                  onChange={(e) => edit({ cooldownHours: +e.target.value })} />
              )}
            </Row>

            <Row
              name="Failsafe silence timeout"
              value={`${draft.failsafeHours} h`}
              desc="How long the sensor board waits without hearing from the controller before watering on its own."
            >
              <input type="range" min="1" max="24" value={draft.failsafeHours}
                onChange={(e) => edit({ failsafeHours: +e.target.value })} />
            </Row>
          </div>

          {controllerHealth.failsafeActive && (
            <div className="aut-note">
              <Icon name="alert" size={17} />
              <span>
                <b>The failsafe has acted.</b> The sensor board watered on its own
                after losing contact with the controller.
              </span>
            </div>
          )}
        </div>

        
        <div className="card card-pad">
          <div className="card-title"><Icon name="chart" size={14} /> Recording</div>
          <div style={{ marginTop: 14 }}>
            <div className="aut-row">
              <div className="aut-head">
                <div className="aut-name">Record readings to history</div>
                <Toggle on={draft.dataCollection} onChange={(v) => edit({ dataCollection: v })} />
              </div>
              <div className="aut-desc">
                When off, checks still run and are still logged; only the
                environmental record is suspended.
              </div>
            </div>

            <div className="aut-row">
              <div className="aut-head">
                <div className="aut-name">Test mode</div>
                <Toggle on={draft.testMode} onChange={(v) => edit({ testMode: v })} />
              </div>
              <div className="aut-desc">
                Shortens the schedule so the system can be watched without
                waiting: a check every ten minutes and a sweep every thirty.
                Switch it off before leaving the system running, or the
                photograph store fills in about five hours.
              </div>
            </div>

            <Row
              name="History interval"
              value={`every ${draft.collectionIntervalMins} min`}
              desc="How often a reading is kept. The sensor is read on every check regardless; this decides which of those are recorded. Read once at startup, so a change needs a controller restart."
            >
              <input type="range" min="10" max="360" step="10" value={draft.collectionIntervalMins}
                onChange={(e) => edit({ collectionIntervalMins: +e.target.value })} />
            </Row>
          </div>

          <div className="card-title" style={{ marginTop: 22 }}>
            <Icon name="thermo" size={14} /> Temperature range
          </div>
          <div style={{ marginTop: 12 }}>
            <Row name="Minimum" value={`${draft.tempAlertLow} °C`}
                 desc="A notification is raised below this.">
              <input type="range" min="0" max="30" value={draft.tempAlertLow}
                onChange={(e) => edit({ tempAlertLow: +e.target.value })} />
            </Row>
            <Row name="Maximum" value={`${draft.tempAlertHigh} °C`}
                 desc="A notification is raised above this.">
              <input type="range" min="20" max="50" value={draft.tempAlertHigh}
                onChange={(e) => edit({ tempAlertHigh: +e.target.value })} />
            </Row>
          </div>
        </div>

        
        <div className="card card-pad">
          <div className="card-title"><Icon name="camera" size={14} /> Photographic sweeps</div>
          <div style={{ marginTop: 14 }}>
            <div className="aut-row">
              <div className="aut-head">
                <div className="aut-name">Sweep after a manual check</div>
                <Toggle on={draft.checkSweepEnabled} onChange={(v) => edit({ checkSweepEnabled: v })} />
              </div>
              <div className="aut-desc">
                A sweep takes about a minute and blocks other commands while it
                runs. Off is usually what you want while testing.
              </div>
            </div>

            <Row name="How often a sweep runs"
                 value={draft.testMode ? 'every 30 min (test)' : `every ${draft.surveyIntervalH} h`}
                 desc="Scheduled photographic sweeps. Test mode overrides this with a fixed thirty minutes.">
              <select className="sel" value={draft.surveyIntervalH}
                      disabled={draft.testMode}
                      onChange={(e) => edit({ surveyIntervalH: +e.target.value })}>
                <option value={1}>every hour</option>
                <option value={3}>every 3 hours</option>
                <option value={6}>every 6 hours</option>
                <option value={12}>every 12 hours</option>
                <option value={24}>once a day</option>
              </select>
            </Row>
            <Row name="Routine sweep span" value={`${draft.routineSpanDeg}°`}
                 desc="Total arc for the scheduled sweep, centred on the resting position.">
              <select className="sel" value={draft.routineSpanDeg}
                      onChange={(e) => edit({ routineSpanDeg: +e.target.value })}>
                <option value={0}>0&deg; &mdash; no movement</option>
                <option value={90}>90&deg;</option>
                <option value={180}>180&deg;</option>
                <option value={360}>360&deg;</option>
              </select>
            </Row>
            <Row name="Routine sweep frames"
                 value={draft.routineFrames === 1 ? 'single frame' : `${draft.routineFrames} frames`}
                 desc={draft.routineFrames === 1
                   ? 'One frame at the resting position. The mount never moves for a routine capture, which keeps a mechanical failure out of the long-term record.'
                   : 'Spaced evenly across the span.'}>
              <select className="sel" value={draft.routineFrames}
                      onChange={(e) => edit({ routineFrames: +e.target.value })}>
                <option value={1}>1 frame &mdash; at rest, no movement</option>
                <option value={3}>3 frames</option>
                <option value={5}>5 frames</option>
              </select>
            </Row>
          </div>
          <div className="aut-note">
            <Icon name="shield" size={17} />
            <span>
              A full rotation is offered because the firmware supports it, but the camera is tethered and the mount would wind its own cable. Nothing selects it until a slip ring is fitted.
            </span>
          </div>
        </div>

        
        <div className="card card-pad">
          <div className="card-title"><Icon name="bell" size={14} /> Notifications</div>
          <div style={{ marginTop: 14 }}>
            {[
              ['notifyWatered', 'Watering'],
              ['notifySensorFail', 'Sensor board did not reply'],
              ['notifySoilLow', 'Soil below threshold'],
              ['notifyTempRange', 'Temperature out of range'],
              ['notifyCaptureFail', 'Photograph failed'],
            ].map(([key, label]) => (
              <div className="aut-row" key={key}>
                <div className="aut-head">
                  <div className="aut-name">{label}</div>
                  <Toggle on={draft[key]} onChange={(v) => edit({ [key]: v })} />
                </div>
              </div>
            ))}
            <Row
              name="Minimum interval between repeats"
              value={`${draft.notifyIntervalHours} h`}
              desc="Applies to conditions that persist, such as dry soil, so one dry pot does not generate a notification on every cycle."
            >
              <input type="range" min="1" max="24" value={draft.notifyIntervalHours}
                onChange={(e) => edit({ notifyIntervalHours: +e.target.value })} />
            </Row>
          </div>
          <div className="aut-note">
            <Icon name="alert" size={17} />
            <span>
              <b>The failsafe notification cannot be switched off.</b> It reports
              that the controller became unreachable and the sensor board is
              running the plant alone, which is the one case where silence looks
              exactly like normal operation.
            </span>
          </div>
        </div>
      </div>

      {/* THE MOUNT PANEL HAS MOVED TO THE CAMERA PAGE.
          Aiming the camera while unable to see what it is pointing at was the
          wrong arrangement; the controls now sit beside the frame they affect,
          with the tracked angle, Home, Set zero and Stop alongside them. */}

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="aut-actions">
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>
            <Icon name="save" size={16} /> Save to controller
          </button>
          <button className="btn btn-ghost" onClick={() => { setDraft(settings); setDirty(false); setNote("Reverted to the values currently on the controller."); }}>
            <Icon name="undo" size={16} /> Discard changes
          </button>
          <button className="btn btn-ghost" onClick={() => { resetSettings(); setDirty(true); setNote('Defaults loaded. Press save to apply them.'); }}>
            Restore defaults
          </button>
        </div>
        {note && <div className="aut-sub">{note}</div>}
      </div>
    </section>
  );
}