import { useState } from 'react';
import { Icon } from '../icons.jsx';

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
    <section className="page">
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

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card card-pad">
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

          <div className="foot-meta" style={{ marginTop: 10 }}>
            <span>{capturedAt ? `Captured at ${capturedAt}` : 'No capture yet'}</span>
            {captureTimedOut && <span style={{ color: 'var(--crit)' }}>Timed out — the camera did not confirm</span>}
            {captureError && !captureTimedOut && <span style={{ color: 'var(--crit)' }}>{captureError}</span>}
          </div>

          <button className="btn btn-primary" style={{ marginTop: 14, width: '100%' }}
                  onClick={requestCapture} disabled={showCapturing}>
            <Icon name="camera" size={16} /> {showCapturing ? 'Capturing…' : 'Capture a frame'}
          </button>

          <div className="cam-controls" style={{ marginTop: 18 }}>
            <div className="card-title">Mount</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setMotor(-45)}>
                <Icon name="chevL" size={16} /> 45°
              </button>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setMotor(45)}>
                45° <Icon name="chevR" size={16} />
              </button>
            </div>
            <p className="aut-desc" style={{ marginTop: 10 }}>
              Position is tracked by counting steps, with no sensor to confirm it.
              If the mount is knocked or a movement is interrupted, the stored
              angle and the real one diverge and it must be re-zeroed at the board.
            </p>
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-title"><Icon name="chart" size={14} /> Sweeps</div>
          <div className="mini-stats" style={{ marginTop: 12 }}>
            <div className="mini-stat">
              <span>routine</span>
              <b className="mono">{settings.routineFrames} × {settings.routineSpanDeg}°</b>
            </div>
            <div className="mini-stat">
              <span>check</span>
              <b className="mono">{settings.checkFrames} × {settings.checkSpanDeg}°</b>
            </div>
          </div>

          {lastSweep && (
            <div style={{ marginTop: 14 }}>
              <div className="card-title" style={{ fontSize: 13 }}>Last sweep</div>
              <div className="foot-meta" style={{ marginTop: 6 }}>
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
                <span>uptime</span>
                <b className="mono">{cameraHealth.uptimeSec != null ? `${Math.floor(cameraHealth.uptimeSec / 60)} min` : '—'}</b>
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
                <div className="foot-meta" style={{ marginBottom: 8 }}>
                  <span>Sweep {setId}</span>
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
