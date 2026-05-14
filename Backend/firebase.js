import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDdfVC4M-1MXilG4BQZFUlEEPYZFxXeJgU",
  authDomain: "drawme-v2.firebaseapp.com",
  databaseURL: "https://drawme-v2-default-rtdb.firebaseio.com",
  projectId: "drawme-v2",
  storageBucket: "drawme-v2.firebasestorage.app",
  messagingSenderId: "1032891705090",
  appId: "1:1032891705090:web:573d6a7bcca02f0b2b441b",
  measurementId: "G-M6QVYEQNKH"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
