// src/firebase.js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBI0M_IbK294nLJn_SOOEngGO91e0nhdT4",
  authDomain: "iigs-sp.firebaseapp.com",
  databaseURL: "https://iigs-sp-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "iigs-sp",
  storageBucket: "iigs-sp.firebasestorage.app",
  messagingSenderId: "865294253827",
  appId: "1:865294253827:web:f1257c5a7bd7c19b19b336"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);