// src/DataHistory.jsx
import React, { useState, useEffect } from "react";
import { ref, onValue, remove } from "firebase/database";
import { db } from "./firebase";

export default function DataHistory() {
  const [readings, setReadings] = useState([]);
  const [sortNewestFirst, setSortNewestFirst] = useState(true);

  useEffect(() => {
    const historyRef = ref(db, "sensors/history");

    const unsubscribe = onValue(historyRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setReadings([]);
        return;
      }

      // Firebase push() entries come back as an object keyed by push ID —
      // convert to an array so we can sort/display it as a list.
      const list = Object.entries(data).map(([id, entry]) => ({
        id,
        temperature: entry.temperature_c,
        humidity: entry.humidity_percent,
        soil: entry.soil_moisture_percent,
        timestamp: entry.timestamp
      }));

      setReadings(list);
    });

    return () => unsubscribe();
  }, []);

  const sorted = [...readings].sort((a, b) =>
    sortNewestFirst ? b.timestamp - a.timestamp : a.timestamp - b.timestamp
  );

  const formatTime = (ts) =>
    ts ? new Date(ts * 1000).toLocaleString() : "Unknown";

  // Delete one reading. No confirmation dialog needed for a single row —
  // low stakes, and the row disappearing immediately is enough feedback.
  const deleteReading = async (id) => {
    try {
      await remove(ref(db, `sensors/history/${id}`));
    } catch (err) {
      console.error("Error deleting reading:", err);
    }
  };

  // Clear everything — this one DOES confirm first, since it's irreversible
  // and wipes the whole log at once.
  const clearAllHistory = async () => {
    const confirmed = window.confirm(
      `Delete all ${readings.length} logged readings? This can't be undone.`
    );
    if (!confirmed) return;

    try {
      await remove(ref(db, "sensors/history"));
    } catch (err) {
      console.error("Error clearing history:", err);
    }
  };

  // Simple min/max/avg summary — no charting library needed for this to be useful.
  const summarize = (key) => {
    const values = readings.map((r) => r[key]).filter((v) => v !== undefined && v !== null);
    if (values.length === 0) return { min: "-", max: "-", avg: "-" };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1);
    return { min, max, avg };
  };

  const tempStats = summarize("temperature");
  const humStats = summarize("humidity");
  const soilStats = summarize("soil");

  const cardStyle = {
    backgroundColor: "#0f172a",
    padding: "14px",
    borderRadius: "10px",
    border: "1px solid #334155"
  };

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
        <h1 style={{ margin: "0 0 8px 0", color: "#38bdf8" }}>📊 Sensor History</h1>
        <p style={{ margin: 0, color: "#94a3b8" }}>
          {readings.length} logged reading{readings.length === 1 ? "" : "s"}
        </p>
      </header>

      <main style={{ maxWidth: "900px", margin: "0 auto" }}>

        {/* Summary Stats */}
        <section style={{
          backgroundColor: "#1e293b",
          borderRadius: "16px",
          padding: "20px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          marginBottom: "24px"
        }}>
          <h2 style={{ fontSize: "1.2rem", marginTop: 0, marginBottom: "16px", color: "#e2e8f0" }}>
            Summary
          </h2>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
            <div style={cardStyle}>
              <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Temperature (°C)</span>
              <div style={{ fontSize: "0.95rem", marginTop: "6px" }}>
                <div>Min: <strong style={{ color: "#38bdf8" }}>{tempStats.min}</strong></div>
                <div>Avg: <strong style={{ color: "#38bdf8" }}>{tempStats.avg}</strong></div>
                <div>Max: <strong style={{ color: "#38bdf8" }}>{tempStats.max}</strong></div>
              </div>
            </div>

            <div style={cardStyle}>
              <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Humidity (%)</span>
              <div style={{ fontSize: "0.95rem", marginTop: "6px" }}>
                <div>Min: <strong style={{ color: "#38bdf8" }}>{humStats.min}</strong></div>
                <div>Avg: <strong style={{ color: "#38bdf8" }}>{humStats.avg}</strong></div>
                <div>Max: <strong style={{ color: "#38bdf8" }}>{humStats.max}</strong></div>
              </div>
            </div>

            <div style={cardStyle}>
              <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Soil Moisture (%)</span>
              <div style={{ fontSize: "0.95rem", marginTop: "6px" }}>
                <div>Min: <strong style={{ color: "#38bdf8" }}>{soilStats.min}</strong></div>
                <div>Avg: <strong style={{ color: "#38bdf8" }}>{soilStats.avg}</strong></div>
                <div>Max: <strong style={{ color: "#38bdf8" }}>{soilStats.max}</strong></div>
              </div>
            </div>
          </div>
        </section>

        {/* Readings Table */}
        <section style={{
          backgroundColor: "#1e293b",
          borderRadius: "16px",
          padding: "20px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 style={{ fontSize: "1.2rem", margin: 0, color: "#e2e8f0" }}>Readings Log</h2>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setSortNewestFirst(!sortNewestFirst)}
                style={{
                  padding: "8px 14px",
                  fontSize: "0.85rem",
                  borderRadius: "8px",
                  border: "1px solid #475569",
                  backgroundColor: "#0f172a",
                  color: "#f8fafc",
                  cursor: "pointer"
                }}
              >
                {sortNewestFirst ? "Newest first" : "Oldest first"} ↕
              </button>
              {readings.length > 0 && (
                <button
                  onClick={clearAllHistory}
                  style={{
                    padding: "8px 14px",
                    fontSize: "0.85rem",
                    borderRadius: "8px",
                    border: "1px solid #f87171",
                    backgroundColor: "#0f172a",
                    color: "#f87171",
                    cursor: "pointer"
                  }}
                >
                  Clear All
                </button>
              )}
            </div>
          </div>

          {sorted.length === 0 ? (
            <p style={{ color: "#64748b", textAlign: "center", padding: "20px 0" }}>
              No readings logged yet.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #334155" }}>
                    <th style={{ textAlign: "left", padding: "10px 8px", color: "#94a3b8", fontSize: "0.8rem" }}>Time</th>
                    <th style={{ textAlign: "right", padding: "10px 8px", color: "#94a3b8", fontSize: "0.8rem" }}>Temp (°C)</th>
                    <th style={{ textAlign: "right", padding: "10px 8px", color: "#94a3b8", fontSize: "0.8rem" }}>Humidity (%)</th>
                    <th style={{ textAlign: "right", padding: "10px 8px", color: "#94a3b8", fontSize: "0.8rem" }}>Soil (%)</th>
                    <th style={{ textAlign: "right", padding: "10px 8px", color: "#94a3b8", fontSize: "0.8rem" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #1e293b" }}>
                      <td style={{ padding: "10px 8px", fontSize: "0.85rem" }}>{formatTime(r.timestamp)}</td>
                      <td style={{ padding: "10px 8px", fontSize: "0.85rem", textAlign: "right" }}>{r.temperature ?? "-"}</td>
                      <td style={{ padding: "10px 8px", fontSize: "0.85rem", textAlign: "right" }}>{r.humidity ?? "-"}</td>
                      <td style={{ padding: "10px 8px", fontSize: "0.85rem", textAlign: "right" }}>{r.soil ?? "-"}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>
                        <button
                          onClick={() => deleteReading(r.id)}
                          title="Delete this reading"
                          style={{
                            padding: "4px 10px",
                            fontSize: "0.75rem",
                            borderRadius: "6px",
                            border: "1px solid #475569",
                            backgroundColor: "transparent",
                            color: "#64748b",
                            cursor: "pointer"
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </main>
    </div>
  );
}