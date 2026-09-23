import { useEffect, useState } from 'react';

// Shows what the controller is doing, on every page.
//
// The controller runs one operation at a time, and a sweep occupies it for
// the better part of a minute. Without this the portal looked as though it
// had ignored a press: the button returned to normal, nothing visibly
// happened, and the only way to tell the difference between busy and broken
// was to wait.
export default function BusyBanner({ busy }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy?.active || !busy.since) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - busy.since)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [busy?.active, busy?.since]);

  if (!busy?.active) return null;

  const label = {
    sweep:   'Photographing',
    check:   'Running a check',
    pump:    'Watering',
    motor:   'Moving the mount',
    capture: 'Taking a photograph',
  }[busy.what] ?? 'Working';

  return (
    <div className="busy-banner">
      <span className="spin" />
      <span>
        <b>{label}</b>
        {busy.detail ? ` — ${busy.detail}` : ''}
      </span>
      {elapsed > 0 && <span className="el">{elapsed}s</span>}
    </div>
  );
}
