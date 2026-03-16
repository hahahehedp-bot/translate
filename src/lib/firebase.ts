import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";

// TODO: Firebase 프로젝트 설정 값으로 교체 필요
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const isFirebaseConfigValid = firebaseConfig.apiKey !== "YOUR_API_KEY";

let auth: any;
let googleProvider: any;

if (isFirebaseConfigValid) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  googleProvider = new GoogleAuthProvider();
} else {
  console.warn("Firebase configuration is missing. Auth features will not work.");
}

export { auth, googleProvider };

export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Login Error:", error);
    throw error;
  }
};

export const logout = () => signOut(auth);
