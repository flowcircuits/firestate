import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

// Replace with your Firebase project configuration
// Get this from: Firebase Console > Project Settings > Your apps > Config
const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
