// 朝の通知を受け取るためのファイル（ブラウザがバックグラウンドで動かします）
// 値は config.js の firebaseConfig と同じです（公開されても問題のない値です）
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDBcK-Tv13ilCfBavx49JJ8E7HMrAUDSyg",
  authDomain: "meiji-circle-board.firebaseapp.com",
  projectId: "meiji-circle-board",
  storageBucket: "meiji-circle-board.firebasestorage.app",
  messagingSenderId: "564550558872",
  appId: "1:564550558872:web:5c3e516fce90c896719ced"
});

// 通知の表示とタップ時の動作はFirebaseが自動で行う（送信側で notification を付けて送るため）
firebase.messaging();

// 通知をタップしたときに開くページは、送信側の webpush.fcmOptions.link で指定する
