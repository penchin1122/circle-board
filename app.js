import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, FieldPath, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken, deleteToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { firebaseConfig, ADMIN_EMAILS } from "./config.js";

/* ================= utilities ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const ym = d => d.getFullYear() + "-" + pad(d.getMonth() + 1);
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d || 1); };
const today = new Date(); today.setHours(0, 0, 0, 0);
const TODAY = ymd(today), THISMONTH = ym(today);
const yen = n => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
const num = n => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString("ja-JP");
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const md = s => { if (!s) return ""; const d = parse(s); return (d.getMonth() + 1) + "/" + d.getDate() + "(" + DOW[d.getDay()] + ")"; };
const monthLabel = m => { const [y, mm] = m.split("-"); return y + "年" + Number(mm) + "月"; };
const shiftMonth = (m, k) => { const d = parse(m + "-01"); d.setMonth(d.getMonth() + k); return ym(d); };
const mondayOf = d => { const x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
// 定例ミーティング：毎月 第2・第4木曜日。KPIの進捗はこの2回の時点で入力する
function meetingsOfMonth(m) {
  const first = parse(m + "-01"); const off = (4 - first.getDay() + 7) % 7; // 最初の木曜日
  const y = first.getFullYear(), mo = first.getMonth();
  return [ymd(new Date(y, mo, 1 + off + 7)), ymd(new Date(y, mo, 1 + off + 21)), ymd(new Date(y, mo + 1, 0))]; // 第2木・第4木・月末
}
const NEXTMTG = [...meetingsOfMonth(THISMONTH), ...meetingsOfMonth(shiftMonth(THISMONTH, 1))].find(x => x >= TODAY);
const mtgLabel = d => { const mt = meetingsOfMonth(d.slice(0, 7)); return mt[0] === d ? "第2木" : mt[1] === d ? "第4木" : "月末"; };
const mtgName = d => mtgLabel(d) === "月末" ? "月末" : "MTG";
const ls = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
/* トースト：type = "success" | "error" | "info" | "warn"。同時に出すのは1つだけ（新しいものが前のものと入れ替わる） */
const TOAST_ICON = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
  warn: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>'
};
function toast(msg, type = "success", opts = {}) {
  const box = $("#toasts"); if (!box) return;
  const el = document.createElement("div");
  el.className = "toast t-" + type; el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `<svg class="t-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICON[type] || TOAST_ICON.info}</svg><span class="t-msg"></span>${opts.action ? `<button type="button" class="t-act"></button>` : ""}<button type="button" class="t-x" aria-label="閉じる">×</button>`;
  el.querySelector(".t-msg").textContent = msg;
  const close = () => { if (el.dataset.closing) return; el.dataset.closing = "1"; el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  if (opts.action) { const b = el.querySelector(".t-act"); b.textContent = opts.action.label; b.addEventListener("click", () => { close(); opts.action.run(); }); }
  el.querySelector(".t-x").addEventListener("click", close);
  [...box.children].forEach(c => c.remove());
  box.appendChild(el);
  const ms = opts.duration || (type === "error" ? 6000 : opts.action ? 5000 : 2800);
  let timer = setTimeout(close, ms);
  el.addEventListener("pointerenter", () => clearTimeout(timer));
  el.addEventListener("pointerleave", () => { timer = setTimeout(close, 1500); });
}
function errMsg(e) {
  const c = e && e.code || "";
  if (c.includes("permission-denied")) return "この操作をする権限がありません。";
  if (c.includes("unavailable")) return "通信できませんでした。電波の良い場所でもう一度試してください。";
  return "うまくいきませんでした（" + (c || "不明なエラー") + "）。もう一度試してください。";
}

/* ================= firebase ================= */
const configured = !!firebaseConfig.apiKey && !!firebaseConfig.projectId;
let auth, db, fbApp;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app); fbApp = app;
}

const DEFAULTS = {
  routines: ["毎回の募集", "メンター依頼", "場所取り", "スケジュール管理", "活動記録", "インスタ投稿", "LINE対応", "口座・支出管理", "メンバー管理", "GD講習会運営"],
  incomeCats: ["入会費", "イベント参加費", "協賛・スポンサー", "その他"],
  expenseCats: ["会場費", "広告・宣伝費", "メンター謝礼", "飲食費", "ツール・サブスク", "その他"],
  methods: ["現金", "PayPay", "銀行振込", "クレジット"]
};
// 毎月デフォルトで用意するKPI（管理者がその月を初めて開いたときに自動で追加）
const DEFAULT_KPIS = [
  { key: "ig-follow", name: "インスタフォロー営業数", unit: "件", mode: "sum" },
  { key: "ig-followers", name: "インスタフォロワー数", unit: "人", mode: "latest", track: true },
  { key: "line-reach", name: "公式LINEリーチ数", unit: "人", mode: "latest", track: true },
  { key: "trial", name: "体験参加者数", unit: "人", mode: "sum" },
  { key: "join", name: "入会者数", unit: "人", mode: "sum" }
];
const KPI_TEMPLATES = DEFAULT_KPIS;

const TABS_ALL = [["home", "ホーム"], ["kpi", "KPI"], ["cal", "業務カレンダー"], ["forms", "フォーム"], ["money", "収支"], ["admin", "管理（メンバー・設定）"]];
const TAB_ICON = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  kpi: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  forms: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  money: '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/><path d="M6 9.5v.01M18 15.5v.01"/>',
  admin: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M17 4.5a3.5 3.5 0 0 1 0 7M19 14.8c1.3.9 2.2 2.6 2.5 5.2"/>'
};
const S = {
  user: null, member: null, isAdmin: false, dataKey: "",
  members: [], config: null, tasks: [], kpis: [], ledger: [],
  ready: {}, need: [],
  tab: "home", adminSub: "members", forms: [], kpiMonth: THISMONTH, calMonth: THISMONTH, selDay: TODAY, moneyMonth: THISMONTH,
  onlyMine: ls.get("cb_onlymine", "0") === "1"
};
let memberUnsub = null, dataUnsubs = [];
const cfg = () => Object.assign({}, DEFAULTS, S.config || {});
const uid = () => S.user && S.user.uid;
const isActive = () => S.isAdmin || (S.member && S.member.status === "active");
const ROLES = [["sub", "副管理者"], ["member", "メンバー"], ["viewer", "閲覧のみ"]];
const ROLE_HELP = { sub: "KPIの設定・すべての業務の編集ができる", member: "業務の登録と、自分の担当KPIの入力ができる", viewer: "見るだけ（登録・入力はできない）" };
const roleOf = m => (m && ROLES.some(([k]) => k === m.role)) ? m.role : "member";
const myRole = () => S.isAdmin ? "admin" : roleOf(S.member);
const isSub = () => myRole() === "sub";
const canManage = () => S.isAdmin || isSub();          // KPIの設定・すべての業務の編集
const canWrite = () => myRole() !== "viewer";          // 業務の登録・自分の担当分の入力
const roleLabel = r => ({ admin: "管理者", sub: "副管理者", member: "メンバー", viewer: "閲覧のみ" })[r] || "メンバー";
const rolePill = r => r === "member" ? "" : `<span class="pill ${r === "viewer" ? "plain" : "info"}">${roleLabel(r)}</span>`;
const canFinance = () => S.isAdmin || (isActive() && S.member && S.member.finance === true);
const activeMembers = () => S.members.filter(m => m.status === "active").sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
const memName = id => { const m = S.members.find(x => x.id === id); return m ? (m.name || m.email || "名前未設定") : "（不明）"; };
const MEMBER_COLORS = ["#1E5FC4", "#0E8A82", "#C27A12", "#C2417A", "#6B4FC2", "#4A7A2A", "#D2462F", "#2E86B8", "#8A5A3C", "#5B6578"];
const mColor = id => {
  const m = S.members.find(x => x.id === id);
  if (m && m.color && /^#[0-9A-Fa-f]{6}$/.test(m.color)) return m.color;
  const i = activeMembers().findIndex(x => x.id === id);
  return i < 0 ? "var(--muted)" : MEMBER_COLORS[i % MEMBER_COLORS.length];
};
const whoTag = id => `<span class="who" style="--mc:${mColor(id)}"><i></i>${esc(memName(id))}</span>`;
const tabsVisible = () => TABS_ALL.filter(([k]) => (k !== "money" || canFinance()) && (k !== "admin" || S.isAdmin));

/* ================= auth & data lifecycle ================= */
function stopData() { dataUnsubs.forEach(u => u()); dataUnsubs = []; S.ready = {}; S.need = []; S.tasks = []; S.kpis = []; S.ledger = []; S.members = []; S.config = null; }
function resetAll() { if (memberUnsub) { memberUnsub(); memberUnsub = null; } stopData(); S.member = null; S.isAdmin = false; S.dataKey = ""; }

if (configured) {
  getRedirectResult(auth).catch(e => console.warn(e));
  onAuthStateChanged(auth, async u => {
    resetAll(); S.user = u; S.authReady = true;
    if (!u) { render(); return; }
    S.isAdmin = !!u.email && ADMIN_EMAILS.map(e => e.toLowerCase()).includes(u.email.toLowerCase());
    const ref = doc(db, "members", u.uid);
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        // 管理者が先に招待していれば、その内容（表示名・色・収支閲覧）で自動的に利用開始
        let inv = null;
        if (!S.isAdmin && u.email) { try { const is = await getDoc(doc(db, "invites", u.email.toLowerCase())); if (is.exists()) inv = is.data(); } catch (e) { } }
        const base = { email: u.email || "", createdAt: serverTimestamp() };
        if (S.isAdmin) await setDoc(ref, { ...base, name: u.displayName || u.email || "", status: "active", finance: true });
        else if (inv) await setDoc(ref, { ...base, name: inv.name, status: "active", finance: !!inv.finance, role: roleOf(inv), ...(inv.color ? { color: inv.color } : {}) });
        else await setDoc(ref, { ...base, name: u.displayName || u.email || "", status: "pending", finance: false });
      }
    } catch (e) { S.fatal = errMsg(e); render(); return; }
    memberUnsub = onSnapshot(ref, s => {
      S.member = s.exists() ? s.data() : null;
      const key = isActive() ? "on|" + (canFinance() ? "f" : "-") + "|" + myRole() : "off";
      if (key !== S.dataKey) { stopData(); S.dataKey = key; if (key !== "off") startData(); }
      render();
    }, e => { S.fatal = errMsg(e); render(); });
  });
}

function listen(key, ref, fn) {
  S.need.push(key);
  dataUnsubs.push(onSnapshot(ref, snap => { fn(snap); S.ready[key] = true; render(); }, e => { console.warn(key, e); S.ready[key] = true; render(); }));
}
const docsOf = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
function startData() {
  if (notifyOn()) setTimeout(bindForeground, 0);
  listen("members", collection(db, "members"), s => S.members = docsOf(s));
  listen("config", doc(db, "config", "main"), s => S.config = s.exists() ? s.data() : null);
  listen("tasks", collection(db, "tasks"), s => S.tasks = docsOf(s));
  listen("forms", collection(db, "forms"), s => S.forms = docsOf(s));
  listen("issues", collection(db, "issues"), s => S.issues = docsOf(s));
  if (S.isAdmin) listen("invites", collection(db, "invites"), s => S.invites = docsOf(s));
  if (canManage()) listen("kpis", collection(db, "kpis"), s => S.kpis = docsOf(s));
  else {
    // 一般メンバーは「全員に公開」「自分に公開」「自分が担当」のKPIだけを取得（ルール上それ以外は読めない）
    const parts = {};
    const merge = () => { const m = {}; Object.values(parts).forEach(a => a.forEach(k => m[k.id] = k)); S.kpis = Object.values(m); };
    [["viewers", "array-contains", "all"], ["viewers", "array-contains", uid()], ["owner", "==", uid()]].forEach((w, i) =>
      listen("kpis" + i, query(collection(db, "kpis"), where(...w)), s => { parts[i] = docsOf(s); merge(); }));
  }
  if (canFinance()) listen("ledger", collection(db, "ledger"), s => S.ledger = docsOf(s));
}

async function login() {
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) return signInWithRedirect(auth, p);
    if (e && e.code === "auth/popup-closed-by-user") return;
    toast(errMsg(e), "error");
  }
}

/* ================= KPI math ================= */
function kpiActual(k) {
  const w = k.weekly || {}; const keys = Object.keys(w).filter(x => w[x] && w[x].value !== null && w[x].value !== undefined && w[x].value !== "").sort();
  if (!keys.length) return { v: 0, has: false };
  if (k.mode === "latest") return { v: Number(w[keys[keys.length - 1]].value) || 0, has: true };
  return { v: keys.reduce((a, x) => a + (Number(w[x].value) || 0), 0), has: true };
}
function monthElapsed(m) {
  if (m < THISMONTH) return 1; if (m > THISMONTH) return 0;
  return today.getDate() / new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
}
function kpiStatus(k) {
  const a = kpiActual(k), t = Number(k.target) || 0, rate = t > 0 ? a.v / t : 0, el = monthElapsed(k.month);
  let st;
  if (!(t > 0)) st = { c: "plain", t: "目標未設定" };
  else if (k.month > THISMONTH) st = { c: "plain", t: "未開始" };
  else if (rate >= 1) st = { c: "good", t: "達成" };
  else if (k.month < THISMONTH) st = { c: "bad", t: "未達" };
  else if (!a.has) st = { c: "plain", t: "未報告" };
  else if (rate >= el * 0.9) st = { c: "info", t: "順調" };
  else st = { c: "warn", t: "遅れ" };
  return { a, t, rate, el, st };
}
/* 「記録のみ」のKPI：目標・達成率・ゲージを出さず、最新値と前回からの増減だけを見る */
const TRACK_NAMES = DEFAULT_KPIS.filter(d => d.track).map(d => d.name);
const isTrack = k => k.track === true || (k.track === undefined && TRACK_NAMES.includes(k.name));
function trackInfo(k) {
  const pts = []; const pushPts = (kk, label) => { const w = kk.weekly || {}; meetingsOfMonth(kk.month).forEach(d => { const e = w[d]; if (e && e.value !== null && e.value !== undefined && e.value !== "") pts.push({ d, v: Number(e.value), label }); }); };
  const prev = S.kpis.find(x => x.month === shiftMonth(k.month, -1) && x.name === k.name); if (prev) pushPts(prev, "先月");
  pushPts(k, "");
  const cur = pts.filter(p => p.d.slice(0, 7) === k.month);
  const last = cur[cur.length - 1] || null; const idx = last ? pts.indexOf(last) : -1; const before = idx > 0 ? pts[idx - 1] : null;
  return { last, before, delta: last && before ? last.v - before.v : null };
}
const deltaTag = (t, unit) => t.delta === null ? "" : `<span class="delta ${t.delta > 0 ? "up" : t.delta < 0 ? "down" : ""}">${t.delta > 0 ? "+" : t.delta < 0 ? "−" : "±"}${num(Math.abs(t.delta))}${esc(unit || "")}</span>`;
const sinceLabel = t => t.before ? `${t.before.d.slice(0, 7) !== t.last.d.slice(0, 7) ? "先月" : ""}${mtgLabel(t.before.d)}（${md(t.before.d)}）から` : "";
const viewersLabel = k => (!k.viewers || k.viewers.includes("all")) ? "全員に公開" : "公開：" + k.viewers.map(memName).join("・");
function kpiRow(k, withEdit) {
  const tools = withEdit && canManage() ? ` <button class="link" type="button" data-act="kpi-edit" data-id="${esc(k.id)}">編集</button> <button class="link" type="button" style="color:var(--bad)" data-act="kpi-del" data-id="${esc(k.id)}">${S.armDel === k.id ? "本当に削除する（もう一度押す）" : "削除"}</button>` : "";
  if (isTrack(k)) {
    const t = trackInfo(k);
    return `<div class="kpi track">
    <div class="name">${esc(k.name)} <span class="pill plain">記録のみ</span>${tools}</div>
    <div class="nums">${t.last ? `<b>${cu(t.last.v, "num")}</b>` : `<b class="muted">—</b>`}${Number(k.target) > 0 ? ` / ${num(k.target)}` : ""}${esc(k.unit || "")} ${t.last ? deltaTag(t, k.unit) : `<span class="muted" style="font-size:.8rem">未記録</span>`}</div>
    <div class="meta"><span>担当：${whoTag(k.owner)}</span>${t.last ? `<span>${mtgLabel(t.last.d)}（${md(t.last.d)}）時点</span>` : ""}${t.delta !== null ? `<span>${esc(sinceLabel(t))}の増減</span>` : ""}${canManage() ? `<span>${esc(viewersLabel(k))}</span>` : ""}</div>
  </div>`;
  }
  const s = kpiStatus(k); const w = Math.min(100, s.rate * 100);
  const cls = s.st.c === "good" ? "good" : (s.st.c === "warn" || s.st.c === "bad") ? "warn" : "";
  const pace = k.month === THISMONTH ? `<span class="pace" style="left:${(s.el * 100).toFixed(1)}%" title="今日時点の目安ペース"></span>` : "";
  return `<div class="kpi">
    <div class="name">${esc(k.name)} <span class="pill ${s.st.c}">${s.st.t}</span>${tools}</div>
    <div class="nums">${s.t > 0 ? `<b>${cu(s.a.v, "num")}</b> / ${num(s.t)}${esc(k.unit || "")} <span class="muted">（${Math.round(s.rate * 100)}%）</span>` : `<b>${num(s.a.v)}</b>${esc(k.unit || "")} <span class="muted">／ 目標未設定</span>`}</div>
    <div class="meter"><i class="${cls}" style="width:${w}%"></i>${pace}</div>
    <div class="meta"><span>担当：${whoTag(k.owner)}</span><span>${k.mode === "latest" ? "最新値で集計" : "MTG・月末ごとの合計で集計"}</span>${k.month === THISMONTH && s.t > 0 ? `<span>今日時点の目安：${num(s.t * s.el)}${esc(k.unit || "")}</span>` : ""}${canManage() ? `<span>${esc(viewersLabel(k))}</span>` : ""}</div>
  </div>`;
}

/* ================= task helpers ================= */
const sharedAll = t => !t.shareWith || !t.shareWith.length || t.shareWith.includes("all");
const ownersOf = t => (Array.isArray(t.owners) && t.owners.length ? t.owners : (t.owner ? [t.owner] : []));
const isMine = t => ownersOf(t).includes(uid());
const whoTags = t => ownersOf(t).map(whoTag).join(" ") || `<span class="muted" style="font-size:.8rem">担当未定</span>`;
const ownerDots = t => ownersOf(t).map(o => `<i class="od" style="--mc:${mColor(o)}"></i>`).join("");
const relevant = t => sharedAll(t) || isMine(t) || (t.shareWith || []).includes(uid()) || t.createdBy === uid();
const canEditTask = t => canManage() || (t.createdBy === uid() && canWrite());
const canToggleTask = t => canEditTask(t) || (isMine(t) && canWrite());
const taskTitle = t => t.routine && t.routine !== "__other" ? t.routine : (t.detail || "（内容未記入）");
const timeLabel = t => !t.start ? "終日" : esc(t.start) + (t.end ? "–" + esc(t.end) : "〜");
const sortTasks = (a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || ""));
function taskItem(t, opts = {}) {
  const sw = sharedAll(t) ? "全員に共有" : "共有：" + t.shareWith.map(memName).join("・");
  const late = opts.late ? `<span class="pill bad">${daysBetween(t.date, TODAY)}日遅れ</span> ` : "";
  const sub = [opts.showDate ? md(t.date) : "", t.routine && t.routine !== "__other" && t.detail ? t.detail : "", sw, "登録：" + memName(t.createdBy)].filter(Boolean).join(" ／ ");
  return `<div class="task${t.done ? " done" : ""}" style="--mc:${mColor(ownersOf(t)[0])}">
    <div class="time">${timeLabel(t)}</div>
    <div><div class="what">${late}${esc(taskTitle(t))}</div><div class="whos">${whoTags(t)}</div></div>
    <div class="acts">${canToggleTask(t) ? `<label><input type="checkbox" data-act="task-done" data-id="${esc(t.id)}" ${t.done ? "checked" : ""}>完了</label>` : (t.done ? `<span class="pill good">完了</span>` : "")}<button class="link" type="button" data-act="task-open" data-id="${esc(t.id)}">${canEditTask(t) ? "編集" : "詳細"}</button></div>
    <div class="sub">${esc(sub)}</div>
  </div>`;
}
const sumBy = (rows, type) => rows.filter(r => r.type === type).reduce((a, r) => a + (Number(r.amount) || 0), 0);

/* ================= render ================= */
/* ===== アニメーション ===== */
/* ハンバーガーメニュー（左から出るドロワー） */
function setMenu(open) {
  const d = $("#drawer"), bg = $("#drawer-bg"), b = $("#menu-btn"); if (!d) return;
  d.classList.toggle("open", open); bg.classList.toggle("open", open); document.body.classList.toggle("menu-open", open);
  if (open) { d.removeAttribute("inert"); b.setAttribute("aria-expanded", "true"); setTimeout(() => { const c = d.querySelector('[aria-current="page"]') || d.querySelector("button"); if (c) c.focus({ preventScroll: true }); }, 60); }
  else { d.setAttribute("inert", ""); b.setAttribute("aria-expanded", "false"); if (d.contains(document.activeElement)) b.focus({ preventScroll: true }); }
}
document.addEventListener("click", e => {
  if (e.target.closest("#menu-btn")) { setMenu(!$("#drawer").classList.contains("open")); return; }
  if (e.target.closest("#drawer-bg") || e.target.closest('[data-menu="close"]')) setMenu(false);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#drawer").classList.contains("open")) setMenu(false); });
function countUp(el) {
  const to = Number(el.dataset.v); const fmt = el.dataset.f; if (!isFinite(to)) return;
  const sign = el.dataset.sign || ""; const t0 = performance.now(), dur = 700;
  const show = v => el.textContent = sign + (fmt === "yen" ? yen(v) : num(v));
  const step = now => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); show(to * e); if (p < 1) requestAnimationFrame(step); else show(to); };
  show(0); requestAnimationFrame(step);
}
function runEnter(main, kind) {
  main.classList.remove("anim-in", "anim-l", "anim-r"); void main.offsetWidth;
  main.classList.add(kind === "l" ? "anim-l" : kind === "r" ? "anim-r" : "anim-in");
  main.querySelectorAll(".bar, .panel, .fig, .kpi, .task, .cal, .tablewrap tbody tr, .empty, .listedit .row, .legend").forEach((el, i) => el.style.setProperty("--i", Math.min(i, 14)));
  main.querySelectorAll(".cu").forEach(countUp);
  clearTimeout(runEnter.t); runEnter.t = setTimeout(() => main.classList.remove("anim-in", "anim-l", "anim-r"), 1100);
}
const cu = (v, f, sign = "") => `<span class="cu" data-v="${Math.abs(Number(v) || 0)}" data-f="${f}" data-sign="${sign}">${sign}${f === "yen" ? yen(Math.abs(v)) : num(v)}</span>`;
function renderChrome() {
  const tools = $("#mast-tools"), tabs = $("#tabs"), foot = $("#drawer-foot"), mb = $("#menu-btn");
  if (!S.user || !isActive()) {
    tabs.innerHTML = ""; foot.innerHTML = ""; mb.hidden = true; setMenu(false);
    tools.innerHTML = S.user ? `<span class="me">${esc(S.user.email || "")}</span><button class="ghost" type="button" data-act="logout">ログアウト</button>` : "";
    return;
  }
  const vis = tabsVisible(); if (!vis.some(([k]) => k === S.tab)) S.tab = "home";
  const pending = S.isAdmin ? S.members.filter(m => m.status === "pending").length : 0;
  mb.hidden = false;
  tabs.innerHTML = vis.map(([k, l]) => `<button type="button" data-tab="${k}" ${k === S.tab ? 'aria-current="page"' : ""}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICON[k] || ""}</svg><span>${l}</span>${k === "admin" && pending ? `<span class="badge">${pending}</span>` : ""}</button>`).join("");
  mb.classList.toggle("has-badge", pending > 0);
  const meName = memName(uid()) !== "（不明）" ? memName(uid()) : (S.user.displayName || "");
  foot.innerHTML = `<div class="df-me"><b>${esc(meName)}</b><span class="muted">${esc(roleLabel(myRole()))}・${esc(S.user.email || "")}</span></div><button class="btn sec small" type="button" data-act="logout">ログアウト</button>`;
  const cur = TABS_ALL.find(([k]) => k === S.tab);
  tools.innerHTML = `<span class="me cur-page">${esc(cur ? cur[1].replace(/（.*）/, "") : "")}</span><button class="ghost" type="button" data-act="notify" aria-label="通知の設定" title="通知の設定"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>${notifyOn() ? "" : `<span class="dot-off"></span>`}</button>`;
}
function render() {
  renderChrome();
  const main = $("#main");
  if (!configured) { main.innerHTML = `<div class="center"><h2>初期設定が必要です</h2><p class="muted">config.js にFirebaseの設定値を入れてください。手順は README.md にあります。</p></div>`; return; }
  if (S.fatal) { main.innerHTML = `<div class="center"><h2>読み込めませんでした</h2><p class="muted">${esc(S.fatal)}</p></div>`; return; }
  if (!S.authReady) { main.innerHTML = skeleton(S.tab); return; }
  if (!S.user) {
    main.innerHTML = `<div class="center"><h2>運営メンバー専用ページです</h2><p class="muted">Googleアカウントでログインしてください。はじめての方は、ログイン後に管理者の承認を受けると使えるようになります。</p>
      <p><button class="gbtn" type="button" data-act="login"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.5-9.5 6.5-16.1z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.4v5.7C8 41 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.7 28.1c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.4C2.9 17.2 2 20.5 2 24s.9 6.8 2.4 9.8l7.3-5.7z"/><path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8 7 4.4 14.2l7.3 5.7c1.7-5.2 6.6-9.1 12.3-9.1z"/></svg>Googleでログイン</button></p></div>`;
    return;
  }
  if (!S.member && !S.isAdmin) { main.innerHTML = skeleton(S.tab); return; }
  if (!isActive()) {
    const stopped = S.member && S.member.status === "inactive";
    main.innerHTML = `<div class="center"><h2>${stopped ? "利用が停止されています" : "承認待ちです"}</h2><p class="muted">${stopped ? "管理者に確認してください。" : `管理者（佐藤）が承認すると、このページが使えるようになります。承認されたら自動で切り替わります。`}</p><p class="muted" style="font-size:.85rem">ログイン中：${esc(S.user.email || "")}</p></div>`;
    return;
  }
  if (!S.need.length || !S.need.every(k => S.ready[k])) { if (!main.querySelector(".sk-wrap")) main.innerHTML = skeleton(S.tab); return; }
  const views = { home: vHome, kpi: vKpi, cal: vCal, forms: vForms, money: vMoney, admin: vAdmin };
  if (S.tab === "admin" && S.adminSub === "settings" && (S.settingsDirty || S.dragging) && main.querySelector("[data-list]")) return;
  const prevScroll = window.scrollY;
  const anim = S.anim || (main.querySelector(".sk-wrap") ? "in" : null); S.anim = null;
  main.innerHTML = views[S.tab]();
  if (anim && !reducedMotion()) runEnter(main, anim);
  if (S.pulse) { const el = main.querySelector(S.pulse); S.pulse = null; if (el && !reducedMotion()) { el.classList.remove("pulse-in"); void el.offsetWidth; el.classList.add("pulse-in"); } }
  if (S.isAdmin) { setTimeout(() => { seedMonth(THISMONTH); if (S.tab === "kpi") seedMonth(S.kpiMonth); }, 0); }
  window.scrollTo(0, prevScroll);
}
const seeding = new Set();
async function seedMonth(m) {
  if (!S.isAdmin || m < THISMONTH || seeding.has(m)) return;
  const seeded = (S.config && S.config.kpiSeeded) || [];
  if (seeded.includes(m)) return;
  seeding.add(m);
  const cur = S.kpis.filter(k => k.month === m), prev = S.kpis.filter(k => k.month === shiftMonth(m, -1));
  const b = writeBatch(db); let n = 0;
  DEFAULT_KPIS.forEach((d, i) => {
    if (cur.some(k => k.name === d.name)) return;
    const p = prev.find(k => k.name === d.name);
    b.set(doc(db, "kpis", m + "-" + d.key), { name: d.name, unit: d.unit, mode: d.mode, track: p ? isTrack(p) : !!d.track, target: p ? p.target : null, owner: p ? p.owner : uid(), viewers: p ? (p.viewers || ["all"]) : ["all"], month: m, weekly: {}, order: i + 1, createdAt: serverTimestamp() }); n++;
  });
  // 空の月なら、先月に追加していた独自のKPIも目標ごと引き継ぐ
  if (!cur.length) prev.filter(k => !DEFAULT_KPIS.some(d => d.name === k.name)).forEach((k, i) => {
    b.set(doc(collection(db, "kpis")), { name: k.name, unit: k.unit || "", mode: k.mode, track: isTrack(k), target: k.target ?? null, owner: k.owner, viewers: k.viewers || ["all"], month: m, weekly: {}, order: 100 + i, createdAt: serverTimestamp() }); n++;
  });
  b.set(doc(db, "config", "main"), { kpiSeeded: arrayUnion(m) }, { merge: true });
  try { await b.commit(); if (n) toast(monthLabel(m) + "のKPIを" + n + "件用意しました。目標を設定してください", "info", { duration: 5000 }); }
  catch (e) { seeding.delete(m); console.warn(e); }
}
/* スケルトン：読み込み中に、実際のレイアウトに近い形のグレーの枠を出す */
const sk = (w, h = 14, extra = "") => `<span class="sk" style="width:${w};height:${h}px;${extra}"></span>`;
const skLines = n => Array.from({ length: n }, (_, i) => `<div class="sk-row">${sk("4.5em")}<div class="sk-col">${sk(["70%", "55%", "62%"][i % 3])}${sk("38%", 10)}</div></div>`).join("");
const skPanel = (rows, title = "40%") => `<section class="panel" aria-hidden="true"><div style="margin-bottom:14px">${sk(title, 16)}</div>${skLines(rows)}</section>`;
const skKpi = n => Array.from({ length: n }, () => `<div class="kpi">${sk("45%", 16)}${sk("5em", 16)}<div style="grid-column:1/-1">${sk("100%", 10, "border-radius:5px")}</div>${sk("60%", 10)}</div>`).join("");
function skeleton(tab) {
  const head = `<div class="bar" aria-hidden="true">${sk("8em", 24)}<span style="margin-left:auto"></span>${sk("9em", 34, "border-radius:6px")}</div>`;
  let body;
  if (tab === "kpi") body = `<section class="panel">${skKpi(5)}</section>`;
  else if (tab === "cal") body = `<div class="callayout"><div class="cal sk-cal">${Array.from({ length: 35 }, () => `<div class="day">${sk("1.2em", 12)}</div>`).join("")}</div>${skPanel(3, "30%")}</div>`;
  else if (tab === "money") body = `<div class="figs">${Array.from({ length: 4 }, () => `<div class="fig">${sk("40%", 11)}<div style="margin-top:8px">${sk("70%", 22)}</div></div>`).join("")}</div>${skPanel(5, "25%")}`;
  else if (tab === "admin" || tab === "forms") body = `<div class="grid2">${skPanel(4)}${skPanel(4)}</div>`;
  else body = `<div class="grid2"><div class="stack">${skPanel(2, "35%")}${skPanel(1, "45%")}</div><div class="stack"><section class="panel">${sk("35%", 16)}<div style="margin-top:14px">${skKpi(3)}</div></section></div></div>`;
  return `<div class="sk-wrap" role="status" aria-label="読み込み中">${head}${body}<span class="visually-hidden">読み込み中です</span></div>`;
}
function monthNav(key) { return `<div class="monthnav"><button type="button" data-act="mprev" data-k="${key}" aria-label="前の月">‹</button><span>${monthLabel(S[key])}</span><button type="button" data-act="mnext" data-k="${key}" aria-label="次の月">›</button></div>`; }

function vHome() {
  const mine = S.tasks.filter(t => t.date === TODAY && (isMine(t) || sharedAll(t) || (t.shareWith || []).includes(uid()))).sort(sortTasks);
  const myOpen = mine.filter(t => !t.done).length;
  const overdue = S.tasks.filter(t => sharedAll(t) && !t.done && t.date < TODAY).sort(sortTasks);
  const issues = S.issues || [];
  const openIssues = issues.filter(i => !i.done).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const doneIssues = issues.filter(i => i.done).sort((a, b) => (b.doneAt?.seconds || 0) - (a.doneAt?.seconds || 0)).slice(0, 20);
  const myLate = S.tasks.filter(t => !sharedAll(t) && isMine(t) && !t.done && t.date < TODAY).sort(sortTasks);
  const ks = S.kpis.filter(k => k.month === THISMONTH).sort((a, b) => (a.order || 0) - (b.order || 0));
  const untilMtg = daysBetween(TODAY, NEXTMTG);
  const mtgKpis = S.kpis.filter(k => k.month === NEXTMTG.slice(0, 7));
  const myKpiNoReport = untilMtg <= 7 && canWrite() ? mtgKpis.filter(k => k.owner === uid() && !((k.weekly || {})[NEXTMTG] && (k.weekly || {})[NEXTMTG].value !== null)) : [];
  let fin = "";
  if (canFinance()) {
    const mrows = S.ledger.filter(r => (r.date || "").startsWith(THISMONTH));
    const inc = sumBy(mrows, "収入"), exp = sumBy(mrows, "支出"), bal = sumBy(S.ledger, "収入") - sumBy(S.ledger, "支出");
    const uns = S.ledger.filter(r => r.settled === "未精算").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    fin = `<section class="panel"><h3>お金<button class="link hint" type="button" data-act="go" data-tab="money">収支を開く</button></h3>
      <div class="figs" style="margin-bottom:8px"><div class="fig"><div class="k">今月の収支</div><div class="v ${inc - exp >= 0 ? "pos" : "neg"}">${cu(inc - exp, "yen", inc - exp >= 0 ? "+" : "−")}</div></div><div class="fig"><div class="k">現在の残高</div><div class="v">${cu(bal, "yen", bal < 0 ? "−" : "")}</div></div></div>
      <div class="muted" style="font-size:.8rem;font-weight:700">未精算の立替 ${uns.length}件</div>
      ${uns.length ? uns.map(r => `<div class="row3"><span>${md(r.date)}</span><span>${esc(r.title)}（${esc(r.owner || "")}）</span><span>${yen(r.amount)}</span></div>`).join("") : `<p class="muted" style="margin:0;font-size:.85rem">ありません。</p>`}</section>`;
  }
  return `<div class="bar"><h2>${md(TODAY)}</h2><span class="muted">${esc(memName(uid()))}さん</span></div>
  <div class="grid2">
    <div class="stack">
      <section class="panel"><h3>今日やること<span class="hint">${myOpen ? `残り${myOpen}件` : mine.length ? "すべて完了" : ""}</span></h3>
        ${mine.length ? mine.map(t => taskItem(t)).join("") : `<p class="muted" style="margin:0">今日の業務はありません。</p>`}
        ${myKpiNoReport.length ? `<div class="banner" style="margin:12px 0 0">${untilMtg === 0 ? "今日" : untilMtg === 1 ? "明日" : untilMtg + "日後"}の${mtgName(NEXTMTG) === "月末" ? "月末締め" : "MTG"}（${md(NEXTMTG)}）までにKPIの報告をお願いします：${myKpiNoReport.map(k => esc(k.name)).join("、")} <button class="link" type="button" data-act="go" data-tab="kpi">入力する</button></div>` : ""}
      </section>
      <section class="panel"><h3>未対応（全体共有）<span class="hint">${openIssues.length + overdue.length}件</span>${canWrite() ? `<button class="btn small" type="button" data-act="issue-new">＋ 追加</button>` : ""}</h3>
        ${openIssues.length ? openIssues.map(issueItem).join("") : ""}
        ${overdue.length ? `<div class="sub-head">期限を過ぎた業務</div>` + overdue.map(t => taskItem(t, { late: true, showDate: true })).join("") : ""}
        ${!openIssues.length && !overdue.length ? `<p class="muted" style="margin:0">未対応の事項はありません。${canWrite() ? "気づいたことは「＋ 追加」で登録できます。" : ""}</p>` : ""}
        ${doneIssues.length ? `<button class="link done-toggle" type="button" data-act="issue-showdone">${S.showDoneIssues ? "完了済みを隠す" : `完了済み ${doneIssues.length}件を表示`}</button>${S.showDoneIssues ? `<div class="done-list">${doneIssues.map(issueItem).join("")}</div>` : ""}` : ""}
      </section>
      ${myLate.length ? `<section class="panel"><h3>自分の未対応<span class="hint">${myLate.length}件</span></h3>${myLate.map(t => taskItem(t, { late: true, showDate: true })).join("")}</section>` : ""}
    </div>
    <div class="stack">
      <section class="panel"><h3>今月のKPI<button class="link hint" type="button" data-act="go" data-tab="kpi">詳しく見る</button></h3>
        ${ks.length ? ks.map(k => kpiRow(k, false)).join("") : `<p class="muted" style="margin:0">${canManage() ? "今月のKPIはまだ設定されていません。" : "表示できる今月のKPIはありません。"}</p>`}
      </section>
      ${fin}
    </div>
  </div>`;
}

function vKpi() {
  const m = S.kpiMonth; const ks = S.kpis.filter(k => k.month === m).sort((a, b) => (a.order || 0) - (b.order || 0));
  const weeks = meetingsOfMonth(m); const prev = S.kpis.filter(k => k.month === shiftMonth(m, -1));
  const head = `<div class="bar"><h2>KPI</h2>${monthNav("kpiMonth")}${canManage() ? `<button class="btn" type="button" data-act="kpi-new">KPIを追加</button>` : ""}</div>`;
  if (!ks.length) {
    if (!canManage()) return head + `<div class="empty"><p>${monthLabel(m)}に表示できるKPIはありません。</p></div>`;
    return head + `<div class="empty"><p>${monthLabel(m)}の月次目標はまだありません。</p>
      ${prev.length ? `<p><button class="btn sec" type="button" data-act="kpi-carry">先月のKPI（${prev.length}件）を引き継ぐ</button></p>` : ""}
      <p class="muted" style="font-size:.85rem">指標を追加する：</p>
      <div class="tpls">${KPI_TEMPLATES.map((t, i) => `<button class="btn sec small" type="button" data-act="kpi-tpl" data-i="${i}">${esc(t.name)}</button>`).join("")}</div></div>`;
  }
  const rows = ks.map(k => {
    const w = k.weekly || {}; const s = kpiStatus(k); const editable = canManage() || (k.owner === uid() && canWrite());
    return `<tr><td><b>${esc(k.name)}</b><div class="muted" style="font-size:.75rem">${esc(memName(k.owner))}・${k.mode === "latest" ? "最新値" : "合計"}</div></td>
      ${weeks.map(wk => { const v = w[wk] && w[wk].value !== null && w[wk].value !== undefined ? w[wk].value : "";
        return `<td class="num${wk === NEXTMTG ? " now" : ""}">${editable ? `<input class="cell" id="c-${esc(k.id)}-${wk}" type="number" inputmode="decimal" step="any" aria-label="${esc(k.name)} ${mtgLabel(wk)} ${md(wk)}" data-act="kpi-cell" data-id="${esc(k.id)}" data-wk="${wk}" value="${esc(v)}">` : (v === "" ? `<span class="muted">—</span>` : num(v))}</td>`; }).join("")}
      ${isTrack(k) ? (() => { const t = trackInfo(k); return `<td class="num">${t.last ? `<b>${num(t.last.v)}</b>` : "—"}${Number(k.target) > 0 ? ` / ${num(k.target)}` : ""}</td><td>${t.delta !== null ? deltaTag(t, k.unit) : `<span class="pill plain">記録のみ</span>`}</td>`; })()
        : `<td class="num"><b>${num(s.a.v)}</b> / ${s.t > 0 ? num(s.t) : "—"}</td><td><span class="pill ${s.st.c}">${s.t > 0 ? Math.round(s.rate * 100) + "%" : "目標未設定"}</span></td>`}</tr>`;
  }).join("");
  return head + `<div class="stack">
    <section class="panel"><h3>月次目標の進捗<span class="hint">縦線は今日時点の目安ペース</span></h3>${ks.filter(k => !isTrack(k)).map(k => kpiRow(k, true)).join("") || `<p class="muted" style="margin:0">目標を設定しているKPIはありません。</p>`}</section>
    ${ks.some(isTrack) ? `<section class="panel"><h3>記録のみの指標<span class="hint">最新値／目標と、前回からの増減</span></h3><div class="track-grid">${ks.filter(isTrack).map(k => kpiRow(k, true)).join("")}</div></section>` : ""}
    <section><h3 style="font-size:.95rem;margin:0 0 8px">ミーティング・月末ごとの進捗</h3>
      <p class="muted" style="font-size:.82rem;margin:0 0 8px">第2・第4木曜日の定例MTGと月末の3回、各KPIの担当者が実績を入力します。入力すると自動で保存されます。「最新値」はその時点の数値（例：会員数）、「合計」は前回から増えた分を入れてください（第2木＝月初から、第4木＝第2木の翌日から、月末＝第4木の翌日から月末まで）。</p>
      <div class="tablewrap"><table><thead><tr><th>指標</th>${weeks.map(wk => `<th class="num${wk === NEXTMTG ? " now" : ""}">${mtgLabel(wk)} ${md(wk).replace(/\(.\)/, "")}${wk === NEXTMTG ? "<br>次回" : ""}</th>`).join("")}<th class="num">実績 / 目標</th><th>達成率・増減</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section></div>`;
}

function vCal() {
  const m = S.calMonth; const first = parse(m + "-01"); const start = mondayOf(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const endGrid = new Date(last); endGrid.setDate(endGrid.getDate() + (6 - (last.getDay() + 6) % 7));
  const vis = S.onlyMine ? S.tasks.filter(t => isMine(t) || (t.shareWith || []).includes(uid()) || t.createdBy === uid()) : S.tasks.filter(relevant);
  const byDay = {}; vis.forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });
  let cells = ["月", "火", "水", "木", "金", "土", "日"].map(d => `<div class="dow">${d}</div>`).join("");
  for (let d = new Date(start); d <= endGrid; d.setDate(d.getDate() + 1)) {
    const k = ymd(d); const list = (byDay[k] || []).sort(sortTasks);
    const cls = ["day", ym(d) !== m ? "out" : "", k === TODAY ? "today" : "", k === S.selDay ? "sel" : ""].join(" ");
    cells += `<button type="button" class="${cls}" data-act="day" data-d="${k}" aria-label="${md(k)} 予定${list.length}件">
      <span class="d"><span>${d.getDate()}</span></span>
      ${list.slice(0, 3).map(t => `<span class="chip${t.done ? " done" : ""}" style="--mc:${mColor(ownersOf(t)[0])}">${ownersOf(t).length > 1 ? `<span class="chip-dots">${ownerDots(t)}</span>` : ""}${esc(t.start || "")} ${esc(taskTitle(t))}</span>`).join("")}
      ${list.length > 3 ? `<span class="more">ほか${list.length - 3}件</span>` : ""}
      <span class="dots">${list.map(t => `<i style="--mc:${mColor(ownersOf(t)[0])}"></i>`).join("")}</span></button>`;
  }
  const dayList = (byDay[S.selDay] || []).sort(sortTasks);
  return `<div class="bar"><h2>業務カレンダー</h2>
    <label class="muted" style="font-size:.85rem;display:flex;gap:6px;align-items:center"><input type="checkbox" id="onlymine" data-act="onlymine" ${S.onlyMine ? "checked" : ""}>自分に関係する業務だけ</label>
    ${monthNav("calMonth")}${canWrite() ? `<button class="btn" type="button" data-act="task-new">業務を登録</button>` : `<span class="pill plain">閲覧のみ</span>`}</div>
  <div class="callayout">
    <div class="stack"><div class="cal">${cells}</div>
      <div class="legend">${activeMembers().map(m => whoTag(m.id)).join("")}</div></div>
    <section class="panel day-panel"><h3>${md(S.selDay)}${S.selDay === TODAY ? "　今日" : ""}${canWrite() ? `<button class="btn small" style="margin-left:auto" type="button" data-act="task-new" data-d="${S.selDay}">この日に登録</button>` : ""}</h3>
      ${dayList.length ? dayList.map(t => taskItem(t)).join("") : `<p class="muted" style="margin:0">この日の業務はありません。</p>`}
    </section>
  </div>`;
}

function vMoney() {
  const m = S.moneyMonth; const rows = S.ledger.filter(r => (r.date || "").startsWith(m)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const inc = sumBy(rows, "収入"), exp = sumBy(rows, "支出");
  const upto = S.ledger.filter(r => (r.date || "").slice(0, 7) <= m);
  const bal = sumBy(upto, "収入") - sumBy(upto, "支出");
  const group = type => { const o = {}; rows.filter(r => r.type === type).forEach(r => o[r.category || "その他"] = (o[r.category || "その他"] || 0) + (Number(r.amount) || 0)); return o; };
  const cats = group("支出"), icats = group("収入");
  const maxC = Math.max(1, ...Object.values(cats), ...Object.values(icats));
  const bars = (o, cls) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="hbar ${cls}"><span>${esc(k)}</span><span class="track"><i style="width:${(v / maxC * 100).toFixed(1)}%"></i></span><span class="val">${yen(v)}</span></div>`).join("");
  const stPill = s => s === "未精算" ? `<span class="pill warn">未精算</span>` : s === "精算済" ? `<span class="pill good">精算済</span>` : `<span class="pill plain">${esc(s || "対象外")}</span>`;
  return `<div class="bar"><h2>収支</h2>${monthNav("moneyMonth")}${S.isAdmin ? `<button class="btn sec" type="button" data-act="led-import">CSVを取り込む</button><button class="btn" type="button" data-act="led-new">収支を記録</button>` : `<span class="pill plain">閲覧のみ</span>`}</div>
  <div class="figs">
    <div class="fig"><div class="k">収入</div><div class="v pos">${cu(inc, "yen")}</div></div>
    <div class="fig"><div class="k">支出</div><div class="v neg">${cu(exp, "yen")}</div></div>
    <div class="fig"><div class="k">月の収支</div><div class="v ${inc - exp >= 0 ? "pos" : "neg"}">${cu(inc - exp, "yen", inc - exp >= 0 ? "+" : "−")}</div></div>
    <div class="fig"><div class="k">月末時点の残高</div><div class="v">${cu(bal, "yen", bal < 0 ? "−" : "")}</div></div>
  </div>
  <div class="stack">
    ${rows.length ? `<div class="tablewrap"><table class="ledger-table"><thead><tr><th>日付</th><th>項目</th><th>区分</th><th>カテゴリ</th><th class="num">金額</th><th>担当者</th><th>支払方法</th><th>精算</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${S.isAdmin ? "click" : ""}" ${S.isAdmin ? `data-act="led-edit" data-id="${esc(r.id)}" tabindex="0"` : ""}><td class="c-date">${md(r.date)}</td><td class="c-title" style="white-space:normal;min-width:12em">${esc(r.title)}${r.memo ? `<div class="muted" style="font-size:.75rem">${esc(r.memo)}</div>` : ""}</td><td class="c-meta"><span class="pill ${r.type === "収入" ? "good" : "bad"}">${esc(r.type)}</span></td><td class="c-meta">${esc(r.category || "")}</td><td class="num c-amt ${r.type === "収入" ? "pos" : "neg"}">${r.type === "収入" ? "+" : "−"}${yen(r.amount)}</td><td class="c-meta">${esc(r.owner || "")}</td><td class="c-meta">${esc(r.method || "")}</td><td class="c-meta">${stPill(r.settled)}</td><td class="c-sub">${esc([r.category, r.owner, r.method].filter(Boolean).join("・"))} ${stPill(r.settled)}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty"><p>${monthLabel(m)}の記録はありません。</p>${S.isAdmin ? `<button class="btn small" type="button" data-act="led-new">記録を追加</button>` : ""}</div>`}
    ${rows.length ? `<div class="grid2"><section class="panel"><h3>支出の内訳</h3>${Object.keys(cats).length ? bars(cats, "out") : `<p class="muted" style="margin:0">支出はありません。</p>`}</section>
      <section class="panel"><h3>収入の内訳</h3>${Object.keys(icats).length ? bars(icats, "") : `<p class="muted" style="margin:0">収入はありません。</p>`}</section></div>` : ""}
  </div>`;
}

const SITE_URL = location.origin + location.pathname.replace(/index\.html$/, "");
const inviteText = name => `${name ? name + "さん、" : ""}明治就活サークルの運営ボードに追加しました。\n下のURLを開いて「Googleでログイン」してください（追加したGmailアドレスのアカウントでログインしてください）。\n${SITE_URL}\nスマホならSafari（AndroidはChrome）で開いて「ホーム画面に追加」すると、アプリのように使えます。`;
function inviteDialog() {
  const body = fld("Gmailアドレス", `<input type="email" name="email" id="f-email" required autocomplete="off" placeholder="例：yamada.taro@gmail.com">`, { full: true, req: true, help: "その人がログインに使うGoogleアカウントのアドレス" }) +
    fld("表示名", `<input name="name" id="f-name" required placeholder="例：山田">`, { req: true, help: "カレンダーやKPIに出る名前" }) +
    `<div class="field"><span class="lbl">色</span><div class="swatches" role="radiogroup" aria-label="色">${MEMBER_COLORS.map((c, i) => `<label class="sw-pick"><input type="radio" name="color" id="f-color-${i}" value="${c}" ${i === activeMembers().length % MEMBER_COLORS.length ? "checked" : ""}><span class="swatch" style="background:${c}" title="${c}"></span></label>`).join("")}</div></div>` +
    `<div class="field full"><span class="lbl">権限</span><div class="role-pick">${ROLES.map(([k, l]) => `<label class="role-opt"><input type="radio" name="role" id="f-role-${k}" value="${k}" ${k === "member" ? "checked" : ""}><span><b>${l}</b><small>${ROLE_HELP[k]}</small></span></label>`).join("")}</div></div>` +
    `<div class="field full"><label class="checks" style="font-size:.88rem"><input type="checkbox" name="finance" id="f-finance" value="1">収支を見られるようにする（閲覧のみ）</label></div>`;
  openDlg("メンバーを追加", body, {
    submit: async f => {
      const email = (f.email || "").trim().toLowerCase(); const name = (f.name || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showErr("メールアドレスの形式が正しくありません。"), false;
      if (!name) return showErr("表示名を入力してください。"), false;
      const data = { name, color: f.color || null, finance: !!f.finance, role: roleOf({ role: f.role }) };
      const existing = S.members.find(m => (m.email || "").toLowerCase() === email);
      if (existing) {
        await updateDoc(doc(db, "members", existing.id), { ...data, status: "active" });
        return existing.status === "pending" ? name + "さんを承認しました（すでにログイン済みでした）" : name + "さんの設定を更新しました";
      }
      await setDoc(doc(db, "invites", email), { ...data, createdAt: serverTimestamp() });
      closeDlg();
      toast(name + "さんを追加しました。案内文をLINEなどで送ってください", "success", { duration: 8000, action: { label: "案内文をコピー", run: () => copyText(inviteText(name)) } });
      return false;
    }
  });
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast("案内文をコピーしました"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("案内文をコピーしました"); } catch (_) { toast("コピーできませんでした", "error"); } ta.remove(); }
}
function vAdmin() {
  const sub = S.adminSub === "settings" ? "settings" : "members";
  const pending = S.members.filter(m => m.status === "pending").length;
  const sw = `<div class="seg seg-lg" role="tablist" aria-label="管理"><label><input type="radio" name="adminsub" id="adm-members" value="members" data-act="adm-sub" ${sub === "members" ? "checked" : ""}><span>メンバー${pending ? `<span class="badge">${pending}</span>` : ""}</span></label><label><input type="radio" name="adminsub" id="adm-settings" value="settings" data-act="adm-sub" ${sub === "settings" ? "checked" : ""}><span>設定</span></label></div>`;
  return `<div class="adm-head">${sw}</div>` + (sub === "settings" ? vSettings() : vMembers());
}
/* ===== フォーム：外部に送るGoogleフォームのリンク集 ===== */
const safeUrl = u => /^https:\/\/[^\s"'<>]+$/i.test(u || "") ? u : "";
const formShareText = f => (f.message ? f.message.trim() + "\n" : "") + f.url;
function vForms() {
  const list = [...(S.forms || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const head = `<div class="bar"><h2>フォーム</h2>${canManage() ? `<button class="btn" type="button" data-act="form-new">フォームを追加</button>` : ""}</div>
    <p class="muted" style="font-size:.85rem;margin:-8px 0 14px">新入生や参加者に送るGoogleフォームのリンク集です。「案内文をコピー」でLINEやインスタのDMに貼り付けて送れます。</p>`;
  if (!list.length) return head + `<div class="empty"><p>まだフォームが登録されていません。</p>${canManage() ? `<button class="btn small" type="button" data-act="form-new">最初のフォームを追加</button>` : `<p class="muted">管理者が追加すると、ここに表示されます。</p>`}</div>`;
  return head + `<div class="form-grid">${list.map((f, i) => `<article class="panel form-card">
      <div class="fc-head"><h3>${esc(f.name)}</h3>${canManage() ? `<span class="fc-tools"><button class="icon-btn" type="button" data-act="form-up" data-id="${esc(f.id)}" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button><button class="icon-btn" type="button" data-act="form-down" data-id="${esc(f.id)}" aria-label="下へ" ${i === list.length - 1 ? "disabled" : ""}>↓</button><button class="link" type="button" data-act="form-edit" data-id="${esc(f.id)}">編集</button></span>` : ""}</div>
      ${f.desc ? `<p class="fc-desc">${esc(f.desc)}</p>` : ""}
      ${f.message ? `<div class="fc-msg"><span class="lbl">送るときの文面</span><p>${esc(f.message)}</p></div>` : ""}
      <div class="fc-url">${esc(f.url)}</div>
      <div class="fc-acts"><button class="btn" type="button" data-act="form-copy" data-id="${esc(f.id)}">${f.message ? "案内文をコピー" : "リンクをコピー"}</button>${f.message ? `<button class="btn sec" type="button" data-act="form-copy-url" data-id="${esc(f.id)}">リンクだけ</button>` : ""}<a class="btn sec" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">開く</a>${canManage() && safeUrl(f.respUrl) ? `<a class="link" href="${esc(safeUrl(f.respUrl))}" target="_blank" rel="noopener">回答を見る</a>` : ""}</div>
    </article>`).join("")}</div>`;
}
function formDialog(fm) {
  const v = fm || { name: "", url: "", desc: "", message: "", respUrl: "" };
  const body = fld("フォームの名前", `<input name="name" id="f-name" required value="${esc(v.name)}" placeholder="例：体験参加申込フォーム">`, { full: true, req: true }) +
    fld("フォームのURL", `<input name="url" id="f-url" type="url" required value="${esc(v.url)}" placeholder="https://forms.gle/…">`, { full: true, req: true, help: "Googleフォームの「送信」→リンクのアイコンで出るURL（短縮URLでOK）" }) +
    fld("説明（運営向けメモ）", `<input name="desc" id="f-desc" value="${esc(v.desc || "")}" placeholder="例：体験会の申込受付用。毎回の告知で使う">`, { full: true }) +
    fld("送るときの文面（任意）", `<textarea name="message" id="f-message" placeholder="例：体験会のお申し込みはこちらからお願いします！">${esc(v.message || "")}</textarea>`, { full: true, help: "入れておくと「案内文をコピー」で、この文面とURLがまとめてコピーされます" }) +
    fld("回答を見るURL（任意）", `<input name="respUrl" id="f-respUrl" type="url" value="${esc(v.respUrl || "")}" placeholder="回答のスプレッドシートやフォームの編集画面のURL">`, { full: true, help: "管理者・副管理者だけに「回答を見る」として表示されます" });
  openDlg(fm ? "フォームを編集" : "フォームを追加", body, {
    submit: async f => {
      const url = (f.url || "").trim(), respUrl = (f.respUrl || "").trim();
      if (!safeUrl(url)) return showErr("URLは https:// から始まる形で入れてください。"), false;
      if (respUrl && !safeUrl(respUrl)) return showErr("回答を見るURLは https:// から始まる形で入れてください。"), false;
      const data = { name: f.name.trim(), url, desc: f.desc.trim(), message: f.message.trim(), respUrl };
      if (!data.name) return showErr("フォームの名前を入力してください。"), false;
      if (fm) await updateDoc(doc(db, "forms", fm.id), data);
      else { data.order = Date.now(); data.createdAt = serverTimestamp(); await addDoc(collection(db, "forms"), data); S.anim = "in"; }
    },
    del: fm ? () => deleteDoc(doc(db, "forms", fm.id)) : null
  });
}
async function moveForm(id, dir) {
  const list = [...(S.forms || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const i = list.findIndex(f => f.id === id), j = i + dir; if (i < 0 || j < 0 || j >= list.length) return;
  const b = writeBatch(db); const oi = list[i].order || i, oj = list[j].order || j;
  b.update(doc(db, "forms", list[i].id), { order: oj === oi ? oi + dir : oj }); b.update(doc(db, "forms", list[j].id), { order: oi });
  await b.commit();
}
async function copyPlain(t, msg) {
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast(msg); } catch (_) { toast("コピーできませんでした", "error"); } ta.remove(); }
}
function vMembers() {
  const list = [...S.members].sort((a, b) => ({ pending: 0, active: 1, inactive: 2 }[a.status] ?? 3) - ({ pending: 0, active: 1, inactive: 2 }[b.status] ?? 3) || (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const st = s => s === "active" ? `<span class="pill good">利用中</span>` : s === "pending" ? `<span class="pill warn">承認待ち</span>` : `<span class="pill plain">停止中</span>`;
  const invites = (S.invites || []).filter(iv => !S.members.some(m => (m.email || "").toLowerCase() === iv.id)).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  return `<div class="bar"><h2>メンバー</h2><button class="btn" type="button" data-act="inv-new">メンバーを追加</button></div>
  <p class="muted" style="font-size:.85rem;margin:-8px 0 14px">「拒否」「利用停止」にした人は「削除」で名簿から消せます。消した人がもう一度ログインした場合は、また「承認待ち」で表示されます。「メンバーを追加」でGmailアドレスを登録しておくと、その人がGoogleでログインした瞬間に、承認なしで使えるようになります。登録していない人がログインした場合は「承認待ち」で表示されます。</p>
  ${invites.length ? `<section class="panel" style="margin-bottom:16px"><h3>追加済み・まだログインしていない人<span class="hint">${invites.length}人</span></h3>
    ${invites.map(iv => `<div class="inv-row"><span class="who" style="--mc:${iv.color || "var(--muted)"}"><i></i><b>${esc(iv.name)}</b></span><span class="muted inv-mail">${esc(iv.id)}</span>${rolePill(roleOf(iv))}${iv.finance ? `<span class="pill info">収支閲覧</span>` : ""}<span class="sp"></span><button class="btn sec small" type="button" data-act="inv-copy" data-id="${esc(iv.id)}">案内文をコピー</button><button class="link" type="button" style="color:var(--bad)" data-act="inv-del" data-id="${esc(iv.id)}">${S.armDel === "inv:" + iv.id ? "本当に取り消す" : "取り消す"}</button></div>`).join("")}
  </section>` : ""}
  <div class="tablewrap"><table class="members-table"><thead><tr><th>表示名</th><th>色</th><th>Googleアカウント</th><th>状態</th><th>権限</th><th>収支の閲覧</th><th></th></tr></thead><tbody>
  ${list.map(m => { const self = m.id === uid(); return `<tr>
    <td><input class="name-in" id="mn-${esc(m.id)}" value="${esc(m.name || "")}" data-act="mem-name" data-id="${esc(m.id)}" aria-label="表示名"></td>
    <td><div class="swatches" role="group" aria-label="${esc(m.name || "")}の色">${MEMBER_COLORS.map(c => `<button type="button" class="swatch" style="background:${c}" data-act="mem-color" data-id="${esc(m.id)}" data-c="${c}" aria-label="色 ${c}" aria-pressed="${mColor(m.id) === c}"></button>`).join("")}</div></td>
    <td>${esc(m.email || "")}</td><td>${st(m.status)}</td>
    <td>${self ? `<span class="muted">管理者</span>` : `<select class="role-sel" id="mr-${esc(m.id)}" data-act="mem-role" data-id="${esc(m.id)}" aria-label="${esc(m.name || "")}の権限">${ROLES.map(([k, l]) => `<option value="${k}" ${roleOf(m) === k ? "selected" : ""}>${l}</option>`).join("")}</select>`}</td>
    <td>${self ? `<span class="muted">管理者</span>` : `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="mf-${esc(m.id)}" data-act="mem-fin" data-id="${esc(m.id)}" ${m.finance ? "checked" : ""}>見られる</label>`}</td>
    <td>${self ? "" : m.status === "pending" ? `<button class="btn small" type="button" data-act="mem-status" data-id="${esc(m.id)}" data-v="active">承認する</button> <button class="btn sec small" type="button" data-act="mem-status" data-id="${esc(m.id)}" data-v="inactive">拒否</button>` : m.status === "active" ? `<button class="btn sec small" type="button" data-act="mem-status" data-id="${esc(m.id)}" data-v="inactive">利用停止</button>` : `<button class="btn sec small" type="button" data-act="mem-status" data-id="${esc(m.id)}" data-v="active">再開する</button> <button class="btn small ${S.armDel === "mem:" + m.id ? "danger" : "sec danger-sec"}" type="button" data-act="mem-del" data-id="${esc(m.id)}">${S.armDel === "mem:" + m.id ? "本当に削除する" : "削除"}</button>`}</td></tr>`; }).join("")}
  </tbody></table></div>
  <div class="role-legend"><b>権限の違い</b><ul>${ROLES.map(([k, l]) => `<li><b>${l}</b>：${ROLE_HELP[k]}</li>`).join("")}<li><b>管理者（佐藤）</b>：上記すべて＋メンバー管理・設定・収支の編集</li></ul><span class="muted">「収支の閲覧」は権限とは別に、1人ずつ選べます（編集は管理者だけ）。</span></div>`;
}

const rowHTML = (key, i, x, label) => `<div class="row"><button type="button" class="handle" aria-label="並べ替え（↑↓キーで移動）" title="ドラッグして並べ替え"><svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true" fill="currentColor"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button><input id="s-${key}-${i}" value="${esc(x)}" aria-label="${esc(label || "項目")}"><button class="btn sec small" type="button" data-rm>外す</button></div>`;
function markDirty() { S.settingsDirty = true; const h = document.getElementById("save-hint"); if (h) h.hidden = false; }
function notifyTimeSelect(cur) {
  const opts = []; for (let h = 5; h <= 10; h++) for (const m of [0, 15, 30, 45]) opts.push(pad(h) + ":" + pad(m));
  return `<select id="s-notifyTime">${opts.map(o => `<option ${o === cur ? "selected" : ""}>${o}</option>`).join("")}</select>`;
}
function vSettings() {
  const c = cfg();
  const list = (key, items, label) => `<section class="panel"><h3>${label}</h3><div class="listedit" data-list="${key}">${items.map((x, i) => rowHTML(key, i, x, label)).join("")}</div><button class="link" type="button" data-add="${key}" style="margin-top:8px">＋ 追加</button></section>`;
  return `<div class="bar"><h2>設定</h2><span class="pill warn" id="save-hint" ${S.settingsDirty ? "" : "hidden"}>未保存の変更があります</span><button class="btn" type="button" data-act="save-settings">保存</button></div>
    <p class="muted" style="font-size:.82rem;margin:-8px 0 14px">左の点のつまみをドラッグすると並び順を変えられます（キーボードではつまみを選んで↑↓キー）。この順番で業務登録や収支の選択肢に表示されます。</p>
    <section class="panel" style="margin-bottom:16px"><h3>朝の通知</h3>
      <div class="dlg-b" style="padding:0">
        <div class="field"><label class="checks" style="font-size:.9rem"><input type="checkbox" id="s-notifyEnabled" ${c.notifyEnabled === false ? "" : "checked"}>担当業務がある日の朝に通知を送る</label></div>
        <div class="field"><span class="lbl">送る時間</span>${notifyTimeSelect(c.notifyTime || "07:30")}<span class="help">実際に届くのは、この時刻から15分ほど遅れることがあります</span></div>
        <div class="field full"><span class="lbl">ウェブプッシュ証明書の鍵（初回のみ）</span><input id="s-vapid" value="${esc(c.vapidKey || "")}" placeholder="Firebase →プロジェクトの設定 → Cloud Messaging →ウェブプッシュ証明書の「鍵ペア」"><span class="help">${c.vapidKey ? "設定済みです" : "未設定です。設定するまでメンバーは通知を受け取る登録ができません"}</span></div>
      </div></section>
    <div class="grid2">${list("routines", c.routines, "定例業務（業務登録の選択肢）")}${list("expenseCats", c.expenseCats, "支出カテゴリ")}${list("incomeCats", c.incomeCats, "収入カテゴリ")}${list("methods", c.methods, "支払方法")}</div>`;
}

/* ================= push notifications ================= */
const notifyOn = () => !!memGet("push_token_id") && (typeof Notification !== "undefined" && Notification.permission === "granted");
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
async function sha256(t) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 40); }
let fgBound = false;
async function swReg() { return navigator.serviceWorker.register("firebase-messaging-sw.js", { scope: "./" }); }
async function enablePush() {
  const c = cfg(); if (!c.vapidKey) throw new Error("管理者が通知の初期設定（ウェブプッシュ証明書の鍵）をまだ入れていません。");
  if (!(await isSupported())) throw new Error(isIOS() && !isStandalone() ? "iPhoneでは、ホーム画面に追加したアプリから開いて登録してください。" : "このブラウザは通知に対応していません。");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("通知が許可されませんでした。端末の設定で、このアプリの通知を許可してください。");
  const reg = await swReg(); await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(fbApp), { vapidKey: c.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error("通知の登録に失敗しました。もう一度試してください。");
  const id = await sha256(token);
  await setDoc(doc(db, "members", uid(), "tokens", id), { token, ua: navigator.userAgent.slice(0, 200), standalone: isStandalone(), createdAt: serverTimestamp() });
  memSet("push_token_id", id); bindForeground();
}
async function disablePush() {
  const id = memGet("push_token_id");
  try { await deleteToken(getMessaging(fbApp)); } catch (e) { }
  if (id) { try { await deleteDoc(doc(db, "members", uid(), "tokens", id)); } catch (e) { } }
  memSet("push_token_id", null);
}
function bindForeground() {
  if (fgBound || !fbApp) return; fgBound = true;
  try { onMessage(getMessaging(fbApp), p => { const n = p.notification || {}; toast((n.title ? n.title + "：" : "") + (n.body || ""), "info", { duration: 6000 }); }); } catch (e) { }
}
function notifyDialog() {
  const c = cfg(); const on = notifyOn();
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const iosNote = isIOS() && !isStandalone() ? `<p class="banner" style="grid-column:1/-1;margin:0">iPhoneで通知を受け取るには、Safariの共有ボタン →「ホーム画面に追加」で追加したアプリから開いて、ここで登録してください。</p>` : "";
  const body = iosNote + `<div class="field full"><span class="lbl">この端末の状態</span><div class="ro">${on ? `<span class="pill good">通知を受け取ります</span>` : perm === "denied" ? `<span class="pill bad">通知がブロックされています</span>` : `<span class="pill plain">受け取っていません</span>`}</div>
    <span class="help">${c.notifyEnabled === false ? "現在、管理者が朝の通知を止めています。" : `自分が担当の業務がある日の朝${esc(c.notifyTime || "07:30")}ごろに届きます。`}端末ごとに登録が必要です（スマホとPCの両方で受け取るなら両方で登録）。</span>
    ${perm === "denied" ? `<span class="help">端末の設定（iPhoneは「設定」→「通知」→「運営ボード」）で許可してから、もう一度押してください。</span>` : ""}</div>`;
  form.innerHTML = `<div class="dlg-h"><h3>朝の通知</h3><button type="button" data-close aria-label="閉じる">×</button></div><div class="dlg-b">${body}<p class="err" id="f-err" hidden></p></div>
    <div class="dlg-f"><div class="sp">${on ? `<button class="btn sec" type="button" id="n-off">この端末で受け取らない</button>` : `<button class="btn" type="button" id="n-on">この端末で受け取る</button>`}</div></div>`;
  onSubmit = null; onDelete = null; draftKey = null;
  showDlg();
  const onB = form.querySelector("#n-on"), offB = form.querySelector("#n-off");
  if (onB) onB.addEventListener("click", async () => { onB.disabled = true; onB.textContent = "登録しています…"; try { await enablePush(); closeDlg(); toast("この端末で通知を受け取ります"); render(); } catch (e) { showErr(e.message || errMsg(e)); onB.disabled = false; onB.textContent = "この端末で受け取る"; } });
  if (offB) offB.addEventListener("click", async () => { offB.disabled = true; await disablePush(); closeDlg(); toast("この端末への通知を止めました", "info"); render(); });
}

/* ================= dialogs ================= */
const dlg = $("#dlg"), form = $("#dlg-form"); let onSubmit = null, onDelete = null;
/* 入力の記憶：端末ごと・アカウントごとにブラウザ内へ保存（サーバーには送らない） */
const memKey = k => "cb_" + (uid() || "anon") + "_" + k;
const memGet = k => { try { return JSON.parse(ls.get(memKey(k), "null")); } catch (e) { return null; } };
const memSet = (k, v) => ls.set(memKey(k), v == null ? "null" : JSON.stringify(v));
function readFormState() {
  const out = {};
  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el => {
    if (el.type === "file") return;
    if (el.type === "checkbox") { (out[el.name] = out[el.name] || []); if (el.checked) out[el.name].push(el.value); }
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  });
  return out;
}
function applyFormState(st) {
  const set = el => {
    const v = st[el.name]; if (v === undefined) return;
    if (el.type === "checkbox") el.checked = Array.isArray(v) && v.includes(el.value);
    else if (el.type === "radio") el.checked = v === el.value;
    else if (el.tagName === "SELECT" && ![...el.options].some(o => o.value === v)) return;
    else el.value = v;
  };
  // 先に区分・「全員」を戻して、連動する選択肢を作り直してから残りを戻す
  form.querySelectorAll("#f-type,[name$=_all]").forEach(el => { set(el); el.dispatchEvent(new Event("change")); });
  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el => { if (el.id !== "f-type" && !/_all$/.test(el.name)) set(el); });
}
let draftKey = null;
function openDlg(title, body, { submit, del, readOnly, draft } = {}) {
  form.innerHTML = `<div class="dlg-h"><h3>${esc(title)}</h3><button type="button" data-close aria-label="閉じる">×</button></div>
    <div class="dlg-b">${body}<p class="err" id="f-err" hidden></p></div>
    <div class="dlg-f">${del ? `<button class="btn sec" type="button" id="f-del" style="color:var(--bad);border-color:var(--bad)">削除</button>` : ""}<div class="sp">${readOnly ? `<button class="btn" type="button" data-close>閉じる</button>` : `<button class="btn sec" type="button" data-close>キャンセル</button><button class="btn" type="submit">保存</button>`}</div></div>`;
  onSubmit = submit; onDelete = del; draftKey = draft || null;
  showDlg();
  const f = form.querySelector("input:not([type=checkbox]),select,textarea"); if (f && !readOnly) f.focus();
}
let closeTimer = null;
const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
function closeDlg() {
  draftKey = null;
  if (!dlg.open) return;
  const done = () => { dlg.classList.remove("closing"); try { dlg.close(); } catch (e) { dlg.removeAttribute("open"); } closeTimer = null; };
  if (reducedMotion()) return done();
  dlg.classList.add("closing"); clearTimeout(closeTimer); closeTimer = setTimeout(done, 180);
}
function showDlg() {
  clearTimeout(closeTimer); closeTimer = null; dlg.classList.remove("closing");
  if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); } }
  else { dlg.classList.remove("swap"); void dlg.offsetWidth; dlg.classList.add("swap"); }
}
function restoreDraft() {
  if (!draftKey) return; const d = memGet("draft_" + draftKey); if (!d) return;
  applyFormState(d);
  const b = form.querySelector(".dlg-b"); b.insertAdjacentHTML("afterbegin", `<p class="banner" id="f-draft" style="grid-column:1/-1;margin:0">入力途中の内容を復元しました。<button class="link" type="button" data-discard>消して最初から</button></p>`);
}
form.addEventListener("input", () => { if (draftKey) memSet("draft_" + draftKey, readFormState()); });
form.addEventListener("change", () => { if (draftKey) memSet("draft_" + draftKey, readFormState()); });
function showErr(err) { const p = $("#f-err"); p.hidden = false; p.textContent = typeof err === "string" ? err : errMsg(err); }
dlg.addEventListener("click", e => { if (e.target === dlg) { if (draftKey) { /* 入力途中は残す */ } closeDlg(); } });
dlg.addEventListener("cancel", e => { e.preventDefault(); closeDlg(); });
form.addEventListener("click", e => {
  if (e.target.closest("[data-discard]")) { const k = draftKey; memSet("draft_" + k, null); closeDlg(); if (k === "task") taskDialog(null, S.selDay); if (k === "led") ledDialog(null); if (k === "issue") issueDialog(null); return; }
  if (e.target.closest("[data-close]")) { if (draftKey) memSet("draft_" + draftKey, null); closeDlg(); return; }
  const d = e.target.closest("#f-del");
  if (d) {
    if (d.dataset.armed) Promise.resolve(onDelete()).then(() => { closeDlg(); toast("削除しました"); }).catch(showErr);
    else { d.dataset.armed = "1"; d.textContent = "本当に削除する"; d.classList.remove("sec"); d.classList.add("danger"); d.style.color = ""; }
  }
});
form.addEventListener("submit", async e => {
  e.preventDefault(); if (!onSubmit) return;
  const fd = new FormData(form); const f = Object.fromEntries(fd.entries()); f.__fd = fd;
  const btn = form.querySelector("[type=submit]"); if (btn) btn.disabled = true;
  const dk = draftKey;
  try { const r = await onSubmit(f); if (r !== false) { if (dk) memSet("draft_" + dk, null); closeDlg(); toast(typeof r === "string" ? r : "保存しました"); } }
  catch (err) { showErr(err); }
  finally { if (btn) btn.disabled = false; }
});
const sel = (name, list, val) => `<select name="${name}" id="f-${name}">${list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`; }).join("")}</select>`;
const fld = (label, inner, { full, req, help } = {}) => `<div class="field${full ? " full" : ""}"><span class="lbl">${esc(label)}${req ? `<span class="req">必須</span>` : ""}</span>${inner}${help ? `<span class="help">${esc(help)}</span>` : ""}</div>`;
const memberOpts = () => activeMembers().map(m => [m.id, m.name || m.email]);
function shareBox(name, current, help) {
  const all = !current || !current.length || current.includes("all");
  return `<div class="field full"><span class="lbl">${name === "viewers" ? "表示できる人" : "共有する人"}</span><div class="checks">
    <label><input type="checkbox" name="${name}_all" id="f-${name}_all" ${all ? "checked" : ""}>全員</label>
    ${activeMembers().map((m, i) => `<label><input type="checkbox" name="${name}" id="f-${name}-${i}" value="${esc(m.id)}" ${!all && current.includes(m.id) ? "checked" : ""} ${all ? "disabled" : ""}>${esc(m.name || m.email)}</label>`).join("")}
  </div>${help ? `<span class="help">${esc(help)}</span>` : ""}</div>`;
}
function wireShare(name) {
  const a = form.querySelector(`#f-${name}_all`); if (!a) return;
  a.addEventListener("change", () => form.querySelectorAll(`input[name=${name}]`).forEach(x => { x.disabled = a.checked; if (a.checked) x.checked = false; }));
}
const readShare = (f, name) => { if (f[name + "_all"]) return ["all"]; const v = f.__fd.getAll(name); return v.length ? v : ["all"]; };

function kpiDialog(k, preset) {
  const v = k || Object.assign({ month: S.kpiMonth, mode: "sum", unit: "人", owner: uid(), viewers: ["all"] }, preset || {});
  const trk = isTrack(v);
  const body = fld("指標名", `<input name="name" id="f-name" required value="${esc(v.name || "")}" placeholder="例：体験参加者数">`, { full: true, req: true }) +
    `<div class="field full"><label class="checks" style="font-size:.88rem"><input type="checkbox" name="track" id="f-track" value="1" ${trk ? "checked" : ""}>記録のみの指標にする（フォロワー数など。達成率とゲージを出さず、「最新値／目標」と前回からの増減を表示）</label></div>` +
    `<div class="field" id="target-field"><span class="lbl">月次目標<span class="req" id="target-req">必須</span><span class="muted" id="target-opt" style="font-weight:400;margin-left:4px">（任意）</span></span><input name="target" id="f-target" type="number" step="any" min="0" value="${esc(v.target ?? "")}"></div>` +
    fld("単位", `<input name="unit" id="f-unit" value="${esc(v.unit || "")}" placeholder="人・回・件">`) +
    fld("集計方法", sel("mode", [["sum", "合計（MTG・月末ごとに、前回から増えた分を入力）"], ["latest", "最新値（MTG・月末時点の数値を入力）"]], v.mode), { full: true }) +
    fld("担当者", sel("owner", memberOpts(), v.owner), { help: "MTGと月末に進捗を入力する人" }) +
    fld("対象月", `<input name="month" id="f-month" type="month" required value="${esc(v.month)}">`, { req: true }) +
    shareBox("viewers", v.viewers, "担当者には常に表示されます。表示できない人には、このKPIのデータ自体が送られません。");
  openDlg(k ? "KPIを編集" : "KPIを追加", body, {
    submit: async f => {
      const track = !!f.track;
      if (!track && (f.target === "" || !(Number(f.target) >= 0))) return showErr("月次目標を入力してください（記録のみの指標なら、上のチェックを入れると目標は任意になります）。"), false;
      const data = { name: f.name.trim(), track, target: f.target === "" ? null : Number(f.target), unit: f.unit.trim(), mode: f.mode, owner: f.owner, month: f.month, viewers: readShare(f, "viewers") };
      if (!data.name) return showErr("指標名を入力してください。"), false;
      if (!data.viewers.includes("all") && !data.viewers.includes(data.owner)) data.viewers.push(data.owner);
      if (k) await updateDoc(doc(db, "kpis", k.id), data);
      else { data.weekly = {}; data.order = Date.now(); data.createdAt = serverTimestamp(); await addDoc(collection(db, "kpis"), data); }
    },
    del: k ? () => deleteDoc(doc(db, "kpis", k.id)) : null
  });
  wireShare("viewers");
  const tc = form.querySelector("#f-track"), tf = form.querySelector("#target-field");
  const syncT = () => { form.querySelector("#target-req").hidden = tc.checked; form.querySelector("#target-opt").hidden = !tc.checked; if (tc.checked && !k) form.querySelector("#f-mode").value = "latest"; };
  tc.addEventListener("change", syncT); syncT();
}

function taskDialog(t, date) {
  const c = cfg();
  if (t && !canEditTask(t)) {
    const sw = sharedAll(t) ? "全員" : t.shareWith.map(memName).join("・");
    openDlg("業務の詳細", fld("日時", `<div class="ro">${md(t.date)} ${timeLabel(t)}</div>`) + fld("担当者", `<div class="ro">${esc(ownersOf(t).map(memName).join("・") || "未定")}</div>`) +
      fld("担当業務", `<div class="ro">${esc(taskTitle(t))}</div>`, { full: true }) + (t.detail && t.routine !== "__other" ? fld("内容・メモ", `<div class="ro">${esc(t.detail)}</div>`, { full: true }) : "") +
      fld("共有", `<div class="ro">${esc(sw)}</div>`) + fld("登録した人", `<div class="ro">${esc(memName(t.createdBy))}</div>`, { help: "編集できるのは登録した人と管理者・副管理者です" }), { readOnly: true });
    return;
  }
  const last = memGet("last_task") || {};
  const v = t || { date: date || S.selDay || TODAY, start: last.start ?? "17:30", end: last.end ?? "19:00", owners: [uid()], routine: last.routine && (c.routines.includes(last.routine) || last.routine === "__other") ? last.routine : c.routines[0], detail: "", shareWith: last.shareWith || ["all"] };
  const isOther = v.routine === "__other" || (v.routine && !c.routines.includes(v.routine));
  const routineOpts = [...c.routines.map(r => [r, r]), ...(isOther && v.routine !== "__other" ? [[v.routine, v.routine]] : []), ["__other", "その他（下に記述）"]];
  const dateField = t
    ? fld("日付", `<input type="date" name="date" id="f-date" required value="${esc(v.date)}">`, { req: true })
    : `<div class="field full"><span class="lbl">日付<span class="req">必須</span></span>
        <div class="seg" role="radiogroup" aria-label="日付の選び方"><label><input type="radio" name="dmode" id="f-dmode-one" value="one" checked><span>1日だけ</span></label><label><input type="radio" name="dmode" id="f-dmode-multi" value="multi"><span>複数日をまとめて</span></label></div>
        <div id="d-one"><input type="date" name="date" id="f-date" value="${esc(v.date)}"></div>
        <div id="d-multi" hidden><input type="hidden" name="dates" id="f-dates" value=""><div class="mpick" id="mpick"></div>
          <div class="mpick-sum" id="mpick-sum" aria-live="polite"></div>
          <span class="help">日付をタップして選びます（もう一度タップで解除）。時間・担当・内容は、選んだすべての日に同じものが入ります。</span></div>
      </div>`;
  const body = dateField +
    `<div class="field full"><span class="lbl">担当者<span class="req">必須</span></span><div class="pick-chips" role="group" aria-label="担当者（複数選べます）">${activeMembers().map((m, i) => `<label class="pchip" style="--mc:${mColor(m.id)}"><input type="checkbox" name="owners" id="f-owner-${i}" value="${esc(m.id)}" ${ownersOf(v).includes(m.id) ? "checked" : ""}><span><i></i>${esc(m.name || m.email)}</span></label>`).join("")}</div><span class="help">複数選べます。選んだ全員のホームと朝の通知に出ます。</span></div>` +
    `<div class="field full"><label class="checks" style="font-size:.88rem"><input type="checkbox" name="allday" id="f-allday" value="1" ${t ? (!t.start ? "checked" : "") : (v.start ? "" : "checked")}>時間を決めない（終日・時間未定）</label></div>` +
    fld("開始", `<input type="time" name="start" id="f-start" value="${esc(v.start || "")}">`) +
    fld("終了", `<input type="time" name="end" id="f-end" value="${esc(v.end || "")}">`, { help: "決まっていなければ空欄でOK" }) +
    fld("担当業務", sel("routine", routineOpts, v.routine === "__other" ? "__other" : v.routine), { full: true }) +
    fld("内容・メモ", `<textarea name="detail" id="f-detail" placeholder="定例業務以外の場合は内容を記述してください">${esc(v.detail || "")}</textarea>`, { full: true }) +
    shareBox("share", v.shareWith, "全員のカレンダーに表示されます。共有した人のホームの「今日やること」に出ます。");
  openDlg(t ? "業務を編集" : "業務を登録", body, {
    submit: async f => {
      const allday = !!f.allday || !f.start;
      const start = allday ? "" : f.start, end = allday ? "" : (f.end || "");
      if (f.routine === "__other" && !f.detail.trim()) return showErr("「その他」を選んだときは内容を記述してください。"), false;
      if (end && start && end < start) return showErr("終了時刻が開始時刻より前になっています。"), false;
      const multi = !t && f.dmode === "multi";
      const dates = multi ? (f.dates || "").split(",").filter(Boolean).sort() : [f.date];
      if (!dates.length || !dates[0]) return showErr(multi ? "日付を1日以上選んでください。" : "日付を入力してください。"), false;
      if (dates.length > 31) return showErr("一度に登録できるのは31日分までです。"), false;
      const owners = f.__fd.getAll("owners");
      if (!owners.length) return showErr("担当者を1人以上選んでください。"), false;
      const data = { date: dates[0], start, end, owner: owners[0], owners, routine: f.routine, detail: f.detail.trim(), shareWith: readShare(f, "share") };
      if (t) await updateDoc(doc(db, "tasks", t.id), data);
      else {
        Object.assign(data, { done: false, createdBy: uid(), createdAt: serverTimestamp() });
        if (dates.length === 1) await addDoc(collection(db, "tasks"), data);
        else { const b = writeBatch(db); dates.forEach(d => b.set(doc(collection(db, "tasks")), { ...data, date: d })); await b.commit(); }
        memSet("last_task", { start: data.start, end: data.end, routine: data.routine, shareWith: data.shareWith });
      }
      S.selDay = dates[0]; S.calMonth = dates[0].slice(0, 7); S.anim = "in";
      if (dates.length > 1) return dates.length + "日分の業務を登録しました";
    },
    del: t ? () => deleteDoc(doc(db, "tasks", t.id)) : null,
    draft: t ? null : "task"
  });
  wireShare("share");
  const ad = form.querySelector("#f-allday"), st = form.querySelector("#f-start"), en = form.querySelector("#f-end");
  const syncAd = () => { [st, en].forEach(x => { x.disabled = ad.checked; x.closest(".field").style.opacity = ad.checked ? .45 : 1; }); };
  ad.addEventListener("change", () => { if (!ad.checked && !st.value) st.value = "17:30"; syncAd(); }); syncAd();
  if (!t) { wireMultiDate(v.date); restoreDraft(); syncAd(); syncDateMode(); }
}

/* 複数日の選択：小さなカレンダーで日付をタップして選ぶ */
let pickMonth = THISMONTH, syncDateMode = () => { };
function wireMultiDate(initial) {
  const one = form.querySelector("#d-one"), multi = form.querySelector("#d-multi"), hid = form.querySelector("#f-dates"), box = form.querySelector("#mpick"), sum = form.querySelector("#mpick-sum"), dateIn = form.querySelector("#f-date");
  pickMonth = (initial || TODAY).slice(0, 7);
  const getSel = () => new Set((hid.value || "").split(",").filter(Boolean));
  const setSel = set => { hid.value = [...set].sort().join(","); form.dispatchEvent(new Event("change")); };
  const draw = (dir) => {
    const sel = getSel(); const first = parse(pickMonth + "-01"); const start = mondayOf(first);
    let cells = ["月", "火", "水", "木", "金", "土", "日"].map(d => `<span class="mp-dow">${d}</span>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
      if (i >= 35 && ym(d) !== pickMonth) break;
      cells += `<button type="button" class="mp-day${ym(d) !== pickMonth ? " out" : ""}${k === TODAY ? " today" : ""}${sel.has(k) ? " on" : ""}" data-pd="${k}" aria-pressed="${sel.has(k)}" aria-label="${md(k)}">${d.getDate()}</button>`;
    }
    box.innerHTML = `<div class="mp-head"><button type="button" class="mp-nav" data-pm="-1" aria-label="前の月">‹</button><b>${monthLabel(pickMonth)}</b><button type="button" class="mp-nav" data-pm="1" aria-label="次の月">›</button></div><div class="mp-grid${dir ? " slide-" + dir : ""}">${cells}</div>`;
    const list = [...sel].sort();
    sum.innerHTML = list.length ? `<b>${list.length}日</b>選択中：${list.slice(0, 8).map(md).join("・")}${list.length > 8 ? ` ほか${list.length - 8}日` : ""} <button type="button" class="link" data-pclear>すべて解除</button>` : `<span class="muted">まだ選ばれていません</span>`;
  };
  box.addEventListener("click", e => {
    const nav = e.target.closest("[data-pm]"); if (nav) { pickMonth = shiftMonth(pickMonth, +nav.dataset.pm); draw(+nav.dataset.pm > 0 ? "l" : "r"); return; }
    const b = e.target.closest("[data-pd]"); if (!b) return;
    const set = getSel(); const k = b.dataset.pd; set.has(k) ? set.delete(k) : set.add(k); setSel(set);
    if (ym(parse(k)) !== pickMonth) { pickMonth = k.slice(0, 7); }
    draw();
    const nb = box.querySelector(`[data-pd="${k}"]`); if (nb) { nb.classList.add("pop"); nb.focus({ preventScroll: true }); }
  });
  sum.addEventListener("click", e => { if (e.target.closest("[data-pclear]")) { setSel(new Set()); draw(); } });
  syncDateMode = () => {
    const isMulti = form.querySelector("#f-dmode-multi").checked;
    if (isMulti && !hid.value && dateIn.value) hid.value = dateIn.value;
    one.hidden = isMulti; multi.hidden = !isMulti; dateIn.required = !isMulti;
    if (isMulti) { const f = (hid.value.split(",").filter(Boolean).sort()[0]); if (f) pickMonth = f.slice(0, 7); draw(); }
  };
  form.querySelectorAll("[name=dmode]").forEach(r => r.addEventListener("change", syncDateMode));
  syncDateMode();
}

/* ===== 未対応事項：日付のない「やらなきゃいけないこと」を全員で共有 ===== */
const canEditIssue = i => canManage() || (i.createdBy === uid() && canWrite());
const canToggleIssue = i => canEditIssue(i) || ((i.owners || []).includes(uid()) && canWrite());
function issueItem(i) {
  const late = i.due && !i.done && i.due < TODAY;
  const owners = (i.owners || []).map(whoTag).join(" ");
  return `<div class="task issue${i.done ? " done" : ""}">
    <div class="time">${i.due ? `<span class="${late ? "neg" : ""}">${md(i.due).replace(/\(.\)/, "")}まで</span>` : `<span class="muted">期限なし</span>`}</div>
    <div><div class="what">${late ? `<span class="pill bad">期限切れ</span> ` : ""}${esc(i.title)}</div><div class="whos">${owners || `<span class="muted" style="font-size:.8rem">担当未定</span>`}</div></div>
    <div class="acts">${canToggleIssue(i) ? `<label><input type="checkbox" data-act="issue-done" data-id="${esc(i.id)}" ${i.done ? "checked" : ""}>完了</label>` : (i.done ? `<span class="pill good">完了</span>` : "")}<button class="link" type="button" data-act="issue-open" data-id="${esc(i.id)}">${canEditIssue(i) ? "編集" : "詳細"}</button></div>
    ${i.detail ? `<div class="sub">${esc(i.detail)}</div>` : ""}
  </div>`;
}
function issueDialog(it) {
  if (it && !canEditIssue(it)) {
    openDlg("未対応事項", fld("内容", `<div class="ro">${esc(it.title)}</div>`, { full: true }) + (it.detail ? fld("詳細", `<div class="ro" style="white-space:pre-line">${esc(it.detail)}</div>`, { full: true }) : "") +
      fld("期限", `<div class="ro">${it.due ? md(it.due) : "なし"}</div>`) + fld("担当", `<div class="ro">${esc((it.owners || []).map(memName).join("・") || "未定")}</div>`) +
      fld("追加した人", `<div class="ro">${esc(memName(it.createdBy))}</div>`, { help: "編集できるのは追加した人と管理者・副管理者です" }), { readOnly: true });
    return;
  }
  const v = it || { title: "", detail: "", due: "", owners: [] };
  const body = fld("内容", `<input name="title" id="f-title" required value="${esc(v.title)}" placeholder="例：チラシの在庫が少ないので追加発注">`, { full: true, req: true }) +
    fld("詳細（任意）", `<textarea name="detail" id="f-detail">${esc(v.detail || "")}</textarea>`, { full: true }) +
    fld("期限（任意）", `<input type="date" name="due" id="f-due" value="${esc(v.due || "")}">`) +
    `<div class="field full"><span class="lbl">担当（任意・複数可）</span><div class="pick-chips">${activeMembers().map((m, i) => `<label class="pchip" style="--mc:${mColor(m.id)}"><input type="checkbox" name="owners" id="f-iowner-${i}" value="${esc(m.id)}" ${(v.owners || []).includes(m.id) ? "checked" : ""}><span><i></i>${esc(m.name || m.email)}</span></label>`).join("")}</div><span class="help">決まっていなければ空欄のままでOK。運営メンバー全員のホームに表示されます。</span></div>`;
  openDlg(it ? "未対応事項を編集" : "未対応事項を追加", body, {
    submit: async f => {
      const data = { title: f.title.trim(), detail: f.detail.trim(), due: f.due || "", owners: f.__fd.getAll("owners") };
      if (!data.title) return showErr("内容を入力してください。"), false;
      if (it) await updateDoc(doc(db, "issues", it.id), data);
      else { Object.assign(data, { done: false, createdBy: uid(), createdAt: serverTimestamp() }); await addDoc(collection(db, "issues"), data); S.anim = "in"; return "未対応事項を追加しました"; }
    },
    del: it ? () => deleteDoc(doc(db, "issues", it.id)) : null,
    draft: it ? null : "issue"
  });
  if (!it) restoreDraft();
}
function ledDialog(r) {
  const c = cfg(); const names = activeMembers().map(m => m.name || m.email);
  const lastL = memGet("last_led") || {};
  const v = r || { date: TODAY, type: lastL.type || "支出", category: lastL.category || c.expenseCats[0], owner: lastL.owner || memName(uid()), method: lastL.method || "現金", settled: lastL.settled || "未精算", title: "", amount: "", memo: "" };
  const ownerList = v.owner && !names.includes(v.owner) ? [...names, v.owner] : names;
  const catList = t => t === "収入" ? c.incomeCats : c.expenseCats;
  const body = fld("項目", `<input name="title" id="f-title" required value="${esc(v.title)}" placeholder="例：チラシ印刷代">`, { full: true, req: true }) +
    fld("区分", sel("type", ["収入", "支出"], v.type)) + fld("カテゴリ", sel("category", catList(v.type), v.category)) +
    fld("金額（円）", `<input name="amount" id="f-amount" type="number" min="0" step="1" required value="${esc(v.amount)}">`, { req: true }) +
    fld("日付", `<input type="date" name="date" id="f-date" required value="${esc(v.date)}">`, { req: true }) +
    fld("担当者", sel("owner", ownerList, v.owner)) + fld("支払方法", sel("method", c.methods, v.method)) +
    fld("精算", sel("settled", ["未精算", "精算済", "対象外"], v.settled), { help: "立替払いは「未精算」、返金したら「精算済」" }) +
    fld("メモ", `<textarea name="memo" id="f-memo">${esc(v.memo || "")}</textarea>`, { full: true });
  openDlg(r ? "収支を編集" : "収支を記録", body, {
    submit: async f => {
      const amt = Number(f.amount); if (!(amt >= 0)) return showErr("金額を数字で入力してください。"), false;
      const data = { title: f.title.trim(), type: f.type, category: f.category, amount: amt, date: f.date, owner: f.owner, method: f.method, settled: f.settled, memo: f.memo.trim() };
      if (r) await updateDoc(doc(db, "ledger", r.id), data);
      else { data.createdAt = serverTimestamp(); await addDoc(collection(db, "ledger"), data); memSet("last_led", { type: data.type, category: data.category, owner: data.owner, method: data.method, settled: data.settled }); }
      S.moneyMonth = f.date.slice(0, 7);
    },
    del: r ? () => deleteDoc(doc(db, "ledger", r.id)) : null,
    draft: r ? null : "led"
  });
  const ty = form.querySelector("#f-type"), ca = form.querySelector("#f-category");
  ty.addEventListener("change", () => { const keep = ca.value; ca.innerHTML = catList(ty.value).map(o => `<option${o === keep ? " selected" : ""}>${esc(o)}</option>`).join(""); });
  if (!r) restoreDraft();
}

/* CSV import (Notionの書き出しと同じ列名：項目,区分,カテゴリ,金額,日付,担当者,支払方法,精算,メモ) */
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
function normDate(s) {
  s = (s || "").trim(); let m;
  if ((m = s.match(/^(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/))) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
  const d = new Date(s); return isNaN(d) ? "" : ymd(d);
}
function importDialog() {
  openDlg("CSVを取り込む", fld("CSVファイル", `<input type="file" id="f-csv" name="csv" accept=".csv,text/csv" required>`, { full: true, help: "1行目の列名：項目, 区分, カテゴリ, 金額, 日付, 担当者, 支払方法, 精算, メモ（NotionのCSV書き出しをそのまま使えます）。日付・項目・金額が同じ記録は登録済みとして飛ばします" }) + `<p class="muted full" id="f-prev" style="grid-column:1/-1;margin:0;font-size:.85rem"></p>`, {
    submit: async () => {
      const file = form.querySelector("#f-csv").files[0]; if (!file) return showErr("ファイルを選んでください。"), false;
      const rows = parseCSV(await file.text()); if (rows.length < 2) return showErr("データ行がありません。"), false;
      const h = rows[0].map(x => x.trim()); const ix = n => h.indexOf(n);
      if (ix("項目") < 0 || ix("金額") < 0 || ix("日付") < 0 || ix("区分") < 0) return showErr("「項目」「区分」「金額」「日付」の列が見つかりません。"), false;
      const items = rows.slice(1).map(r => {
        const g = n => ix(n) < 0 ? "" : (r[ix(n)] || "").trim();
        return { title: g("項目"), type: g("区分") === "収入" ? "収入" : "支出", category: g("カテゴリ") || "その他", amount: Number(g("金額").replace(/[¥￥,円\s]/g, "")) || 0, date: normDate(g("日付")), owner: g("担当者"), method: g("支払方法"), settled: g("精算") || "対象外", memo: g("メモ"), createdAt: serverTimestamp() };
      }).filter(x => x.title && x.date);
      if (!items.length) return showErr("取り込める行がありませんでした。日付の形式を確認してください。"), false;
      const keyOf = x => [x.date, x.title, Number(x.amount), x.type].join("|");
      const have = new Set(S.ledger.map(keyOf));
      const fresh = items.filter(x => !have.has(keyOf(x)));
      const skipped = items.length - fresh.length;
      if (!fresh.length) { closeDlg(); toast("すべて登録済みでした（" + skipped + "件）。追加はありません", "info"); return false; }
      items.length = 0; items.push(...fresh); S.importSkipped = skipped;
      for (let i = 0; i < items.length; i += 400) { const b = writeBatch(db); items.slice(i, i + 400).forEach(x => b.set(doc(collection(db, "ledger")), x)); await b.commit(); }
      closeDlg(); toast(items.length + "件を取り込みました" + (S.importSkipped ? "（登録済みの" + S.importSkipped + "件は飛ばしました）" : "")); return false;
    }
  });
}

/* ================= events ================= */
document.addEventListener("click", async e => {
  const tab = e.target.closest("#tabs [data-tab]"); if (tab) {
    if (S.tab === "admin" && S.adminSub === "settings" && S.settingsDirty && tab.dataset.tab !== "admin" && !S.leaveArmed) { S.leaveArmed = true; toast("設定が未保存です。もう一度押すと変更を破棄して移動します", "warn"); setTimeout(() => S.leaveArmed = false, 4000); return; }
    if (tab.dataset.tab !== "admin") S.settingsDirty = false;
    if (S.tab !== tab.dataset.tab) S.anim = "in";
    S.tab = tab.dataset.tab; try { history.replaceState(null, "", "#" + S.tab); } catch (_) { } setMenu(false); render(); window.scrollTo(0, 0); return; }
  const a = e.target.closest("[data-act]"); if (!a || a.closest("dialog")) {
    const rm = e.target.closest("[data-rm]"); if (rm && !rm.closest("dialog")) { rm.parentElement.remove(); markDirty(); return; }
    const ad = e.target.closest("[data-add]"); if (ad && !ad.closest("dialog")) { const box = document.querySelector(`[data-list="${ad.dataset.add}"]`); box.insertAdjacentHTML("beforeend", rowHTML(ad.dataset.add, Date.now(), "", "追加項目")); box.lastElementChild.querySelector("input").focus(); markDirty(); }
    return;
  }
  const act = a.dataset.act, id = a.dataset.id;
  if (act === "login") return login();
  if (act === "logout") { if (notifyOn()) await disablePush(); await signOut(auth); return; }
  if (act === "notify") return notifyDialog();
  if (act === "go") { S.anim = "in"; S.tab = a.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (act === "mprev" || act === "mnext") { const k = a.dataset.k; S.anim = act === "mprev" ? "r" : "l"; S[k] = shiftMonth(S[k], act === "mprev" ? -1 : 1); if (k === "calMonth") S.selDay = S.calMonth === THISMONTH ? TODAY : S.calMonth + "-01"; render(); return; }
  if (act === "kpi-new") return kpiDialog(null);
  if (act === "kpi-tpl") return kpiDialog(null, KPI_TEMPLATES[+a.dataset.i]);
  if (act === "kpi-edit") return kpiDialog(S.kpis.find(k => k.id === id));
  if (act === "kpi-del") {
    if (S.armDel !== id) { S.armDel = id; render(); clearTimeout(S.armTimer); S.armTimer = setTimeout(() => { S.armDel = null; render(); }, 5000); return; }
    S.armDel = null; try { await deleteDoc(doc(db, "kpis", id)); toast("KPIを削除しました"); } catch (err) { toast(errMsg(err), "error"); } return;
  }
  if (act === "kpi-carry") {
    const prev = S.kpis.filter(k => k.month === shiftMonth(S.kpiMonth, -1));
    try { const b = writeBatch(db); prev.forEach(k => b.set(doc(collection(db, "kpis")), { name: k.name, track: isTrack(k), target: k.target ?? null, unit: k.unit || "", mode: k.mode, owner: k.owner, viewers: k.viewers || ["all"], month: S.kpiMonth, weekly: {}, order: k.order || Date.now(), createdAt: serverTimestamp() })); await b.commit(); toast("先月のKPIを引き継ぎました"); } catch (err) { toast(errMsg(err), "error"); }
    return;
  }
  if (act === "task-new") { if (!canWrite()) return; return taskDialog(null, a.dataset.d); }
  if (act === "task-open") return taskDialog(S.tasks.find(t => t.id === id));
  if (act === "day") { S.selDay = a.dataset.d; S.pulse = ".day-panel"; render(); return; }
  if (act === "led-new") return ledDialog(null);
  if (act === "led-edit") return ledDialog(S.ledger.find(r => r.id === id));
  if (act === "led-import") return importDialog();
  if (act === "inv-new") return inviteDialog();
  if (act === "issue-new") { if (canWrite()) issueDialog(null); return; }
  if (act === "issue-open") return issueDialog((S.issues || []).find(i => i.id === id));
  if (act === "issue-showdone") { S.showDoneIssues = !S.showDoneIssues; render(); return; }
  if (act === "form-new") return formDialog(null);
  if (act === "form-edit") return formDialog((S.forms || []).find(f => f.id === id));
  if (act === "form-copy") { const f = (S.forms || []).find(x => x.id === id); if (f) copyPlain(formShareText(f), f.message ? "案内文をコピーしました" : "リンクをコピーしました"); return; }
  if (act === "form-copy-url") { const f = (S.forms || []).find(x => x.id === id); if (f) copyPlain(f.url, "リンクをコピーしました"); return; }
  if (act === "form-up" || act === "form-down") { try { await moveForm(id, act === "form-up" ? -1 : 1); } catch (err) { toast(errMsg(err), "error"); } return; }
  if (act === "inv-copy") { const iv = (S.invites || []).find(x => x.id === id); return copyText(inviteText(iv && iv.name)); }
  if (act === "inv-del") {
    if (S.armDel !== "inv:" + id) { S.armDel = "inv:" + id; render(); clearTimeout(S.armTimer); S.armTimer = setTimeout(() => { S.armDel = null; render(); }, 5000); return; }
    S.armDel = null; try { await deleteDoc(doc(db, "invites", id)); toast("追加を取り消しました", "info"); } catch (err) { toast(errMsg(err), "error"); } return;
  }
  if (act === "mem-color") { try { await updateDoc(doc(db, "members", id), { color: a.dataset.c }); toast("色を変更しました"); } catch (err) { toast(errMsg(err), "error"); } return; }
  if (act === "mem-del") {
    const m = S.members.find(x => x.id === id); if (!m || m.status === "active" || m.id === uid()) return;
    if (S.armDel !== "mem:" + id) { S.armDel = "mem:" + id; render(); clearTimeout(S.armTimer); S.armTimer = setTimeout(() => { S.armDel = null; render(); }, 5000); return; }
    S.armDel = null;
    try {
      await deleteDoc(doc(db, "members", id));
      const em = (m.email || "").toLowerCase(); if (em && (S.invites || []).some(iv => iv.id === em)) await deleteDoc(doc(db, "invites", em));
      toast((m.name || m.email || "メンバー") + "さんを名簿から削除しました", "info");
    } catch (err) { toast(errMsg(err), "error"); }
    return;
  }
  if (act === "mem-status") { try { await updateDoc(doc(db, "members", id), { status: a.dataset.v }); toast(a.dataset.v === "active" ? "承認しました" : "停止しました"); } catch (err) { toast(errMsg(err), "error"); } return; }
  if (act === "save-settings") {
    const out = {}; ["routines", "expenseCats", "incomeCats", "methods"].forEach(k => { out[k] = [...document.querySelectorAll(`[data-list="${k}"] input`)].map(i => i.value.trim()).filter(Boolean); });
    const nt = document.getElementById("s-notifyTime"), ne = document.getElementById("s-notifyEnabled"), vk = document.getElementById("s-vapid");
    if (nt) out.notifyTime = nt.value; if (ne) out.notifyEnabled = ne.checked; if (vk) out.vapidKey = vk.value.trim();
    try { await setDoc(doc(db, "config", "main"), out, { merge: true }); S.settingsDirty = false; toast("設定を保存しました"); render(); } catch (err) { toast(errMsg(err), "error"); }
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter") { const r = e.target.closest && e.target.closest("tr[data-act=led-edit]"); if (r) ledDialog(S.ledger.find(x => x.id === r.dataset.id)); } });
document.addEventListener("change", async e => {
  const a = e.target.closest("[data-act]"); if (!a || a.closest("dialog")) return;
  const act = a.dataset.act, id = a.dataset.id;
  if (act === "adm-sub") {
    if (S.adminSub === "settings" && S.settingsDirty && a.value !== "settings" && !S.leaveArmed) { a.checked = false; document.getElementById("adm-settings").checked = true; S.leaveArmed = true; toast("設定が未保存です。もう一度押すと変更を破棄して移動します", "warn"); setTimeout(() => S.leaveArmed = false, 4000); return; }
    S.settingsDirty = false; S.adminSub = a.value; S.anim = "in"; try { history.replaceState(null, "", "#" + a.value); } catch (_) { } render(); return;
  }
  if (act === "onlymine") { S.onlyMine = a.checked; ls.set("cb_onlymine", a.checked ? "1" : "0"); render(); return; }
  try {
    if (act === "issue-done") {
      const row = a.closest(".task"); if (row) { row.classList.toggle("done", a.checked); row.classList.add("just"); }
      if (a.checked) toast("完了にしました", "success", { action: { label: "元に戻す", run: () => updateDoc(doc(db, "issues", id), { done: false, doneAt: null }).catch(e => toast(errMsg(e), "error")) } });
      await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 380));
      await updateDoc(doc(db, "issues", id), { done: a.checked, doneAt: a.checked ? serverTimestamp() : null, doneBy: a.checked ? uid() : null });
    }
    if (act === "task-done") {
      const row = a.closest(".task"); if (row) { row.classList.toggle("done", a.checked); row.classList.add("just"); }
      if (a.checked) toast("完了にしました", "success", { action: { label: "元に戻す", run: () => updateDoc(doc(db, "tasks", id), { done: false }).catch(e => toast(errMsg(e), "error")) } });
      await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 380));
      await updateDoc(doc(db, "tasks", id), { done: a.checked });
    }
    if (act === "kpi-cell") { const raw = a.value.trim(); await updateDoc(doc(db, "kpis", id), new FieldPath("weekly", a.dataset.wk), { value: raw === "" ? null : Number(raw), by: uid() }); toast("保存しました"); }
    if (act === "mem-name") { await updateDoc(doc(db, "members", id), { name: a.value.trim() }); toast("表示名を保存しました"); }
    if (act === "mem-role") { await updateDoc(doc(db, "members", id), { role: a.value }); toast(memName(id) + "さんを「" + roleLabel(a.value) + "」にしました"); }
    if (act === "mem-fin") { await updateDoc(doc(db, "members", id), { finance: a.checked }); toast(a.checked ? "収支を見られるようにしました" : "収支を見られないようにしました"); }
  } catch (err) { if (a.type === "checkbox") a.checked = !a.checked; toast(errMsg(err), "error"); }
});

/* ---------- 並べ替え（ドラッグ＆ドロップ・タッチ・キーボード対応） ---------- */
document.addEventListener("input", e => { if (e.target.closest("[data-list]") || /^s-(notify|vapid)/.test(e.target.id || "")) markDirty(); });
document.addEventListener("change", e => { if (/^s-notify/.test(e.target.id || "")) markDirty(); });
document.addEventListener("pointerdown", e => {
  const handle = e.target.closest(".listedit .handle"); if (!handle || e.button > 0) return;
  e.preventDefault();
  const row = handle.closest(".row"), box = row.parentElement;
  S.dragging = true; row.classList.add("dragging");
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const others = [...box.children].filter(r => r !== row);
    const before = others.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if (before) { if (row.nextElementSibling !== before) box.insertBefore(row, before); }
    else if (box.lastElementChild !== row) box.appendChild(row);
  };
  // 行をDOM上で動かすとポインターキャプチャが外れるため、document で受け取る
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end);
    row.classList.remove("dragging"); S.dragging = false; markDirty(); handle.focus();
  };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
});
document.addEventListener("keydown", e => {
  const handle = e.target.closest && e.target.closest(".listedit .handle"); if (!handle) return;
  const row = handle.closest(".row"), box = row.parentElement;
  if (e.key === "ArrowUp" && row.previousElementSibling) { e.preventDefault(); box.insertBefore(row, row.previousElementSibling); handle.focus(); markDirty(); }
  if (e.key === "ArrowDown" && row.nextElementSibling) { e.preventDefault(); box.insertBefore(row.nextElementSibling, row); handle.focus(); markDirty(); }
});

let h0 = (location.hash || "").slice(1); if (h0 === "members" || h0 === "settings") { S.adminSub = h0; h0 = "admin"; } if (TABS_ALL.some(([k]) => k === h0)) S.tab = h0;
render();
