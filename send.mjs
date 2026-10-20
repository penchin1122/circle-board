// 明治就活サークル 運営ボード — 朝の通知を送る処理
// GitHub Actions から15分ごとに起動され、「設定」タブの時刻を過ぎていて、
// その日まだ送っていなければ、担当業務がある人の端末に1回だけ通知を送ります。
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const SITE_URL = process.env.SITE_URL || "https://penchin1122.github.io/circle-board/";
const FORCE = process.env.FORCE === "true";      // 手動実行で「今すぐ送る」
const DRY = process.env.DRY_RUN === "true";      // 送らずに内容だけ表示
const TEST = process.env.TEST === "true";        // 管理者の端末にだけテスト通知を送る
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

export function jstNow(d = new Date()) {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return { date: `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`, time: `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}` };
}
export function shouldSend({ now, notifyTime = "07:30", enabled = true, lastDate, force = false }) {
  if (force) return true;
  if (enabled === false) return false;
  if (lastDate === now.date) return false;
  return now.time >= notifyTime && now.time < "12:00";
}
export function buildMessages(tasks, today) {
  const label = t => t.routine && t.routine !== "__other" ? t.routine : (t.detail || "業務");
  const time = t => !t.start ? "終日" : t.start + (t.end ? "–" + t.end : "〜");
  const by = {};
  const ownersOf = t => (Array.isArray(t.owners) && t.owners.length ? t.owners : (t.owner ? [t.owner] : []));
  tasks.filter(t => t.date === today && !t.done).forEach(t => ownersOf(t).forEach(o => (by[o] = by[o] || []).push(t)));
  return Object.entries(by).map(([owner, list]) => {
    list.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    const body = list.map(t => `${time(t)} ${label(t)}`).join("\n");
    return { owner, title: `今日の担当業務（${list.length}件）`, body };
  });
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!sa.project_id) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません");
  initializeApp({ credential: cert(sa) });
  const db = getFirestore(), fcm = getMessaging();
  if (TEST) {
    const ms = await db.collection("members").where("email", "==", ADMIN_EMAIL).get();
    if (ms.empty) throw new Error("管理者のメンバー情報が見つかりません（ADMIN_EMAIL を確認）");
    const toks = await ms.docs[0].ref.collection("tokens").get();
    if (toks.empty) { console.log("管理者の端末が通知に登録されていません。サイト右上のベルから登録してください。"); return; }
    const res = await fcm.sendEachForMulticast({ tokens: toks.docs.map(d => d.data().token), notification: { title: "通知のテスト", body: "運営ボードからの通知が届いています。" }, webpush: { fcmOptions: { link: SITE_URL }, notification: { icon: SITE_URL + "icon-192.png" } } });
    console.log(`テスト送信：成功${res.successCount} 失敗${res.failureCount}`);
    res.responses.forEach((r, i) => r.error && console.log(" -", r.error.code));
    return;
  }
  const cfgRef = db.doc("config/main"), stateRef = db.doc("config/notifyState");
  const [cfgSnap, stateSnap] = await Promise.all([cfgRef.get(), stateRef.get()]);
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const now = jstNow();
  const go = shouldSend({ now, notifyTime: cfg.notifyTime || "07:30", enabled: cfg.notifyEnabled, lastDate: stateSnap.exists ? stateSnap.data().lastDate : null, force: FORCE });
  console.log(`JST ${now.date} ${now.time} / 設定 ${cfg.notifyTime || "07:30"} / 有効 ${cfg.notifyEnabled !== false} / 送信 ${go}`);
  if (!go) return;

  // 二重送信を防ぐため、先に「今日は送った」を記録する（手動テストでは記録しない）
  if (!FORCE && !DRY) await stateRef.set({ lastDate: now.date, at: new Date().toISOString() }, { merge: true });

  const tasksSnap = await db.collection("tasks").where("date", "==", now.date).get();
  const msgs = buildMessages(tasksSnap.docs.map(d => d.data()), now.date);
  console.log(`今日の担当者 ${msgs.length}人`);
  let sent = 0, removed = 0;
  for (const m of msgs) {
    const mem = await db.doc(`members/${m.owner}`).get();
    if (!mem.exists || mem.data().status !== "active") continue;
    const toks = await db.collection(`members/${m.owner}/tokens`).get();
    if (toks.empty) { console.log(`- ${mem.data().name || m.owner}: 通知未登録`); continue; }
    if (DRY) { console.log(`- ${mem.data().name}: ${toks.size}台に「${m.title} / ${m.body.replace(/\n/g, " ／ ")}」`); continue; }
    const res = await fcm.sendEachForMulticast({
      tokens: toks.docs.map(d => d.data().token),
      notification: { title: m.title, body: m.body },
      webpush: { fcmOptions: { link: SITE_URL }, notification: { icon: SITE_URL + "icon-192.png", badge: SITE_URL + "favicon.png" } }
    });
    sent += res.successCount;
    // 使われなくなった端末の登録は削除する
    await Promise.all(res.responses.map((r, i) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") { removed++; return toks.docs[i].ref.delete(); }
    }));
    console.log(`- ${mem.data().name || m.owner}: 成功${res.successCount} 失敗${res.failureCount}`);
  }
  console.log(`送信 ${sent}件 / 無効な端末の削除 ${removed}件`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch(e => { console.error(e); process.exit(1); });
}
