// src/CameraDashboard.jsx
import React from "react";
import { ref, set } from "firebase/database";
import { db } from "./firebase"; // Import the database connection we just made

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default function CameraDashboard() {

  // 1. Manual Motor Control
  const setMotorAngle = (angle) => {
    const angleRef = ref(db, 'camera/control/target_angle');
    set(angleRef, angle);
    console.log(`Motor turning to ${angle} degrees`);
  };

  // 2. Manual Picture Control
  const triggerPicture = async () => {
    const picRef = ref(db, 'camera/control/take_picture');
    set(picRef, true);
    console.log("Snap!");

    await sleep(2000);
    set(picRef, false);
  };

  // 3. Automated Scan: Turn -> Stop -> Snap
  const runAutoScan = async () => {
    console.log("Starting automated garden scan...");
    const anglesToScan = [0, 45, 90, 135, 180];

    for (let i = 0; i < anglesToScan.length; i++) {
      let currentAngle = anglesToScan[i];
      
      setMotorAngle(currentAngle);
      await sleep(3000); // Wait for physical motor to move
      await triggerPicture(); // Take picture
      await sleep(1000); // Brief pause before next turn
    }
    
    console.log("Automated scan complete! Returning to center.");
    setMotorAngle(90);
  };

  return (
    <div style={{ padding: "30px", fontFamily: "sans-serif" }}>
      <h2>Garden Camera & Motor Control</h2>
      
      <div style={{ marginBottom: "20px" }}>
        <h3>Manual Steering</h3>
        <button onClick={() => setMotorAngle(0)} style={{ marginRight: "10px" }}>0° (Left)</button>
        <button onClick={() => setMotorAngle(90)} style={{ marginRight: "10px" }}>90° (Center)</button>
        <button onClick={() => setMotorAngle(180)}>180° (Right)</button>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <h3>Actions</h3>
        <button onClick={triggerPicture} style={{ backgroundColor: "#2196F3", color: "white", padding: "10px", marginRight: "10px" }}>
          Take Single Picture
        </button>
        <button onClick={runAutoScan} style={{ backgroundColor: "#4CAF50", color: "white", padding: "10px" }}>
          Start Auto-Scan Sequence
        </button>
      </div>
    </div>
  );
}