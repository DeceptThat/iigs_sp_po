import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onValue, ref, remove, set, update } from 'firebase/database';
import { db } from './firebase.js';

// Alert thresholds are no longer kept in the browser.
//
// They were, and it made the portal misleading: the threshold shown on the
// Automation page was a value in localStorage, while the firmware watered
// from a different value in sensors/config. Someone could set 35 here and
// watch the plant water at 60, with nothing on screen to explain it.
//
// Everything the firmware acts on now lives in Firebase and is read back
// from there. Only genuinely browser-local preferences remain below.
const NOTIF_KEY = 'grownode.notifications';
const LOCAL_KEY = 'grownode.local';

// The firmware has no humidity threshold, so this one is display-only and
// raises a notification in the portal without the hardware knowing of it.
export const LOCAL_DEFAULTS = {
  humidityAlertLow: 40,
};

// Mirrors the firmware's compiled defaults, used until sensors/config loads
// so the first render does not show zeros.
export const DEFAULTS = {
  moistureThreshold: 60,
  waterDurationSec: 5,
  tempAlertHigh: 35,
  tempAlertLow: 15,
  humidityAlertLow: 40,
  cooldownHours: 6,
  failsafeHours: 6,
  collectionIntervalMins: 60,
  surveyIntervalH: 6,
  testMode: true,
  autoWater: true,
  dataCollection: true,
  routineSpanDeg: 180,
  checkSpanDeg: 90,
  routineFrames: 5,
  checkFrames: 3,
  checkSweepEnabled: true,
};

const MAX_POINTS = 10;
const COOLDOWN_MS = 90000;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function f1(n) {
  return Number(n).toFixed(1);
}

function timeShort() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function useGrowNode() {
  const [soilMoisture, setSoilMoisture] = useState(0);
  const [humidity, setHumidity] = useState(0);
  const [temperature, setTemperature] = useState(0);
  const [runPump, setRunPump] = useState(false);
  const [motorAngle, setMotorAngle] = useState(0);
  const [lightOn, setLightOn] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const [sweepPending, setSweepPending] = useState(false);
  const [sensorStatus, setSensorStatus] = useState('');
  const [lastWatered, setLastWatered] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [latestImageUrl, setLatestImageUrl] = useState(null);
  const [lastImageTimestamp, setLastImageTimestamp] = useState(null);
  const [captureRequested, setCaptureRequested] = useState(null);
  const [captureError, setCaptureError] = useState(null);
  const [recentPhotos, setRecentPhotos] = useState([]);
  const [routinePhotos, setRoutinePhotos] = useState([]);
  const [checkPhotos, setCheckPhotos] = useState([]);
  const [cameraLastSeen, setCameraLastSeen] = useState(null);
  const [historyReadings, setHistoryReadings] = useState([]);
  const [automationLog, setAutomationLog] = useState([]);
  const [deviceNotifications, setDeviceNotifications] = useState([]);
  const [surveyLog, setSurveyLog] = useState([]);
  const [motorLog, setMotorLog] = useState([]);
  const [live, setLive] = useState({ labels: [], temp: [], hum: [], soil: [] });

  // Health and telemetry the boards report about themselves.
  const [system, setSystem] = useState({});
  const [camera, setCamera] = useState({});

  const [settings, setSettings] = useState(() => ({
    ...DEFAULTS,
    ...loadJson(LOCAL_KEY, LOCAL_DEFAULTS),
  }));
  const [configLoaded, setConfigLoaded] = useState(false);
  const [notifications, setNotifications] = useState(() => loadJson(NOTIF_KEY, []));
  const [activity, setActivity] = useState([]);
  const [toasts, setToasts] = useState([]);
  const cooldown = useRef({});
  const prev = useRef({ pump: null, online: null, seeded: false });

  const pushToast = useCallback((title, sub, tone = 'ok') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((list) => [...list, { id, title, sub, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);

  const pushNotif = useCallback((type, title, body) => {
    setNotifications((list) => {
      const next = [{
        id: `${Date.now()}-${Math.random()}`,
        type, title, body,
        time: timeShort(),
        read: false,
        source: 'portal',
      }, ...list].slice(0, 60);
      localStorage.setItem(NOTIF_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const logEvent = useCallback((type, title, body, tone = 'ok') => {
    setActivity((list) => [{ type, title, body, time: timeShort(), tone }, ...list].slice(0, 40));
  }, []);

  useEffect(() => {
    const currentRef = ref(db, 'sensors/current');
    const controlRef = ref(db, 'sensors/control');
    const configRef = ref(db, 'sensors/config');
    const systemRef = ref(db, 'sensors/system');
    const cameraRef = ref(db, 'sensors/camera');
    const historyRef = ref(db, 'sensors/history');
    const autoLogRef = ref(db, 'sensors/automation_log');
    const notifRef = ref(db, 'sensors/notifications');
    const surveyRef = ref(db, 'sensors/survey_log');
    const motorRef = ref(db, 'sensors/motor_log');

    const unsubCurrent = onValue(currentRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      const t = data.temperature_c;
      const h = data.humidity_percent;
      const s = data.soil_moisture_percent;
      if (t !== undefined) setTemperature(t);
      if (h !== undefined) setHumidity(h);
      if (s !== undefined) setSoilMoisture(s);
      if (t !== undefined || h !== undefined || s !== undefined) {
        const label = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setLive((prevLive) => {
          const next = {
            labels: [...prevLive.labels, label],
            temp: [...prevLive.temp, t ?? prevLive.temp.at(-1) ?? 0],
            hum: [...prevLive.hum, h ?? prevLive.hum.at(-1) ?? 0],
            soil: [...prevLive.soil, s ?? prevLive.soil.at(-1) ?? 0],
          };
          if (next.labels.length > MAX_POINTS) {
            next.labels.shift();
            next.temp.shift();
            next.hum.shift();
            next.soil.shift();
          }
          return next;
        });
      }
    });

    // One-shot commands. The firmware clears each flag as soon as it picks
    // the command up, so a flag still set means nobody has acted on it yet.
    const unsubControl = onValue(controlRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      if (data.run_pump !== undefined) setRunPump(data.run_pump === true);
      if (data.motor_angle !== undefined) setMotorAngle(data.motor_angle);
      if (data.light_on !== undefined) setLightOn(data.light_on === true);
      if (data.run_automation_check !== undefined) setCheckPending(data.run_automation_check === true);
      if (data.run_sweep !== undefined) setSweepPending(data.run_sweep === true);
    });

    // Everything the firmware acts on. This is the source of truth for the
    // thresholds, not the browser.
    const unsubConfig = onValue(configRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      const n = data.notifications || {};
      const sw = data.sweep || {};
      setSettings((cur) => ({
        ...cur,
        moistureThreshold: data.moisture_threshold_percent ?? cur.moistureThreshold,
        waterDurationSec: data.pump_run_seconds ?? cur.waterDurationSec,
        tempAlertHigh: data.temp_max_c ?? cur.tempAlertHigh,
        tempAlertLow: data.temp_min_c ?? cur.tempAlertLow,
        cooldownHours: data.min_water_interval_hours ?? cur.cooldownHours,
        failsafeHours: data.failsafe_timeout_hours ?? cur.failsafeHours,
        collectionIntervalMins: data.collection_interval_mins ?? cur.collectionIntervalMins,
        surveyIntervalH: data.survey_interval_hours ?? cur.surveyIntervalH,
        testMode: data.test_mode ?? cur.testMode,
        autoWater: data.auto_water_enabled ?? cur.autoWater,
        dataCollection: data.data_collection_enabled ?? cur.dataCollection,
        routineSpanDeg: sw.routine_span_deg ?? cur.routineSpanDeg,
        checkSpanDeg: sw.check_span_deg ?? cur.checkSpanDeg,
        routineFrames: sw.routine_frames ?? cur.routineFrames,
        checkFrames: sw.check_frames ?? cur.checkFrames,
        checkSweepEnabled: sw.check_sweep_enabled ?? cur.checkSweepEnabled,
        notifyWatered: n.watered ?? true,
        notifySensorFail: n.sensor_no_response ?? true,
        notifySoilLow: n.soil_low ?? true,
        notifyTempRange: n.temp_out_of_range ?? true,
        notifyCaptureFail: n.capture_failed ?? false,
        notifyIntervalHours: n.interval_hours ?? 4,
      }));
      setConfigLoaded(true);
    });

    const unsubSystem = onValue(systemRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      setSystem(data);
      if (data.sensor_status !== undefined) setSensorStatus(data.sensor_status);
      if (data.last_watered_timestamp !== undefined) setLastWatered(data.last_watered_timestamp);
      if (data.last_seen !== undefined) setLastSeen(data.last_seen);
    });

    const unsubCamera = onValue(cameraRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      setCamera(data);
      if (data.latestImageUrl !== undefined) setLatestImageUrl(data.latestImageUrl);
      if (data.lastImageTimestamp !== undefined) setLastImageTimestamp(data.lastImageTimestamp);
      if (data.control?.capture_requested !== undefined) setCaptureRequested(data.control.capture_requested);
      setCaptureError(data.captureError !== undefined ? data.captureError : null);
      if (data.last_seen !== undefined) setCameraLastSeen(data.last_seen);

      // Photographs live in two stores with different shapes. Routine frames
      // are grouped one folder per sweep, so they sit a level deeper than
      // check frames, which are keyed by the timestamp in their filename.
      const routine = [];
      if (data.routine) {
        Object.entries(data.routine).forEach(([setId, sweep]) => {
          if (!sweep) return;
          Object.entries(sweep).forEach(([frameId, p]) => {
            if (p && p.url) routine.push({ ...p, setId, frameId, kind: 'routine' });
          });
        });
      }
      const check = [];
      if (data.check) {
        Object.entries(data.check).forEach(([id, p]) => {
          if (p && p.url) check.push({ ...p, id, kind: 'check' });
        });
      }
      const byTime = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
      routine.sort(byTime);
      check.sort(byTime);
      setRoutinePhotos(routine);
      setCheckPhotos(check);
      setRecentPhotos([...routine, ...check].sort(byTime).slice(0, 12));
    });

    const unsubHistory = onValue(historyRef, (snap) => {
      const data = snap.val();
      if (!data) {
        setHistoryReadings([]);
        return;
      }
      const list = Object.entries(data).map(([id, entry]) => ({
        id,
        temperature: entry.temperature_c,
        humidity: entry.humidity_percent,
        soil: entry.soil_moisture_percent,
        timestamp: entry.timestamp,
        freeHeap: entry.free_heap,
        maxAllocHeap: entry.max_alloc_heap,
        uptime: entry.uptime_s,
      }));
      setHistoryReadings(list);
    });

    // One entry per check the controller performs, whether or not it acted.
    // The three characters record, in order, whether the reading was written
    // to history, whether watering was commanded, and what the collection
    // setting was. U means the state was not measured rather than measured
    // as false: no delivery sensing is fitted, so a commanded watering is
    // recorded as unverified.
    const unsubAutoLog = onValue(autoLogRef, (snap) => {
      const data = snap.val();
      if (!data) { setAutomationLog([]); return; }
      const list = Object.entries(data).map(([id, e]) => {
        const st = e.stages || '';
        return {
          id,
          timestamp: e.timestamp,
          soil: e.soil_moisture_percent,
          source: e.source,
          stages: st,
          collected: st[0] === 'T',
          watered: st[1] === 'T' || st[1] === 'U',
          wateredVerified: st[1] === 'T',
          collectionEnabled: st[2] === 'T',
        };
      }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setAutomationLog(list);
    });

    // Notifications raised by the firmware itself. Kept apart from the ones
    // the portal raises, because these are what the hardware decided rather
    // than what the browser noticed.
    const unsubNotif = onValue(notifRef, (snap) => {
      const data = snap.val();
      if (!data) { setDeviceNotifications([]); return; }
      const list = Object.entries(data).map(([id, e]) => ({
        id,
        type: e.type,
        title: e.type ? e.type.replace(/_/g, ' ') : 'notification',
        body: e.message,
        severity: e.severity || 'info',
        value: e.value,
        timestamp: e.timestamp,
        time: e.timestamp ? new Date(e.timestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '',
        source: 'device',
        read: false,
      })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 80);
      setDeviceNotifications(list);
    });

    // One entry per photographic sweep, whether or not it finished. A sweep
    // that aborts still records how many frames it managed and why it
    // stopped, so an incomplete set is explained rather than merely short.
    const unsubSurvey = onValue(surveyRef, (snap) => {
      const data = snap.val();
      if (!data) { setSurveyLog([]); return; }
      const list = Object.entries(data).map(([id, e]) => ({
        id,
        timestamp: e.timestamp,
        target: e.target,
        setId: e.set,
        captured: e.frames_captured,
        expected: e.frames_expected,
        spanDeg: e.sweep_degrees,
        result: e.result,
        ok: e.result === 'ok',
      })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setSurveyLog(list);
    });

    // Every commanded movement and whether the motor board acknowledged it.
    // Position is tracked by counting steps with no sensor to confirm it, so
    // this is a record of what was asked for, not of where the mount is.
    const unsubMotor = onValue(motorRef, (snap) => {
      const data = snap.val();
      if (!data) { setMotorLog([]); return; }
      const list = Object.entries(data).map(([id, e]) => ({
        id,
        timestamp: e.timestamp,
        angle: e.angle_deg,
        result: e.result,
        ok: e.result === 'ok',
        positionAfter: e.position_after_deg,
      })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setMotorLog(list);
    });

    return () => {
      unsubCurrent();
      unsubControl();
      unsubConfig();
      unsubSystem();
      unsubCamera();
      unsubHistory();
      unsubAutoLog();
      unsubNotif();
      unsubSurvey();
      unsubMotor();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(interval);
  }, []);

  const secondsSinceLastSeen = lastSeen ? Math.floor(nowTick / 1000) - lastSeen : null;
  const isBoardOnline = secondsSinceLastSeen !== null && secondsSinceLastSeen < 90;
  const secondsSinceCameraSeen = cameraLastSeen ? Math.floor(nowTick / 1000) - cameraLastSeen : null;
  const isCameraOnline = secondsSinceCameraSeen !== null && secondsSinceCameraSeen < 90;

  // A watering request, not the pump itself. The flag is cleared by the
  // controller when it picks the command up, so the transition to false is
  // the command being accepted rather than the pump stopping.
  useEffect(() => {
    if (prev.current.pump === null) {
      prev.current.pump = runPump;
      return;
    }
    if (prev.current.pump !== runPump) {
      if (runPump) {
        logEvent('pump', 'Watering requested', `Soil moisture ${f1(soilMoisture)}%.`, 'ok');
        pushToast('Watering requested', 'Sent to the controller', 'ok');
      } else {
        logEvent('pump', 'Watering command accepted', `Controller picked up the request.`, 'ok');
      }
      prev.current.pump = runPump;
    }
  }, [runPump, soilMoisture, logEvent, pushToast]);

  useEffect(() => {
    if (prev.current.online === null) {
      prev.current.online = isBoardOnline;
      return;
    }
    if (prev.current.online !== isBoardOnline) {
      if (isBoardOnline) {
        logEvent('rest', 'Connection restored', 'Board heartbeat resumed.', 'ok');
        pushNotif('rest', 'Connection restored', 'IIGS is back online. Telemetry syncing again.');
        pushToast('Connection restored', 'Telemetry resumed', 'ok');
      } else {
        logEvent('conn', 'Connection lost', 'Board heartbeat timed out.', 'warn');
        pushNotif('conn', 'Connection lost', 'No recent heartbeat from the controller.');
        pushToast('Connection lost', 'Board may be offline', 'warn');
      }
      prev.current.online = isBoardOnline;
    }
  }, [isBoardOnline, logEvent, pushNotif, pushToast]);

  // Portal-side alerts. Temperature and soil are also watched by the
  // firmware, which raises its own notifications on its own schedule; these
  // appear sooner because the browser sees every reading as it arrives.
  useEffect(() => {
    if (!configLoaded) return;
    const now = Date.now();
    const cooled = (type) => {
      if (cooldown.current[type] && now - cooldown.current[type] < COOLDOWN_MS) return false;
      cooldown.current[type] = now;
      return true;
    };
    if (temperature > settings.tempAlertHigh && cooled('temp')) {
      logEvent('temp', 'Temperature high', `${f1(temperature)} °C above ${settings.tempAlertHigh} °C.`, 'crit');
      pushNotif('temp', 'Temperature high', `Read ${f1(temperature)} °C, threshold is ${settings.tempAlertHigh} °C.`);
      pushToast('Temperature high', `${f1(temperature)} °C`, 'crit');
    }
    if (temperature < settings.tempAlertLow && temperature > 0 && cooled('templow')) {
      logEvent('temp', 'Temperature low', `${f1(temperature)} °C below ${settings.tempAlertLow} °C.`, 'warn');
      pushNotif('temp', 'Temperature low', `Read ${f1(temperature)} °C, threshold is ${settings.tempAlertLow} °C.`);
    }
    if (humidity < settings.humidityAlertLow && humidity > 0 && cooled('hum')) {
      logEvent('hum', 'Humidity low', `${f1(humidity)}% RH below ${settings.humidityAlertLow}%.`, 'warn');
      pushNotif('hum', 'Humidity low', `Read ${f1(humidity)}% RH, threshold is ${settings.humidityAlertLow}%.`);
    }
    if (soilMoisture > 0 && soilMoisture <= settings.moistureThreshold && cooled('soil')) {
      logEvent('soil', 'Soil dry', `${f1(soilMoisture)}% at or below watering threshold.`, 'warn');
      pushNotif('soil', 'Soil moisture low', `Read ${f1(soilMoisture)}%, threshold is ${settings.moistureThreshold}%.`);
    }
  }, [temperature, humidity, soilMoisture, settings, configLoaded, logEvent, pushNotif, pushToast]);

  const health = useMemo(() => {
    const t = temperature;
    const h = humidity;
    const s = soilMoisture;
    const th = settings.moistureThreshold;
    let score = 100;
    const problems = [];
    if (t < settings.tempAlertLow || t > settings.tempAlertHigh) { score -= 28; problems.push(`temperature ${f1(t)} °C`); }
    else if (t < settings.tempAlertLow + 2 || t > settings.tempAlertHigh - 2) { score -= 10; problems.push(`temperature ${f1(t)} °C`); }
    if (h < 32 || h > 80) { score -= 18; problems.push(`humidity ${f1(h)}%`); }
    else if (h < 40 || h > 72) { score -= 7; problems.push(`humidity ${f1(h)}%`); }
    if (s <= th) { score -= 24; problems.push(`soil moisture ${f1(s)}%`); }
    else if (s <= th + 9) { score -= 8; problems.push('soil moisture trending low'); }
    if (!isBoardOnline) { score -= 12; problems.push('controller heartbeat stale'); }
    const level = score >= 82 ? 'ok' : score >= 60 ? 'watch' : 'crit';
    let title;
    let sub;
    if (level === 'ok') {
      title = isBoardOnline ? 'All systems nominal' : 'Nominal — link stale';
      sub = isBoardOnline ? 'Growing steadily. Nothing needs attention.' : 'Last readings look fine, but the board has not checked in.';
    } else if (level === 'watch') {
      title = `Watch — ${problems[0]}`;
      sub = 'Values are still workable, but keep an eye on it.';
    } else {
      title = 'Attention needed';
      sub = `${problems.join('; ')}. Check the alert log.`;
    }
    return { level, title, sub, score };
  }, [temperature, humidity, soilMoisture, settings, isBoardOnline]);

  const lastWateredDisplay = lastWatered
    ? new Date(lastWatered * 1000).toLocaleString()
    : 'Unknown';
  const lastSeenDisplay = lastSeen ? `${secondsSinceLastSeen}s ago` : 'Never';
  const cameraLastSeenDisplay = cameraLastSeen ? `${secondsSinceCameraSeen}s ago` : 'Never';

  const isCapturing = captureRequested && (!lastImageTimestamp || lastImageTimestamp < captureRequested);
  const CAPTURE_TIMEOUT_SEC = 30;
  const captureElapsed = captureRequested ? Math.floor(nowTick / 1000) - captureRequested : null;
  const captureTimedOut = isCapturing && captureElapsed !== null && captureElapsed > CAPTURE_TIMEOUT_SEC;
  const showCapturing = isCapturing && !captureTimedOut;

  // ---------------------------------------------------------------- actions

  // A request, not a switch. The controller clears the flag as soon as it
  // acts, so writing the opposite of the current value would cancel a
  // watering that had just been asked for rather than start one. The pump
  // runs for the configured duration and stops by itself.
  const togglePump = async () => {
    try {
      await set(ref(db, 'sensors/control/run_pump'), true);
    } catch (err) {
      console.error('Error requesting pump:', err);
    }
  };

  // The full cycle: read the sensors, apply the threshold, water only if the
  // soil is actually dry, and log the outcome. Distinct from the pump, which
  // waters whatever the reading says.
  const runCheck = async () => {
    try {
      await set(ref(db, 'sensors/control/run_automation_check'), true);
    } catch (err) {
      console.error('Error requesting check:', err);
    }
  };

  // Asks the controller to run the routine sweep now. The schedule is left
  // alone: the next scheduled sweep still happens when it was going to, which
  // matters during a demonstration where the two would otherwise collide.
  const runSweep = async () => {
    try {
      await set(ref(db, 'sensors/control/run_sweep'), true);
    } catch (err) {
      console.error('Error requesting sweep:', err);
    }
  };

  const runManualSweep = async (spanDeg, frames) => {
    try {
      await update(ref(db, 'sensors/control'), {
        manual_sweep_span_deg: spanDeg,
        manual_sweep_frames: frames,
        run_manual_sweep: true,
      });
      pushToast(`Sweep requested: ${frames} frames over ${spanDeg}\u00b0`);
    } catch (err) {
      console.error('Error requesting manual sweep:', err);
      pushToast('Could not request the sweep');
    }
  };

  const toggleLight = async (next) => {
    try {
      await set(ref(db, 'sensors/control/light_on'), next === undefined ? !lightOn : !!next);
    } catch (err) {
      console.error('Error switching light:', err);
    }
  };

  const setMotor = async (angle) => {
    try {
      await set(ref(db, 'sensors/control/motor_angle'), Number(angle));
    } catch (err) {
      console.error('Error turning motor:', err);
    }
  };

  // The camera reads its target and frame numbers alongside the request, so
  // all four are written together. A set of -1 marks an ungrouped capture,
  // which the camera files by timestamp among the check photographs.
  const requestCapture = async () => {
    try {
      await update(ref(db, 'sensors/camera/control'), {
        capture_requested: Math.floor(Date.now() / 1000),
        capture_target: 'check',
        capture_set: -1,
        capture_frame: 0,
      });
    } catch (err) {
      console.error('Error requesting capture:', err);
    }
  };

  const saveCollectionInterval = async (value) => {
    try {
      const mins = Number(value);
      if (mins > 0) await update(ref(db, 'sensors/config'), { collection_interval_mins: mins });
    } catch (err) {
      console.error('Error updating collection interval:', err);
    }
  };

  // Written to Firebase, so what is shown here and what the firmware waters
  // by cannot drift apart. Only humidityAlertLow stays in the browser, since
  // the firmware has no humidity threshold to compare it against.
  const saveSettings = async (next) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ humidityAlertLow: merged.humidityAlertLow }));

    try {
      await update(ref(db, 'sensors/config'), {
        moisture_threshold_percent: Number(merged.moistureThreshold),
        pump_run_seconds: Number(merged.waterDurationSec),
        temp_max_c: Number(merged.tempAlertHigh),
        temp_min_c: Number(merged.tempAlertLow),
        min_water_interval_hours: Number(merged.cooldownHours),
        failsafe_timeout_hours: Number(merged.failsafeHours),
        collection_interval_mins: Number(merged.collectionIntervalMins),
        survey_interval_hours: Number(merged.surveyIntervalH),
        test_mode: !!merged.testMode,
        auto_water_enabled: !!merged.autoWater,
        data_collection_enabled: !!merged.dataCollection,
      });
      pushToast('Settings saved', 'Applied on the controller’s next cycle', 'ok');
    } catch (err) {
      console.error('Error saving settings:', err);
      pushToast('Settings not saved', 'The database rejected the write', 'crit');
    }
  };

  const saveSweep = async (next) => {
    try {
      await update(ref(db, 'sensors/config/sweep'), next);
      pushToast('Sweep settings saved', '', 'ok');
    } catch (err) {
      console.error('Error saving sweep settings:', err);
    }
  };

  const saveNotificationPrefs = async (next) => {
    try {
      await update(ref(db, 'sensors/config/notifications'), next);
      pushToast('Notification settings saved', '', 'ok');
    } catch (err) {
      console.error('Error saving notification settings:', err);
    }
  };

  const resetSettings = () => {
    setSettings((cur) => ({ ...DEFAULTS, humidityAlertLow: cur.humidityAlertLow }));
    pushToast('Settings reset', 'Not saved yet — press save to apply', 'warn');
  };

  const markAllRead = () => {
    setNotifications((list) => {
      const next = list.map((n) => ({ ...n, read: true }));
      localStorage.setItem(NOTIF_KEY, JSON.stringify(next));
      return next;
    });
  };

  const toggleRead = (id) => {
    setNotifications((list) => {
      const next = list.map((n) => (n.id === id ? { ...n, read: !n.read } : n));
      localStorage.setItem(NOTIF_KEY, JSON.stringify(next));
      return next;
    });
  };

  const deleteNotif = (id) => {
    setNotifications((list) => {
      const next = list.filter((n) => n.id !== id);
      localStorage.setItem(NOTIF_KEY, JSON.stringify(next));
      return next;
    });
  };

  const clearNotifs = () => {
    setNotifications([]);
    localStorage.setItem(NOTIF_KEY, JSON.stringify([]));
  };

  // Device notifications live in the database, so clearing them removes them
  // for everyone rather than only in this browser.
  const clearDeviceNotifs = async () => {
    const confirmed = window.confirm(`Delete all ${deviceNotifications.length} device notifications? This removes them for everyone.`);
    if (!confirmed) return;
    try {
      await remove(ref(db, 'sensors/notifications'));
    } catch (err) {
      console.error('Error clearing device notifications:', err);
    }
  };

  const deleteReading = async (id) => {
    try {
      await remove(ref(db, `sensors/history/${id}`));
    } catch (err) {
      console.error('Error deleting reading:', err);
    }
  };

  const clearAllHistory = async () => {
    const confirmed = window.confirm(`Delete all ${historyReadings.length} logged readings? This can't be undone.`);
    if (!confirmed) return;
    try {
      await remove(ref(db, 'sensors/history'));
    } catch (err) {
      console.error('Error clearing history:', err);
    }
  };

  // Check photographs are kept until deleted, so the portal owns their
  // removal. Routine frames are overwritten on a rotation and are not
  // deleted here.
  const deleteCheckPhoto = async (id) => {
    try {
      await remove(ref(db, `sensors/camera/check/${id}`));
    } catch (err) {
      console.error('Error deleting photograph:', err);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Everything the controller reported about itself at its last heartbeat.
  const busy = useMemo(() => {
    const what = system.activity ?? 'idle';
    return {
      active: what !== 'idle' && what !== '' && what != null,
      what,
      detail: system.activity_detail ?? '',
      since: system.activity_since ?? null,
      lastWhat: system.last_activity ?? null,
      lastOutcome: system.last_outcome ?? null,
      lastTookMs: system.last_activity_took_ms ?? null,
      lastAt: system.last_activity_at ?? null,
    };
  }, [system]);

  const controllerHealth = useMemo(() => ({
    uptimeSec: system.uptime_s ?? null,
    freeHeap: system.free_heap ?? null,
    maxAllocHeap: system.max_alloc_heap ?? null,
    lastRestart: system.last_restart ?? system.last_scheduled_restart ?? null,
    lastRestartReason: system.last_restart_reason ?? null,
    failsafeActive: system.failsafe_active === true,
    lastSurveyError: system.last_survey_error ?? null,
    lightIsOn: system.light_is_on,
  }), [system]);

  const cameraHealth = useMemo(() => ({
    uptimeSec: camera.uptime_s ?? null,
    bootCount: camera.boot_count ?? null,
    freeHeap: camera.free_heap ?? null,
    freePsram: camera.free_psram ?? null,
    lastImageTarget: camera.lastImageTarget ?? null,
  }), [camera]);

  return {
    soilMoisture,
    humidity,
    temperature,
    runPump,
    motorAngle,
    lightOn,
    checkPending,
    sweepPending,
    collectionInterval: settings.collectionIntervalMins,
    sensorStatus,
    lastWateredDisplay,
    lastSeenDisplay,
    isBoardOnline,
    isCameraOnline,
    cameraLastSeenDisplay,
    latestImageUrl,
    lastImageTimestamp,
    captureError,
    recentPhotos,
    routinePhotos,
    checkPhotos,
    showCapturing,
    captureTimedOut,
    capturedAt: lastImageTimestamp ? new Date(lastImageTimestamp * 1000).toLocaleTimeString() : null,
    historyReadings,
    automationLog,
    surveyLog,
    motorLog,
    deviceNotifications,
    live,
    settings,
    setSettings,
    configLoaded,
    notifications,
    activity,
    toasts,
    health,
    controllerHealth,
    busy,
    cameraHealth,
    unreadCount,
    togglePump,
    runCheck,
    runSweep,
    runManualSweep,
    toggleLight,
    setMotor,
    requestCapture,
    saveCollectionInterval,
    saveSettings,
    saveSweep,
    saveNotificationPrefs,
    resetSettings,
    markAllRead,
    toggleRead,
    deleteNotif,
    clearNotifs,
    clearDeviceNotifs,
    deleteReading,
    clearAllHistory,
    deleteCheckPhoto,
    pushToast,
  };
}