// 明治就活サークル 運営ボード — 通知を送る処理
// GitHub Actions から5分ごとに起動され、次の2つを行います。
//  1. 朝の通知：「設定」タブの時刻を過ぎていて、その日まだ送っていなければ、担当業務がある人に1回だけ送る
//  2. 未対応事項の通知：まだ通知していない未対応事項があれば、追加した人以外の全員に送る（夜23時〜朝7時は朝まで待つ）
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

export function inQuietHours(now) { return now.time < "07:00" || now.time >= "23:00"; }
export function buildIssueMessages(issues, members) {
  // members: [{ id, name }]（有効なメンバー）。追加した本人には送らない
  const nameOf = id => (members.find(m => m.id === id) || {}).name || "メンバー";
  const out = [];
  for (const m of members) {
    const list = issues.filter(i => i.createdBy !== m.id);
    if (!list.length) continue;
    const mine = list.filter(i => (i.owners || []).includes(m.id));
    const title = list.length === 1 ? (mine.length ? "未対応事項（あなたが担当）" : "未対応事項が追加されました") : `未対応事項が${list.length}件追加されました`;
    const line = i => `${i.title}${i.due ? `（期限 ${Number(i.due.slice(5, 7))}/${Number(i.due.slice(8, 10))}）` : ""}`;
    const body = list.length === 1 ? `${line(list[0])}\n追加：${nameOf(list[0].createdBy)}` : list.slice(0, 4).map(i => "・" + line(i)).join("\n") + (list.length > 4 ? `\nほか${list.length - 4}件` : "") + (mine.length ? `\nうち${mine.length}件はあなたが担当` : "");
    out.push({ owner: m.id, title, body });
  }
  return out;
}

async function sendTo(db, fcm, uid, name, title, body, tag) {
  const toks = await db.collection(`members/${uid}/tokens`).get();
  if (toks.empty) { console.log(`- ${name}: 通知未登録`); return 0; }
  if (DRY) { console.log(`- ${name}: ${toks.size}台に「${title} / ${body.replace(/\n/g, " ／ ")}」`); return 0; }
  const res = await fcm.sendEachForMulticast({
    tokens: toks.docs.map(d => d.data().token),
    notification: { title, body },
    webpush: { fcmOptions: { link: SITE_URL }, notification: { icon: SITE_URL + "icon-192.png", badge: SITE_URL + "favicon.png", ...(tag ? { tag } : {}) } }
  });
  // 使われなくなった端末の登録は削除する
  await Promise.all(res.responses.map((r, i) => {
    const code = r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") return toks.docs[i].ref.delete();
  }));
  console.log(`- ${name}: 成功${res.successCount} 失敗${res.failureCount}`);
  return res.successCount;
}

async function issueNotify(db, fcm, cfg, now) {
  const snap = await db.collection("issues").where("notified", "==", false).get();
  if (snap.empty) { console.log("未対応事項：新しい追加なし"); return; }
  if (cfg.issueNotify === false) {
    // 通知がオフのときは、あとでオンにしたときにまとめて届かないよう「通知済み」にしておく
    if (!DRY) { const b = db.batch(); snap.docs.forEach(d => b.update(d.ref, { notified: true })); await b.commit(); }
    console.log(`未対応事項：${snap.size}件（通知オフのため送らない）`); return;
  }
  if (inQuietHours(now) && !FORCE) { console.log(`未対応事項：${snap.size}件（夜間のため朝7時以降に送る）`); return; }
  // 二重送信を防ぐため、先に「通知済み」を記録する
  if (!DRY) { const b = db.batch(); snap.docs.forEach(d => b.update(d.ref, { notified: true, notifiedAt: new Date().toISOString() })); await b.commit(); }
  const issues = snap.docs.map(d => d.data()).filter(i => !i.done);
  const ms = await db.collection("members").where("status", "==", "active").get();
  const members = ms.docs.map(d => ({ id: d.id, name: d.data().name || d.data().email || d.id }));
  const msgs = buildIssueMessages(issues, members);
  console.log(`未対応事項：${issues.length}件 → ${msgs.length}人に送信`);
  for (const m of msgs) await sendTo(db, fcm, m.owner, (members.find(x => x.id === m.owner) || {}).name, m.title, m.body, "issues");
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
  console.log(`JST ${now.date} ${now.time} / 朝の通知 設定 ${cfg.notifyTime || "07:30"} / 有効 ${cfg.notifyEnabled !== false} / 送信 ${go}`);
  if (go) {
    // 二重送信を防ぐため、先に「今日は送った」を記録する（手動テストでは記録しない）
    if (!FORCE && !DRY) await stateRef.set({ lastDate: now.date, at: new Date().toISOString() }, { merge: true });
    const tasksSnap = await db.collection("tasks").where("date", "==", now.date).get();
    const msgs = buildMessages(tasksSnap.docs.map(d => d.data()), now.date);
    console.log(`今日の担当者 ${msgs.length}人`);
    for (const m of msgs) {
      const mem = await db.doc(`members/${m.owner}`).get();
      if (!mem.exists || mem.data().status !== "active") continue;
      await sendTo(db, fcm, m.owner, mem.data().name || m.owner, m.title, m.body, "morning");
    }
  }
  await issueNotify(db, fcm, cfg, now);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch(e => { console.error(e); process.exit(1); });
}
