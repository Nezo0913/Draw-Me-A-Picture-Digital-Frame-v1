// ================= FIREBASE CDN IMPORTS =================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  onValue,
  push,
  remove,
  onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ================= CONFIG =================
const firebaseConfig = {
  apiKey: "AIzaSyDdfVC4M-1MXilGQBZFUlEEPYZFxXeJgU",
  authDomain: "drawme-v2.firebaseapp.com",
  databaseURL: "https://drawme-v2-default-rtdb.firebaseio.com",
  projectId: "drawme-v2",
  storageBucket: "drawme-v2.firebasestorage.app",
  messagingSenderId: "1032891705090",
  appId: "1:1032891705090:web:573d6a7bcca02f0b2b441b",
  measurementId: "G-M6QVYEQNKH"
};

// ================= INIT =================
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ================= EXPORTS =================
export {
  db,
  ref,
  set,
  get,
  update,
  onValue,
  push,
  remove,
  onDisconnect
};
