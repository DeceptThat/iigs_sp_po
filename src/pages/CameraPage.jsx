// ===========================================================================
//  CameraPage.jsx — KMN / IIGS portal
//  Mount control, photographic settings, capture and the frame archive.
//
//  TWO LINES TO CHECK BEFORE THIS COMPILES
//  ---------------------------------------
//  1. '../firebase' must point at your firebase.js.
//  2. It must export the Realtime Database as `db`. Storage is optional —
//     if your firebase.js also exports `storage`, pruning deletes the JPEG
//     as well as the record. Without it, pruning removes the record only and
//     says so rather than pretending the file is gone.
//
//  The mount panel lives HERE, not on the settings page. Pointing the camera
//  is something you do while looking at what it sees.
//
//  READS   /sensors/camera/{latestImageUrl,lastImageTimestamp,lastImageTarget,
//                           last_seen,boot_count,uptime_s,free_psram}
//          /sensors/camera/routine/*      flat, keyed by timestamp
//          /sensors/camera/check/*        flat, keyed by timestamp
//          /sensors/system/{motor_angle_deg,activity,activity_detail}
//          /sensors/config/sweep/*, /sensors/config/camera/*
//  WRITES  /sensors/control/{nudge_deg,run_home,run_zero,run_stop,
//                            run_sweep,run_manual_sweep,capture_requested}
//          /sensors/config/sweep/*, /sensors/config/camera/idle_home_minutes
//  DELETES /sensors/camera/<store>/<ts>   when pruning past the cap
// ===========================================================================

import { useEffect, useRef, useState } from 'react';
import { ref, onValue, update, set, remove } from 'firebase/database';
import { getStorage, ref as sref, deleteObject } from 'firebase/storage';
import * as fb from '../firebase';              // <-- 1. check this path

// A namespace import, not a named one: if firebase.js has no `storage` export,
// a named import would fail the build, while this just reads undefined. The
// fallback asks the default app, which must exist because `db` came from it.
const db = fb.db;
let storage = null;
try { storage = fb.storage ?? getStorage(); } catch { storage = null; }

// Mirrors the firmware. Change these there and here together, or the portal
// offers values the board then clamps.
const FRAMES_MIN = 1;          // 1 = a single frame at home, no motor movement
const FRAMES_MAX = 9;
const SPANS = [0, 90, 180, 360];
const SURVEY_MIN_H = 1, SURVEY_MAX_H = 24;
const IDLE_HOME_MAX = 240;

const RETAIN_MAX = 360;        // frames kept per store
const NUDGES = [15, 45, 90];

export default function CameraPage() {
  const [cam, setCam]       = useState(null);
  const [sys, setSys]       = useState(null);
  const [cfg, setCfg]       = useState({});
  const [routine, setRoutine] = useState([]);
  const [check, setCheck]   = useState([]);
  const [now, setNow]       = useState(() => Math.floor(Date.now() / 1000));
  const [toast, setToast]   = useState(null);
  const [busy, setBusy]     = useState(null);
  const [store, setStore]   = useState('routine');
  const [shown, setShown]   = useState(24);

  useEffect(() => {
    const offs = [
      onValue(ref(db, '/sensors/camera'), s => {
        const v = s.val() || {};
        setCam(v);
        setRoutine(frameList(v.routine));
        setCheck(frameList(v.check));
      }),
      onValue(ref(db, '/sensors/system'), s => setSys(s.val() || {})),
      onValue(ref(db, '/sensors/config'), s => setCfg(s.val() || {})),
    ];
    return () => offs.forEach(f => f());
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const camAge   = cam?.last_seen ? Math.max(0, now - cam.last_seen) : null;
  const imgAge   = cam?.lastImageTimestamp ? Math.max(0, now - cam.lastImageTimestamp) : null;
  const online   = camAge != null && camAge < 180;
  const angle    = numOr(sys?.motor_angle_deg, 0);
  const activity = sys?.activity || 'idle';
  const idle     = activity === 'idle';

  const sweep = cfg.sweep || {};
  const routineFrames = numOr(sweep.routine_frames, 5);
  const routineSpan   = numOr(sweep.routine_span_deg, 180);
  // Manual-sweep geometry. Stored in config so the page remembers it, but the
  // firmware does NOT read manual geometry from config — it reads it from the
  // control node at the moment the command is picked up. Both happen below.
  const manFrames     = numOr(sweep.manual_frames, 3);
  const manSpan       = numOr(sweep.manual_span_deg, 90);
  const surveyHours   = numOr(cfg.survey_interval_hours, 6);
  const idleHome      = numOr(cfg.camera?.idle_home_minutes, 20);

  const frames = store === 'routine' ? routine : check;
  const over   = Math.max(0, frames.length - RETAIN_MAX);

  // ---- actions ----------------------------------------------------------
  const cmd = async (path, value, label) => {
    setBusy(label); setToast(null);
    try { await set(ref(db, path), value); setToast({ k: 'ok', t: `${label} sent.` }); }
    catch (e) { setToast({ k: 'err', t: `${label} failed: ${e.message}` }); }
    finally { setBusy(null); }
  };

  // SEND WHAT IS ON SCREEN, TO EVERY KEY A BOARD MIGHT READ.
  //
  // Three separate things went wrong here, so this fixes all three at once.
  //
  // 1. Reading the numbers from the subscribed config meant the button used
  //    whatever had last round-tripped from Firebase. Type 9, click straight
  //    away, and the old value was still in state. The refs below read the
  //    inputs themselves, so what is displayed is what is sent.
  //
  // 2. Different firmware revisions take the manual geometry from different
  //    places: the current one from /sensors/control, an earlier one from the
  //    check-sweep keys in /sensors/config. Writing both costs one extra
  //    update and is harmless either way, because the check sweep is disabled.
  //
  // 3. Config is written FIRST and the run flag LAST. The board polls control
  //    every few seconds and calls fetchConfig() when it picks the command up,
  //    so the geometry is already in place by the time the flag is seen.
  const framesRef = useRef(null);
  const spanRef   = useRef(null);

  const runManualSweep = async () => {
    const f = clamp(Math.round(+(framesRef.current?.value ?? manFrames)),
                    FRAMES_MIN, FRAMES_MAX);
    const s = +(spanRef.current?.value ?? manSpan);

    setBusy('Sweep'); setToast(null);
    try {
      await update(ref(db, '/sensors/config/sweep'), {
        manual_frames:   f, manual_span_deg: s,
        check_frames:    f, check_span_deg:  s,   // older firmware reads these
      });
      await update(ref(db, '/sensors/control'), {
        manual_sweep_frames:   f,
        manual_sweep_span_deg: s,
        run_manual_sweep:      true,
      });
      setToast({
        k: 'ok',
        t: f === 1
          ? 'Sweep sent: one frame at the resting angle, no movement.'
          : (s === 0
              ? `Sweep sent: ${f} frames. A span of 0 is ignored by the firmware, `
                + 'so it will use its last span instead — pick 90, 180 or 360.'
              : `Sweep sent: ${f} frames over ${s}°. Watch the serial for `
                + `"[MANUAL] sweep at ${s} degrees in ${f} frames".`),
      });
    } catch (e) {
      setToast({ k: 'err', t: `Sweep failed: ${e.message}` });
    } finally { setBusy(null); }
  };

  const saveCfg = async (path, value, label) => {
    try { await update(ref(db, path), value);
      setToast({ k: 'ok', t: `${label} saved. The board applies it at its next check.` });
    } catch (e) { setToast({ k: 'err', t: `Could not save: ${e.message}` }); }
  };

  async function prune() {
    const doomed = frames.slice(RETAIN_MAX);       // oldest first beyond the cap
    if (!doomed.length) return;
    setBusy('prune');
    let recs = 0, files = 0, orphans = 0, failed = 0;
    for (const f of doomed) {
      try {
        // The JPEG goes first. If the record went first and this failed, the
        // file would be left with nothing pointing at it and no way to find it.
        if (storage && f.storage_path) {
          try { await deleteObject(sref(storage, f.storage_path)); files++; }
          catch { orphans++; }     // already gone, or Storage rules forbid it
        }
        await remove(ref(db, `/sensors/camera/${store}/${f.key}`));
        recs++;
      } catch { failed++; }
    }
    setBusy(null);
    setToast({
      k: failed || orphans ? 'warn' : 'ok',
      t: `Removed ${recs} record${recs === 1 ? '' : 's'} and ${files} file${files === 1 ? '' : 's'}.`
        + (orphans ? ` ${orphans} JPEG${orphans === 1 ? '' : 's'} could not be deleted and remain in Storage — check the Storage rules.` : '')
        + (failed ? ` ${failed} record${failed === 1 ? '' : 's'} failed.` : '')
    });
  }

  // ---- render -----------------------------------------------------------
  return (
    <div className="cam">
      <style>{CSS}</style>

      <header className="cam-head">
        <div>
          <p className="cam-eyebrow">Camera</p>
          <h1>Mount and capture</h1>
        </div>
        <div className={`cam-pill cam-pill--${online ? 'on' : 'off'}`}>
          <span className="cam-dot" />
          {camAge == null ? 'never seen' : online ? 'online' : `last seen ${fmtAge(camAge)} ago`}
        </div>
      </header>

      <section className="cam-card cam-strip">
        <Fact label="last image" value={imgAge == null ? '—' : fmtAge(imgAge) + ' ago'}
              sub={cam?.lastImageTarget ? `${cam.lastImageTarget} store` : null} />
        <Fact label="mount angle" value={`${angle > 0 ? '+' : ''}${angle}°`}
              sub={angle === 0 ? 'at home' : `${idleHome} min to auto-home`} />
        <Fact label="controller" value={activity} sub={sys?.activity_detail || null} />
        <Fact label="camera boots" value={cam?.boot_count ?? '—'} sub="30 min scheduled restart" />
      </section>

      {/* ------------- latest frame ------------- */}
      <section className="cam-card">
        <h2>Latest frame</h2>
        {cam?.latestImageUrl ? (
          <a className="cam-latest" href={cam.latestImageUrl} target="_blank" rel="noreferrer">
            <img src={cam.latestImageUrl} alt="Most recent capture" loading="lazy" />
          </a>
        ) : (
          <p className="cam-empty">No capture yet. Press Capture now once the camera is online.</p>
        )}
        <div className="cam-row">
          <button className="cam-btn" disabled={busy === 'Capture' || !idle}
            onClick={() => cmd('/sensors/control/capture_requested', true, 'Capture')}>
            Capture now
          </button>
          <span className="cam-hint">
            {idle ? 'One frame at the current angle.' : `Controller is busy: ${activity}.`}
          </span>
        </div>
      </section>

      {/* ------------- mount ------------- */}
      <section className="cam-card">
        <h2>Mount</h2>
        <p className="cam-lede">
          Moves are relative. The angle shown is the controller's own tracking, published
          with its heartbeat — it updates within thirty seconds of a move, not instantly.
        </p>

        <div className="cam-dial">
          <Dial angle={angle} />
          <div className="cam-dialside">
            <div className="cam-angle">{angle > 0 ? '+' : ''}{angle}<span>°</span></div>
            <p className="cam-anglelabel">{angle === 0 ? 'home' : 'from home'}</p>
          </div>
        </div>

        <div className="cam-nudges">
          {[...NUDGES].reverse().map(n => (
            <button key={'l' + n} className="cam-btn cam-btn--ghost" disabled={!idle || busy}
              onClick={() => cmd('/sensors/control/nudge_deg', -n, `Nudge -${n}°`)}>
              ◀ {n}°
            </button>
          ))}
          {NUDGES.map(n => (
            <button key={'r' + n} className="cam-btn cam-btn--ghost" disabled={!idle || busy}
              onClick={() => cmd('/sensors/control/nudge_deg', n, `Nudge +${n}°`)}>
              {n}° ▶
            </button>
          ))}
        </div>

        <div className="cam-row">
          <button className="cam-btn" disabled={!idle || busy}
            onClick={() => cmd('/sensors/control/run_home', true, 'Home')}>Home</button>
          <button className="cam-btn cam-btn--ghost" disabled={!idle || busy}
            onClick={() => cmd('/sensors/control/run_zero', true, 'Set zero')}>Set zero here</button>
          <button className="cam-btn cam-btn--stop" disabled={busy === 'Stop'}
            onClick={() => cmd('/sensors/control/run_stop', true, 'Stop')}>Stop</button>
        </div>
        <p className="cam-note">
          <strong>Set zero here</strong> declares the current position to be the reference
          without moving anything — use it after freeing a jam, when the mount is physically
          at home but the tracked angle says otherwise. <strong>Stop</strong> is the only
          control that pre-empts whatever else is running.
        </p>

        <Field label="Return to home after" hint="0 disables it" suffix="minutes of inactivity">
          <input type="number" min="0" max={IDLE_HOME_MAX} defaultValue={idleHome}
            key={'ih' + idleHome}
            onBlur={e => {
              const v = clamp(Math.round(+e.target.value), 0, IDLE_HOME_MAX);
              e.target.value = v;
              if (v !== idleHome) saveCfg('/sensors/config/camera', { idle_home_minutes: v }, 'Idle return');
            }} />
        </Field>
      </section>

      {/* ------------- photographic settings ------------- */}
      <section className="cam-card">
        <h2>Photographic settings</h2>
        <p className="cam-lede">
          The routine survey runs unattended. A frame count of <strong>1</strong> captures a
          single frame at home and never moves the mount, which keeps a mechanical failure
          out of the long-term record. A span of <strong>0°</strong> holds every frame at
          home — useful for a burst from one viewpoint.
        </p>

        <h3 className="cam-sub">Routine survey</h3>
        <div className="cam-grid">
          <Field label="Frames" hint={`${FRAMES_MIN}–${FRAMES_MAX}`}>
            <input type="number" min={FRAMES_MIN} max={FRAMES_MAX} defaultValue={routineFrames}
              key={'rf' + routineFrames}
              onBlur={e => {
                const v = clamp(Math.round(+e.target.value), FRAMES_MIN, FRAMES_MAX);
                e.target.value = v;
                if (v !== routineFrames) saveCfg('/sensors/config/sweep', { routine_frames: v }, 'Routine frames');
              }} />
          </Field>
          <Field label="Span" hint="degrees swept">
            <select defaultValue={routineSpan} key={'rs' + routineSpan}
              onChange={e => saveCfg('/sensors/config/sweep', { routine_span_deg: +e.target.value }, 'Routine span')}>
              {SPANS.map(s => <option key={s} value={s}>{s === 0 ? '0° — no movement' : s + '°'}</option>)}
            </select>
          </Field>
          <Field label="Every" suffix="hours" hint={`${SURVEY_MIN_H}–${SURVEY_MAX_H}`}>
            <input type="number" min={SURVEY_MIN_H} max={SURVEY_MAX_H} defaultValue={surveyHours}
              key={'sh' + surveyHours}
              onBlur={e => {
                const v = clamp(Math.round(+e.target.value), SURVEY_MIN_H, SURVEY_MAX_H);
                e.target.value = v;
                if (v !== surveyHours) saveCfg('/sensors/config', { survey_interval_hours: v }, 'Survey interval');
              }} />
          </Field>
        </div>
        {routineFrames === 1 && (
          <p className="cam-note cam-note--good">
            Single frame at home — the motor stays out of the routine path entirely.
          </p>
        )}

        <h3 className="cam-sub">Manual sweep</h3>
        <div className="cam-grid">
          <Field label="Frames" hint={`${FRAMES_MIN}–${FRAMES_MAX}`}>
            <input ref={framesRef}
              type="number" min={FRAMES_MIN} max={FRAMES_MAX} defaultValue={manFrames}
              key={'mf' + manFrames}
              onBlur={e => {
                const v = clamp(Math.round(+e.target.value), FRAMES_MIN, FRAMES_MAX);
                e.target.value = v;
                if (v !== manFrames) saveCfg('/sensors/config/sweep', { manual_frames: v }, 'Sweep frames');
              }} />
          </Field>
          <Field label="Span" hint="degrees swept">
            <select ref={spanRef} defaultValue={manSpan} key={'ms' + manSpan}
              onChange={e => saveCfg('/sensors/config/sweep', { manual_span_deg: +e.target.value }, 'Sweep span')}>
              {SPANS.map(s => <option key={s} value={s}>{s === 0 ? '0° — no movement' : s + '°'}</option>)}
            </select>
          </Field>
          <div className="cam-fieldbtn">
            <button className="cam-btn" disabled={!idle || busy}
              onClick={() => runManualSweep()}>
              Run sweep now
            </button>
          </div>
        </div>
      </section>

      {/* ------------- archive ------------- */}
      <section className="cam-card">
        <h2>Archive</h2>
        <div className="cam-tabs">
          {['routine', 'check'].map(k => (
            <button key={k} className={`cam-tab ${store === k ? 'on' : ''}`}
              onClick={() => { setStore(k); setShown(24); }}>
              {k === 'routine' ? 'Routine' : 'Manual'}
              <span>{(k === 'routine' ? routine : check).length}</span>
            </button>
          ))}
          <span className={`cam-cap ${over ? 'cam-cap--over' : ''}`}>
            {frames.length} of {RETAIN_MAX}
          </span>
          {over > 0 && (
            <button className="cam-btn cam-btn--small" disabled={busy === 'prune'} onClick={prune}>
              {busy === 'prune' ? 'Pruning…' : `Delete the oldest ${over}`}
            </button>
          )}
        </div>

        {frames.length === 0 ? (
          <p className="cam-empty">
            No frames in this store yet. Routine frames begin accumulating here once the
            camera is flashed with the target-aware storage path.
          </p>
        ) : (
          <>
            <div className="cam-gal">
              {frames.slice(0, shown).map(f => (
                <a key={f.key} className="cam-thumb" href={f.url} target="_blank" rel="noreferrer">
                  <img src={f.url} alt={`Frame from ${fmtWhen(f.timestamp)}`} loading="lazy" />
                  <span>{fmtWhen(f.timestamp)}</span>
                </a>
              ))}
            </div>
            {shown < frames.length && (
              <button className="cam-more" onClick={() => setShown(s => s + 48)}>
                Show more — {frames.length - shown} older
              </button>
            )}
          </>
        )}
        <p className="cam-note">
          Newest first. The cap is a count, not an age: at one routine frame every{' '}
          {surveyHours} h, {RETAIN_MAX} frames is about{' '}
          {Math.round(RETAIN_MAX * surveyHours / 24)} days of record.
        </p>
      </section>

      {toast && (
        <div className={`cam-toast cam-toast--${toast.k}`} role="status">
          {toast.t}
          <button className="cam-toast-x" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
function Fact({ label, value, sub }) {
  return (
    <div className="cam-fact">
      <dt>{label}</dt>
      <dd>{value}{sub && <small>{sub}</small>}</dd>
    </div>
  );
}

function Field({ label, hint, suffix, children }) {
  return (
    <label className="cam-field">
      <span className="cam-flabel">{label}{hint && <i>{hint}</i>}</span>
      <span className="cam-finput">{children}{suffix && <em>{suffix}</em>}</span>
    </label>
  );
}

// A dial, not a slider: the mount's angle is a bearing, and a bearing reads as
// a bearing. The arc shows the span the routine survey would sweep from here.
function Dial({ angle }) {
  const R = 46, C = 58;
  const a = ((angle - 90) * Math.PI) / 180;
  const x = C + R * Math.cos(a), y = C + R * Math.sin(a);
  return (
    <svg className="cam-dialsvg" viewBox="0 0 116 116" role="img"
         aria-label={`Mount at ${angle} degrees from home`}>
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--cam-rule)" strokeWidth="2" />
      {[-90, -45, 0, 45, 90].map(t => {
        const r = ((t - 90) * Math.PI) / 180;
        const i = t === 0 ? R - 9 : R - 5;
        return <line key={t} x1={C + i * Math.cos(r)} y1={C + i * Math.sin(r)}
                     x2={C + R * Math.cos(r)} y2={C + R * Math.sin(r)}
                     stroke={t === 0 ? 'var(--cam-accent)' : 'var(--cam-rule)'}
                     strokeWidth={t === 0 ? 2.5 : 1.5} />;
      })}
      <line x1={C} y1={C} x2={x} y2={y} stroke="var(--cam-accent)" strokeWidth="3"
            strokeLinecap="round" />
      <circle cx={C} cy={C} r="4" fill="var(--cam-accent)" />
      <text x={C} y={C + R + 13} textAnchor="middle" className="cam-dialtick">home</text>
    </svg>
  );
}

// ===========================================================================
function numOr(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
// Newest first. Keys are epoch seconds written by the camera, so they sort
// numerically — string order would put "999" after "1000000".
function frameList(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node)
    .filter(([k, v]) => v && typeof v === 'object' && v.url)
    .map(([k, v]) => ({ key: k, url: v.url, storage_path: v.storage_path,
                        timestamp: numOr(v.timestamp, +k || 0) }))
    .sort((a, b) => b.timestamp - a.timestamp);
}
function fmtAge(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} `
       + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ===========================================================================
const CSS = `
.cam{
  --cam-bg:#f4f6f7; --cam-surface:#fff; --cam-sunk:#eef2f3; --cam-fg:#1b2227;
  --cam-muted:#67727a; --cam-rule:#d4dcdf; --cam-accent:#1f5673;
  --cam-ok:#215f3f; --cam-ok-bg:#e0f0e7; --cam-warn:#8a5a00; --cam-warn-bg:#f7eedb;
  --cam-err:#9c3a2a; --cam-err-bg:#f9e5e0; --cam-stop:#9c3a2a;
  color:var(--cam-fg); font-size:15px; line-height:1.55;
  max-width:900px; margin:0 auto; padding-inline:16px; padding-block:24px 56px;
}
@media (prefers-color-scheme:dark){ .cam{
  --cam-bg:#14181b; --cam-surface:#1c2227; --cam-sunk:#161b1f; --cam-fg:#e4e4e1;
  --cam-muted:#95a0a7; --cam-rule:#2d353b; --cam-accent:#74b4cf;
  --cam-ok:#6cbf8a; --cam-ok-bg:#18291f; --cam-warn:#dcab52; --cam-warn-bg:#2c2518;
  --cam-err:#e38672; --cam-err-bg:#32201c; --cam-stop:#e38672;
}}
.cam *{box-sizing:border-box}
.cam-head{display:flex;justify-content:space-between;align-items:flex-start;
  gap:12px;flex-wrap:wrap;margin-bottom:18px}
.cam-eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--cam-muted);margin:0 0 4px;font-weight:600}
.cam h1{font-size:28px;line-height:1.1;margin:0;letter-spacing:-.02em}
.cam h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
.cam-sub{font-size:12px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--cam-muted);margin:20px 0 10px;font-weight:600}
.cam-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;
  padding:5px 11px;border-radius:999px;border:1px solid var(--cam-rule);
  background:var(--cam-surface)}
.cam-dot{width:7px;height:7px;border-radius:50%}
.cam-pill--on .cam-dot{background:var(--cam-ok)}
.cam-pill--off .cam-dot{background:var(--cam-warn)}
.cam-pill--off{color:var(--cam-warn)}

.cam-card{background:var(--cam-surface);border:1px solid var(--cam-rule);
  border-radius:8px;padding:18px;margin-bottom:16px}
.cam-lede{color:var(--cam-muted);font-size:14px;margin:0 0 14px;max-width:64ch}
.cam-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px}
.cam-fact dt{font-size:10px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--cam-muted);margin-bottom:3px}
.cam-fact dd{margin:0;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;
  line-height:1.2}
.cam-fact dd small{display:block;font-size:11.5px;font-weight:400;
  color:var(--cam-muted);margin-top:2px}

.cam-latest{display:block;border-radius:6px;overflow:hidden;background:var(--cam-sunk);
  border:1px solid var(--cam-rule);margin-bottom:12px}
.cam-latest img{display:block;width:100%;height:auto}

.cam-dial{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-bottom:16px}
.cam-dialsvg{width:116px;height:116px;flex:0 0 auto;overflow:visible}
.cam-dialtick{font-size:9px;fill:var(--cam-muted)}
.cam-angle{font-size:40px;font-weight:700;letter-spacing:-.03em;line-height:1;
  font-variant-numeric:tabular-nums}
.cam-angle span{font-size:20px;color:var(--cam-muted)}
.cam-anglelabel{font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--cam-muted);margin:5px 0 0}

.cam-nudges{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:12px}
@media (max-width:520px){.cam-nudges{grid-template-columns:repeat(3,1fr)}}
.cam-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cam-hint{font-size:13px;color:var(--cam-muted)}

.cam-btn{font:inherit;font-size:14px;font-weight:600;padding:8px 14px;border-radius:6px;
  border:1px solid var(--cam-accent);background:var(--cam-accent);color:#fff;cursor:pointer}
.cam-btn:hover:not(:disabled){filter:brightness(1.08)}
.cam-btn:disabled{opacity:.4;cursor:not-allowed}
.cam-btn:focus-visible{outline:2px solid var(--cam-accent);outline-offset:2px}
.cam-btn--ghost{background:transparent;color:var(--cam-accent)}
.cam-btn--stop{background:transparent;color:var(--cam-stop);border-color:var(--cam-stop)}
.cam-btn--small{font-size:12.5px;padding:5px 10px}

.cam-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.cam-field{display:block}
.cam-flabel{display:flex;justify-content:space-between;align-items:baseline;gap:8px;
  font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cam-muted);
  margin-bottom:4px}
.cam-flabel i{font-style:normal;text-transform:none;letter-spacing:0;font-size:11px}
.cam-finput{display:flex;align-items:center;gap:8px}
.cam-finput em{font-style:normal;font-size:13px;color:var(--cam-muted)}
.cam-fieldbtn{display:flex;align-items:flex-end}
.cam input[type=number],.cam select{font:inherit;font-size:14px;padding:7px 9px;
  border:1px solid var(--cam-rule);border-radius:6px;background:var(--cam-bg);
  color:var(--cam-fg);width:100%;min-width:0}
.cam input:focus-visible,.cam select:focus-visible{outline:2px solid var(--cam-accent);
  outline-offset:1px}

.cam-tabs{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.cam-tab{font:inherit;font-size:13.5px;font-weight:600;padding:6px 12px;border-radius:999px;
  border:1px solid var(--cam-rule);background:transparent;color:var(--cam-muted);cursor:pointer}
.cam-tab.on{background:var(--cam-accent);border-color:var(--cam-accent);color:#fff}
.cam-tab span{margin-left:6px;font-weight:400;opacity:.8;font-variant-numeric:tabular-nums}
.cam-cap{font-size:12.5px;color:var(--cam-muted);font-variant-numeric:tabular-nums;
  margin-left:auto}
.cam-cap--over{color:var(--cam-warn);font-weight:600}

.cam-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}
.cam-thumb{display:block;border:1px solid var(--cam-rule);border-radius:6px;
  overflow:hidden;background:var(--cam-sunk);text-decoration:none}
.cam-thumb img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}
.cam-thumb span{display:block;font-size:11px;color:var(--cam-muted);padding:4px 6px;
  font-variant-numeric:tabular-nums}
.cam-more{font:inherit;font-size:13px;font-weight:600;color:var(--cam-accent);
  background:none;border:0;padding:12px 0 0;cursor:pointer;text-decoration:underline}

.cam-note{font-size:13px;color:var(--cam-muted);margin:12px 0 0;max-width:64ch}
.cam-note--good{color:var(--cam-ok);background:var(--cam-ok-bg);padding:8px 11px;
  border-radius:6px;border-left:3px solid var(--cam-ok)}
.cam-empty{font-size:14px;color:var(--cam-muted);margin:0 0 12px;background:var(--cam-bg);
  border:1px dashed var(--cam-rule);border-radius:6px;padding:16px;max-width:64ch}

.cam-toast{position:sticky;bottom:12px;display:flex;gap:10px;align-items:flex-start;
  font-size:14px;padding:11px 13px;border-radius:7px;margin-top:8px}
.cam-toast--ok{background:var(--cam-ok-bg);color:var(--cam-ok)}
.cam-toast--warn{background:var(--cam-warn-bg);color:var(--cam-warn)}
.cam-toast--err{background:var(--cam-err-bg);color:var(--cam-err)}
.cam-toast-x{margin-left:auto;background:none;border:0;color:inherit;font-size:19px;
  line-height:1;cursor:pointer;padding:0 2px}
@media (prefers-reduced-motion:reduce){.cam *{transition:none!important}}
`;
