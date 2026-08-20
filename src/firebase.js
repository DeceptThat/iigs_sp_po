// src/firebase.js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  // Use your exact database URL from your ESP32 code
  databaseURL: "https://iigs-sp-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "iigs-sp"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);