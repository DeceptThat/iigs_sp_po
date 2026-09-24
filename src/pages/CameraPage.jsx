import { useState } from 'react';
import { Icon } from '../icons.jsx';
import BusyBanner from '../BusyBanner.jsx';

// Photographs are kept in two stores, and the split is deliberate rather
// than cosmetic. Routine frames are the system&rsquo;s own record, taken on a
// schedule and overwritten on a rotation so the store cannot grow. Check
// frames are ones a person asked for, named by timestamp and kept until
// deleted. Same camera, same angles; different reasons, different lifetimes.

function when(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function CameraPage({ node }) {
  const {
    routinePhotos, checkPhotos, latestImageUrl, lastImageTimestamp,
    showCapturing, captureTimedOut, captureError, capturedAt,
    requestCapture, setMotor, motorAngle, deleteCheckPhoto,
    isCameraOnline, cameraLastSeenDisplay, cameraHealth, settings, surveyLog,
  } = node;

  const [folder, setFolder] = useState('routine');

  // The routine sweep otherwise runs only on its own schedule, which during
  // a demonstration means waiting for it. This asks for one immediately; the
  // schedule is left alone, so the next scheduled sweep still happens when
  // it was going to.
  const busy = node.busy ?? { active: false };
  const [sweepSpan, setSweepSpan] = useState(node.settings?.checkSpanDeg ?? 90);
  const photos = folder === 'routine' ? routinePhotos : checkPhotos;

  // Routine frames carry the sweep they belong to, so they can be shown as
  // sets rather than as a flat run of pictures.
  const grouped = folder === 'routine'
    ? Object.entries(
        routinePhotos.reduce((acc, p) => {
          (acc[p.setId] ||= []).push(p);
          return acc;
        }, {})
      ).sort((a, b) => (b[1][0]?.timestamp || 0) - (a[1][0]?.timestamp || 0))
    : null;

  const lastSweep = surveyLog?.[0];

  return (
    <section className="page camera-page">
      <BusyBanner busy={busy} />
      <div className="page-head">
        <div className="kicker">Camera</div>
        <h1>Stills, on a sweep</h1>
        <p>
          The mount turns on a stepper and the camera photographs at each
          position. It does not stream: a continuous feed would need a standing
          allocation on the board holding the network connection, and a route in
          from outside the network, neither of which this design has.
        </p>
      </div>

      <div className="grid-2 camera-top-grid">
        <div className="card card-pad camera-panel">
          <div className="card-title"><Icon name="camera" size={14} /> Latest frame</div>

          <div className="cam-frame" style={{ marginTop: 12 }}>
            <div className="cam-hud">
              <span className="cam-chip">
                <span className="conn-dot" style={{ background: isCameraOnline ? 'var(--ok)' : 'var(--crit)' }} />
                {isCameraOnline ? 'online' : 'offline'} · {cameraLastSeenDisplay}
              </span>
              <span className="cam-deg mono">{motorAngle}°</span>
            </div>

            {showCapturing ? (
              <div className="cam-placeholder">Capturing…</div>
            ) : latestImageUrl ? (
              <img src={`${latestImageUrl}&t=${lastImageTimestamp}`} alt="Latest frame" />
            ) : (
              <div className="cam-placeholder">
                <Icon name="leaf" size={48} />
                <span>No photograph yet.</span>
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>
            {capturedAt ? `Captured at ${capturedAt}` : 'No capture yet'}
          </div>
          {captureTimedOut && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--crit)' }}>
              Timed out — the camera did not confirm the upload.
            </div>
          )}
          {captureError && !captureTimedOut && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--crit)' }}>
              {captureError}
            </div>
          )}

          <button className="btn btn-primary" style={{ marginTop: 14, width: '100%' }}
                  onClick={requestCapture} disabled={showCapturing || busy.active}>
            <Icon name="camera" size={16} /> {showCapturing ? 'Capturing…' : 'Capture a frame'}
          </button>

          <div style={{ marginTop: 18 }}>
            <div className="card-title">Sweep now</div>
            <div className="sweep-now" style={{ marginTop: 12 }}>
              <div className="field">
                <label>Span</label>
                <select value={sweepSpan} disabled={busy.active}
                        onChange={(e) => setSweepSpan(Number(e.target.value))}>
                  <option value={90}>90&deg;</option>
                  <option value={180}>180&deg;</option>
                  <option value={360}>360&deg;</option>
                </select>
              </div>
              <button className="btn btn-ghost"
                      style={{ flex: '1 1 140px', justifyContent: 'center' }}
                      disabled={busy.active}
                      onClick={() => node.runManualSweep(sweepSpan, settings.checkFrames)}>
                <Icon name="camera" size={16} /> Sweep
              </button>
            </div>
            <p className="busy-note">
              {busy.active
                ? 'The controller is busy. This will be available when it finishes.'
                : `About ${Math.round((settings.checkFrames * 9 + (sweepSpan / 45) * 2) )} seconds. The mount returns to rest afterwards.`}
            </p>
            <p className="aut-desc" style={{ marginTop: 6 }}>
              A sweep you ask for is filed with the check photographs and kept
              until you delete it. The scheduled sweep is unaffected.
            </p>
          </div>

        </div>

        <div className="card card-pad camera-panel">
          <div className="card-title"><Icon name="chart" size={14} /> Sweeps</div>
          <div className="mini-stats" style={{ marginTop: 12 }}>
            <div className="mini-stat">
              <div className="k">routine</div>
              <div className="v">{settings.routineFrames} frames · {settings.routineSpanDeg}°</div>
            </div>
            <div className="mini-stat">
              <div className="k">check</div>
              <div className="v">{settings.checkFrames} frames · {settings.checkSpanDeg}°</div>
            </div>
          </div>

          {lastSweep && (
            <div style={{ marginTop: 14 }}>
              <div className="card-title" style={{ fontSize: 13 }}>Last sweep</div>
              <div className="foot-meta" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <span>{when(lastSweep.timestamp)}</span>
                <span className={`badge ${lastSweep.ok ? 'ok' : 'warn'}`}>
                  {lastSweep.captured} of {lastSweep.expected} frames
                </span>
              </div>
              {!lastSweep.ok && (
                <p className="aut-desc" style={{ marginTop: 8 }}>
                  Stopped early: {lastSweep.result === 'camera_no_confirm'
                    ? 'the camera did not confirm a capture.'
                    : 'the motor board did not confirm a movement.'}{' '}
                  The mount was returned to its resting position.
                </p>
              )}
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <div className="card-title" style={{ fontSize: 13 }}>Camera board</div>
            <div className="mini-stats" style={{ marginTop: 8 }}>
              <div className="mini-stat"><div className="k">restarts</div><div className="v">{cameraHealth.bootCount ?? '—'}</div></div>
              <div className="mini-stat">
                <div className="k">uptime</div>
                <div className="v">{cameraHealth.uptimeSec != null ? `${Math.floor(cameraHealth.uptimeSec / 60)} min` : '—'}</div>
              </div>
            </div>
            <p className="aut-desc" style={{ marginTop: 10 }}>
              The camera restarts itself on a schedule to bound a fault that has
              not been diagnosed. A restart shown here is expected behaviour.
            </p>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- the two stores */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={folder === 'routine' ? 'active' : ''} onClick={() => setFolder('routine')}>
            Routine · {routinePhotos.length}
          </button>
          <button className={folder === 'check' ? 'active' : ''} onClick={() => setFolder('check')}>
            Checks · {checkPhotos.length}
          </button>
        </div>

        <p className="aut-desc" style={{ marginBottom: 14 }}>
          {folder === 'routine'
            ? 'Taken on the schedule, grouped one folder per sweep. Older sweeps are overwritten in place once the rotation comes round, so this store cannot grow.'
            : 'Taken because someone asked, named by the time they were taken and never overwritten. These are yours to keep or delete.'}
        </p>

        {photos.length === 0 ? (
          <div className="gallery-empty">Nothing in this folder yet.</div>
        ) : folder === 'routine' ? (
          <div style={{ display: 'grid', gap: 18 }}>
            {grouped.map(([setId, frames]) => (
              <div key={setId}>
                <div className="foot-meta" style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' }}>
                  <span>Sweep {setId} ·</span>
                  <span>{when(frames[0]?.timestamp)} · {frames.length} frames</span>
                </div>
                <div className="gallery">
                  {frames
                    .sort((a, b) => Number(a.frameId) - Number(b.frameId))
                    .map((p) => (
                      <figure key={`${setId}-${p.frameId}`}>
                        <img src={`${p.url}&t=${p.timestamp}`} alt={`Sweep ${setId} frame ${p.frameId}`} />
                        <figcaption className="mono">#{p.frameId}</figcaption>
                      </figure>
                    ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="gallery">
            {checkPhotos.map((p) => (
              <figure key={p.id}>
                <img src={`${p.url}&t=${p.timestamp}`} alt={`Check frame ${p.id}`} />
                <figcaption>
                  <span>{when(p.timestamp)}</span>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteCheckPhoto(p.id)}>
                    <Icon name="trash" size={13} />
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
