import { useState, useEffect } from 'react';
import { db } from './firebase.js';
import { ref, onValue, set } from 'firebase/database';

function MainDashboard() {
  // --- STATE (matches actual master board schema under /sensors) ---
  const [soilMoisture, setSoilMoisture] = useState(0);
  const [humidity, setHumidity] = useState(0);
  const [temperature, setTemperature] = useState(0);
  const [runPump, setRunPump] = useState(false);
  const [motorAngle, setMotorAngle] = useState(0);
  const [motorAngleInput, setMotorAngleInput] = useState(20);
  const [collectionInterval, setCollectionInterval] = useState(60);
  const [collectionIntervalInput, setCollectionIntervalInput] = useState(60);
  const [sensorStatus, setSensorStatus] = useState("");
  const [lastWatered, setLastWatered] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Camera state — lives under /sensors/camera, matching the master
  // board's schema convention. Image itself lives in Firebase Storage
  // now that the Blaze plan is active; RTDB just holds the small fields.
  const [latestImageUrl, setLatestImageUrl] = useState(null);
  const [lastImageTimestamp, setLastImageTimestamp] = useState(null);
  const [captureRequested, setCaptureRequested] = useState(null);
  const [captureError, setCaptureError] = useState(null);

  // --- REAL-TIME RTDB LISTENERS ---
  useEffect(() => {
    const currentRef = ref(db, "sensors/current");
    const controlRef = ref(db, "sensors/control");
    const systemRef = ref(db, "sensors/system");
    const cameraRef = ref(db, "sensors/camera");

    const unsubCurrent = onValue(currentRef, (snap) => {
      const data = snap.val();
      if (data) {
        if (data.soil_moisture_percent !== undefined) setSoilMoisture(data.soil_moisture_percent);
        if (data.humidity_percent !== undefined) setHumidity(data.humidity_percent);
        if (data.temperature_c !== undefined) setTemperature(data.temperature_c);
      }
    });

    const unsubControl = onValue(controlRef, (snap) => {
      const data = snap.val();
      if (data) {
        if (data.run_pump !== undefined) setRunPump(data.run_pump);
        if (data.motor_angle !== undefined) setMotorAngle(data.motor_angle);
        if (data.collection_interval_mins !== undefined) {
          setCollectionInterval(data.collection_interval_mins);
          setCollectionIntervalInput(data.collection_interval_mins);
        }
      }
    });

    const unsubSystem = onValue(systemRef, (snap) => {
      const data = snap.val();
      if (data) {
        if (data.sensor_status !== undefined) setSensorStatus(data.sensor_status);
        if (data.last_watered_timestamp !== undefined) setLastWatered(data.last_watered_timestamp);
        if (data.last_seen !== undefined) setLastSeen(data.last_seen);
      }
    });

    const unsubCamera = onValue(cameraRef, (snap) => {
      const data = snap.val();
      if (data) {
        if (data.latestImageUrl !== undefined) setLatestImageUrl(data.latestImageUrl);
        if (data.lastImageTimestamp !== undefined) setLastImageTimestamp(data.lastImageTimestamp);
        if (data.captureRequested !== undefined) setCaptureRequested(data.captureRequested);
        setCaptureError(data.captureError !== undefined ? data.captureError : null);
      }
    });

    return () => {
      unsubCurrent();
      unsubControl();
      unsubSystem();
      unsubCamera();
    };
  }, []);

  // Re-check every 10s so "Online"/"Offline" updates live even without
  // new Firebase data arriving (i.e. it can actually detect a board going quiet).
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(interval);
  }, []);

  // --- ACTIONS ---
  const togglePump = async () => {
    try {
      await set(ref(db, "sensors/control/run_pump"), !runPump);
    } catch (err) {
      console.error("Error updating pump:", err);
    }
  };

  const turnMotor = async () => {
    try {
      await set(ref(db, "sensors/control/motor_angle"), Number(motorAngleInput));
    } catch (err) {
      console.error("Error turning motor:", err);
    }
  };

  const requestCapture = async () => {
    try {
      await set(ref(db, "sensors/camera/captureRequested"), Math.floor(Date.now() / 1000));
    } catch (err) {
      console.error("Error requesting capture:", err);
    }
  };

  const updateCollectionInterval = async () => {
    try {
      const value = Number(collectionIntervalInput);
      if (value > 0) {
        await set(ref(db, "sensors/control/collection_interval_mins"), value);
      }
    } catch (err) {
      console.error("Error updating collection interval:", err);
    }
  };

  const isCapturing =
    captureRequested && (!lastImageTimestamp || lastImageTimestamp < captureRequested);

  // Avoid leaving the capture controls disabled when the board never responds.
  const CAPTURE_TIMEOUT_SEC = 30;
  const captureElapsed = captureRequested
    ? Math.floor(nowTick / 1000) - captureRequested
    : null;
  const captureTimedOut = isCapturing && captureElapsed !== null && captureElapsed > CAPTURE_TIMEOUT_SEC;
  const showCapturing = isCapturing && !captureTimedOut;

  const capturedAt = lastImageTimestamp
    ? new Date(lastImageTimestamp * 1000).toLocaleTimeString()
    : null;

  const lastWateredDisplay = lastWatered
    ? new Date(lastWatered * 1000).toLocaleString()
    : "Unknown";

  // Board is "online" if we've heard from it within 3x the heartbeat
  // interval (90s) — generous enough to not falsely flag it offline from
  // one slow/skipped beat, but still catches a genuinely dead board quickly.
  const secondsSinceLastSeen = lastSeen ? Math.floor(nowTick / 1000) - lastSeen : null;
  const isBoardOnline = secondsSinceLastSeen !== null && secondsSinceLastSeen < 90;
  const lastSeenDisplay = lastSeen
    ? `${secondsSinceLastSeen}s ago`
    : "Never";

  return (
    <div style={{
      fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
      backgroundColor: "#0f172a",
      color: "#f8fafc",
      minHeight: "100vh",
      padding: "24px",
      boxSizing: "border-box"
    }}>
      <header style={{ textAlign: "center", marginBottom: "32px" }}>
        <h1 style={{ margin: "0 0 8px 0", color: "#38bdf8" }}>🌱 Automated System Dashboard</h1>
        <p style={{ margin: 0, color: "#94a3b8" }}>Live Monitoring & Hardware Control Portal</p>

        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          marginTop: "12px",
          padding: "6px 14px",
          borderRadius: "999px",
          backgroundColor: isBoardOnline ? "rgba(74, 222, 128, 0.15)" : "rgba(248, 113, 113, 0.15)",
          border: `1px solid ${isBoardOnline ? "#4ade80" : "#f87171"}`
        }}>
          <span style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: isBoardOnline ? "#4ade80" : "#f87171"
          }} />
          <span style={{
            fontSize: "0.85rem",
            fontWeight: "bold",
            color: isBoardOnline ? "#4ade80" : "#f87171"
          }}>
            IIGS {isBoardOnline ? "Online" : "Offline"}
          </span>
          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
            (last seen {lastSeenDisplay})
          </span>
        </div>
      </header>

      <main style={{
        maxWidth: "1100px",
        margin: "0 auto",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        gap: "24px"
      }}>

        {/* --- CAMERA CAPTURE CARD --- */}
        <section style={{
          backgroundColor: "#1e293b",
          borderRadius: "16px",
          padding: "20px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
        }}>
          <h2 style={{ fontSize: "1.2rem", marginTop: 0, color: "#e2e8f0" }}>Camera Snapshot</h2>

          <div style={{
            width: "100%",
            aspectRatio: "4/3",
            backgroundColor: "#020617",
            borderRadius: "12px",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #334155"
          }}>
            {showCapturing ? (
              <span style={{ color: "#38bdf8", fontSize: "0.9rem" }}>Capturing...</span>
            ) : latestImageUrl ? (
              <img
                src={`${latestImageUrl}?t=${lastImageTimestamp}`}
                alt="Latest camera snapshot"
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <span style={{ color: "#64748b", fontSize: "0.9rem" }}>
                No photo yet — click Capture below
              </span>
            )}
          </div>

          <button
            onClick={requestCapture}
            disabled={showCapturing}
            style={{
              width: "100%",
              padding: "14px",
              marginTop: "16px",
              fontSize: "1rem",
              fontWeight: "bold",
              borderRadius: "10px",
              border: "none",
              cursor: showCapturing ? "default" : "pointer",
              backgroundColor: showCapturing ? "#475569" : "#3b82f6",
              color: "#ffffff",
              transition: "background-color 0.2s"
            }}
          >
            {showCapturing ? "Capturing..." : captureTimedOut ? "Retry Capture" : "Capture Photo"}
          </button>

          <div style={{ marginTop: "10px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
              {capturedAt ? `Last captured at ${capturedAt}` : "No capture yet"}
            </span>
            {captureTimedOut && (
              <span style={{ fontSize: "0.8rem", color: "#f87171" }}>
                ⚠ Timed out — board may be offline or failed to upload
              </span>
            )}
            {captureError && !captureTimedOut && (
              <span style={{ fontSize: "0.8rem", color: "#f87171" }}>⚠ {captureError}</span>
            )}
          </div>
        </section>

        {/* --- CONTROLS & TELEMETRY --- */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>

          {/* Status Overview */}
          <section style={{
            backgroundColor: "#1e293b",
            borderRadius: "16px",
            padding: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}>
            <h2 style={{ fontSize: "1.2rem", marginTop: 0, color: "#e2e8f0" }}>Telemetry & Status</h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div style={{ backgroundColor: "#0f172a", padding: "14px", borderRadius: "10px", border: "1px solid #334155" }}>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Soil Moisture</span>
                <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#38bdf8", marginTop: "4px" }}>
                  {soilMoisture}%
                </div>
              </div>

              <div style={{ backgroundColor: "#0f172a", padding: "14px", borderRadius: "10px", border: "1px solid #334155" }}>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Pump State</span>
                <div style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: runPump ? "#4ade80" : "#f87171",
                  marginTop: "4px"
                }}>
                  {runPump ? "ON" : "OFF"}
                </div>
              </div>

              <div style={{ backgroundColor: "#0f172a", padding: "14px", borderRadius: "10px", border: "1px solid #334155" }}>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Humidity</span>
                <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#38bdf8", marginTop: "4px" }}>
                  {humidity}%
                </div>
              </div>

              <div style={{ backgroundColor: "#0f172a", padding: "14px", borderRadius: "10px", border: "1px solid #334155" }}>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Temperature</span>
                <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#38bdf8", marginTop: "4px" }}>
                  {temperature}°C
                </div>
              </div>
            </div>

            <p style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "14px", marginBottom: 0 }}>
              Sensor status: <strong>{sensorStatus || "Unknown"}</strong><br />
              Last watered: <strong>{lastWateredDisplay}</strong>
            </p>
          </section>

          {/* Water Pump Control */}
          <section style={{
            backgroundColor: "#1e293b",
            borderRadius: "16px",
            padding: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}>
            <h2 style={{ fontSize: "1.2rem", marginTop: 0, color: "#e2e8f0" }}>Water Pump Manual Override</h2>
            <button
              onClick={togglePump}
              style={{
                width: "100%",
                padding: "14px",
                fontSize: "1rem",
                fontWeight: "bold",
                borderRadius: "10px",
                border: "none",
                cursor: "pointer",
                backgroundColor: runPump ? "#ef4444" : "#10b981",
                color: "#ffffff",
                transition: "background-color 0.2s"
              }}
            >
              {runPump ? "Turn Pump OFF" : "Turn Pump ON"}
            </button>
          </section>

          {/* Motor / Actuator Control */}
          <section style={{
            backgroundColor: "#1e293b",
            borderRadius: "16px",
            padding: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}>
            <h2 style={{ fontSize: "1.2rem", marginTop: 0, color: "#e2e8f0" }}>Motor Control</h2>

            <label style={{ fontSize: "0.85rem", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
              Turn right by (degrees):
            </label>
            <input
              type="number"
              value={motorAngleInput}
              onChange={(e) => setMotorAngleInput(e.target.value)}
              placeholder="e.g. 20"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #475569",
                backgroundColor: "#0f172a",
                color: "#f8fafc",
                marginBottom: "14px",
                boxSizing: "border-box",
                fontSize: "1rem"
              }}
            />

            <button
              onClick={turnMotor}
              style={{
                width: "100%",
                padding: "12px",
                fontSize: "0.95rem",
                fontWeight: "bold",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                backgroundColor: "#3b82f6",
                color: "#ffffff"
              }}
            >
              Turn Right {motorAngleInput}°
            </button>

            <p style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "10px", marginBottom: 0 }}>
              Current motor angle: <strong>{motorAngle}°</strong> (right-turn only, for now)
            </p>
          </section>

          {/* Data Collection Interval */}
          <section style={{
            backgroundColor: "#1e293b",
            borderRadius: "16px",
            padding: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}>
            <h2 style={{ fontSize: "1.2rem", marginTop: 0, color: "#e2e8f0" }}>Data Collection Interval</h2>

            <label style={{ fontSize: "0.85rem", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
              Collect sensor readings every (minutes):
            </label>
            <input
              type="number"
              min="1"
              value={collectionIntervalInput}
              onChange={(e) => setCollectionIntervalInput(e.target.value)}
              placeholder="e.g. 60"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #475569",
                backgroundColor: "#0f172a",
                color: "#f8fafc",
                marginBottom: "14px",
                boxSizing: "border-box",
                fontSize: "1rem"
              }}
            />

            <button
              onClick={updateCollectionInterval}
              style={{
                width: "100%",
                padding: "12px",
                fontSize: "0.95rem",
                fontWeight: "bold",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                backgroundColor: "#3b82f6",
                color: "#ffffff"
              }}
            >
              Save Interval
            </button>

            <p style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "10px", marginBottom: 0 }}>
              Current interval: <strong>every {collectionInterval} min</strong>
            </p>
          </section>

        </div>
      </main>
    </div>
  );
}

export default MainDashboard;
