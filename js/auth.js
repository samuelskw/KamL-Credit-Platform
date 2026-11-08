/* Firebase-backed login + cloud profiles for KamL Credit.
 * Requires a configured Firebase project, email/password Authentication,
 * Cloud Firestore, and the rules in firestore.rules.
 * The config in firebase-config.js contains PUBLIC client identifiers.
 * This is a teaching prototype, not a production banking system.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const configured = Boolean(
  firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE_") &&
  firebaseConfig.projectId && firebaseConfig.projectId !== "YOUR_PROJECT_ID" &&
  firebaseConfig.appId && !firebaseConfig.appId.startsWith("PASTE_") &&
  firebaseConfig.authDomain && !firebaseConfig.authDomain.includes("YOUR_PROJECT_ID")
);
const setupMessage = "Firebase is not configured yet. Paste your Firebase web app configuration into js/firebase-config.js (see README.md).";
const app = configured ? initializeApp(firebaseConfig) : null;
const auth = configured ? getAuth(app) : null;
const db = configured ? getFirestore(app) : null;
let saveQueue = Promise.resolve();

function requireSetup() {
  if (!configured) throw new Error(setupMessage);
}

function helpfulError(err) {
  const code = err && err.code;
  const messages = {
    "auth/email-already-in-use": "An account with that email address already exists. Please log in.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Choose a stronger password (at least 8 characters).",
    "auth/invalid-credential": "Incorrect email address or password.",
    "auth/user-not-found": "Incorrect email address or password.",
    "auth/wrong-password": "Incorrect email address or password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "auth/operation-not-allowed": "Enable Email/Password in Firebase Authentication > Sign-in method.",
    "auth/unauthorized-domain": "Add this website's domain to Firebase Authentication > Settings > Authorized domains.",
    "permission-denied": "Firestore access was denied. Publish the rules in firestore.rules.",
    "firestore/permission-denied": "Firestore access was denied. Publish the rules in firestore.rules."
  };
  return new Error(messages[code] || (err && err.message) || "An unknown Firebase error occurred.");
}

const KamLAuth = {
  available: () => configured,
  setupMessage,
  email: () => (auth && auth.currentUser ? auth.currentUser.email : null),

  async register(email, password) {
    requireSetup();
    if (String(password).length < 8) throw new Error("Use a password of at least 8 characters.");
    try {
      await createUserWithEmailAndPassword(auth, String(email).trim(), password);
    } catch (err) { throw helpfulError(err); }
  },

  async login(email, password) {
    requireSetup();
    try {
      await signInWithEmailAndPassword(auth, String(email).trim(), password);
    } catch (err) { throw helpfulError(err); }
  },

  // Called when the app opens, registers, logs in, or logs out.
  // Firebase Auth automatically remembers the signed-in user on reload.
  onSessionChanged(callback) {
    if (!configured) {
      queueMicrotask(() => callback(null));
      return () => {};
    }
    return onAuthStateChanged(auth, callback, err => callback(null, helpfulError(err)));
  },

  // One profile document per UID. Never use an email address as the doc ID.
  async load() {
    requireSetup();
    const user = auth.currentUser;
    if (!user) throw new Error("Log in first to retrieve your profile.");
    try {
      const record = await getDoc(doc(db, "profiles", user.uid));
      return record.exists() ? record.data().profile || null : null;
    } catch (err) { throw helpfulError(err); }
  },

  // Capture a snapshot and serialize writes; the latest edit wins.
  save(profile) {
    try { requireSetup(); } catch (err) { return Promise.reject(err); }
    const user = auth.currentUser;
    if (!user) return Promise.reject(new Error("Log in first to save your profile."));
    const snapshot = JSON.parse(JSON.stringify(profile));
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      if (!auth.currentUser || auth.currentUser.uid !== user.uid) {
        throw new Error("Your login changed before the profile could be saved.");
      }
      try {
        await setDoc(doc(db, "profiles", user.uid), {
          profile: snapshot,
          updatedAt: serverTimestamp()
        });
      } catch (err) { throw helpfulError(err); }
    });
    return saveQueue;
  },

  async logout() {
    requireSetup();
    await saveQueue.catch(() => {});
    try { await signOut(auth); }
    catch (err) { throw helpfulError(err); }
  }
};

window.KamLAuth = KamLAuth;
// app.js is loaded by index.html after this module, so the app (and guest
// mode) still starts if Firebase cannot be downloaded.
