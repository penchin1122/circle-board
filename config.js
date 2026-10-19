// ===== 設定（手順は README.md） =====

// Firebaseコンソール →「プロジェクトの設定」→「マイアプリ」のウェブアプリに表示される値
export const firebaseConfig = {
  apiKey: "AIzaSyDBcK-Tv13ilCfBavx49JJ8E7HMrAUDSyg",
  authDomain: "meiji-circle-board.firebaseapp.com",
  projectId: "meiji-circle-board",
  storageBucket: "meiji-circle-board.firebasestorage.app",
  messagingSenderId: "564550558872",
  appId: "1:564550558872:web:5c3e516fce90c896719ced"
};

// 管理者（すべてを編集できる人）のGoogleアカウントのメールアドレス。
// firestore.rules の管理者アドレスと必ず同じにすること。
// ※ここは画面の出し分け用。実際の権限は firestore.rules が決めます。
export const ADMIN_EMAILS = ["satoakira.20060214@gmail.com"];
