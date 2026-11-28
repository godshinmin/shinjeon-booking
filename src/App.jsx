import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═════════════════════════════════════════════
//  서버(Supabase) 연결
// ═════════════════════════════════════════════
const SB  = "https://yigtucvlikxeddqghtqw.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpZ3R1Y3ZsaWt4ZWRkcWdodHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTcwNjgsImV4cCI6MjA5Nzg3MzA2OH0.MoTdu9sYMOLIaLhCNY9Ivs3hg32MbiHoqlOMcbRpIwY";
const H   = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const MAX_SEATS        = 15;

// 로그인 정보는 이 화면의 메모리에만 둡니다 (입장 코드는 이 기기에 저장, 관리자 열쇠는 저장 안 함)
const AUTH  = { entry: "", token: "" };
const hooks = { entryFail: null, adminFail: null };

// 서버 함수 호출. 모든 예약·설정 작업은 서버가 직접 검사하는 함수로만 합니다.
// 결과: { ok(서버가 승인), status, data, missing(서버 함수 없음) }
const rpc = async (fn, args = {}, quiet = false) => {
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(args),
    });
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
    const good = r.ok && data && typeof data === "object";
    if (good && !quiet) {
      if (data.code === "entry" && hooks.entryFail) hooks.entryFail();
      if (data.code === "auth" && hooks.adminFail) hooks.adminFail();
    }
    return { ok: !!good && data.ok === true, status: r.status, data: good ? data : {}, missing: r.status === 404 };
  } catch {
    return { ok: false, status: 0, data: {}, missing: false };
  }
};
const failMsg = (r, fallback) =>
  r.status === 0 ? "서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요."
  : r.missing ? "서버 업데이트가 아직 끝나지 않았어요. 관리자에게 알려주세요."
  : (r.data && r.data.msg) || fallback;

// 보안 점검용: 표를 브라우저에서 직접 열 수 있는지 확인 (잠금 후에는 거부돼야 정상)
const probeTable = async table => {
  try {
    const r = await fetch(`${SB}/rest/v1/${table}?select=*&limit=1`, { headers: H, cache: "no-store" });
    return r.ok ? "open" : (r.status === 401 || r.status === 403) ? "blocked" : "unknown";
  } catch { return "unknown"; }
};

// ═════════════════════════════════════════════
//  자습실 설정 (서버에 하나만 저장 → 관리자·학생이 같은 값을 읽음)
// ═════════════════════════════════════════════
const STUDIO_META = [
  { id: "A", color: "#2B58B8", bg: "#EBF0FB" },
  { id: "B", color: "#7C3AED", bg: "#F3EFFE" },
  { id: "C", color: "#059669", bg: "#ECFDF5" },
  { id: "D", color: "#D97706", bg: "#FFFBEB" },
];
const DEFAULT_INFO = "🏢 서울시 송파구 가락동 91-5\n🚗 차량불가 · 🍱 취식자제 · 🧹 이용 후 자리 정리\n⚠️ 노쇼 3회 시 패널티\n💡 마지막 퇴실자: 소등 + 에어컨OFF + 문잠금";

// 홈페이지·카페·블로그·카카오톡 상담 링크 (관리 화면에서 주소를 넣으면 입장 화면과 메인 화면에 버튼으로 나와요)
const LINK_DEFS = [["home", "🏠", "홈페이지"], ["cafe", "☕", "카페"], ["blog", "📝", "블로그"], ["kakao", "💬", "카카오톡 상담"]];
const cleanUrl = s => {
  let t = String(s || "").trim().slice(0, 300);
  if (!t) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = "https://" + t;
  return /^https?:\/\/[^\s<>"']+$/i.test(t) ? t : "";
};
const makeDefaultCfg = () => ({
  rev: 0,
  info: DEFAULT_INFO,
  showRanking: true,
  rankingSince: "",
  links: { home: "", cafe: "", blog: "", kakao: "" },
  weekly: [],
  dday: { label: "건축사 시험", date: "" },
  notice: { text: "", at: "" },
  message: { title: "대표의 한마디", text: "" },
  rooms: Object.fromEntries(STUDIO_META.map(m => [m.id, { name: `스튜디오 ${m.id}`, open: true, seats: MAX_SEATS }])),
});

// 매주 반복 잠금(정기 강의) 규칙: { id, studio_id, days:[0~6], start, end, reason, skip:[날짜] }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const normalizeWeekly = (w) => {
  if (!Array.isArray(w)) return [];
  const out = [];
  for (const r of w.slice(0, 60)) {
    if (!r || typeof r.id !== "string") continue;
    if (!["A", "B", "C", "D", "ALL"].includes(r.studio_id)) continue;
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length || !HHMM.test(r.start) || !HHMM.test(r.end) || r.start >= r.end) continue;
    out.push({
      id: r.id.slice(0, 40), studio_id: r.studio_id, days, start: r.start, end: r.end,
      reason: (typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : "강의").slice(0, 20),
      skip: (Array.isArray(r.skip) ? r.skip : []).filter(x => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(-60),
    });
  }
  return out;
};

// 다른 기기가 먼저 저장한 설정 위에, 내가 바꾼 항목만 얹어서 합침 (서로의 수정이 덮어써지지 않도록)
const sj = x => JSON.stringify(x);
const mergeCfg = (base, mine, theirs) => {
  const out = { ...theirs, rooms: { ...theirs.rooms } };
  for (const k of ["info", "showRanking", "rankingSince", "links", "dday", "notice", "message"]) if (sj(mine[k]) !== sj(base[k])) out[k] = mine[k];
  for (const id of Object.keys(mine.rooms)) if (sj(mine.rooms[id]) !== sj(base.rooms?.[id])) out.rooms[id] = mine.rooms[id];
  const bw = base.weekly || [], mw = mine.weekly || [];
  const bIds = new Set(bw.map(r => r.id)), mIds = new Set(mw.map(r => r.id));
  let w = (theirs.weekly || []).filter(r => !(bIds.has(r.id) && !mIds.has(r.id)));     // 내가 지운 규칙 제거
  w = w.map(r => { const m = mw.find(x => x.id === r.id); return m && sj(m) !== sj(bw.find(x => x.id === r.id)) ? m : r; }); // 내가 고친 규칙 반영
  for (const r of mw) if (!bIds.has(r.id) && !w.some(x => x.id === r.id)) w.push(r);   // 내가 추가한 규칙 추가
  out.weekly = w;
  return out;
};

const normalizeCfg = (v) => {
  const rooms = {};
  STUDIO_META.forEach(m => {
    const r = v?.rooms?.[m.id] || {};
    const s = Math.round(Number(r.seats));
    rooms[m.id] = {
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 20) : `스튜디오 ${m.id}`,
      open: r.open === undefined ? true : !!r.open,
      seats: Number.isFinite(s) ? Math.max(0, Math.min(MAX_SEATS, s)) : MAX_SEATS,
    };
  });
  return {
    rev: Number(v?.rev) || 0,
    info: typeof v?.info === "string" ? v.info.slice(0, 600) : DEFAULT_INFO,
    showRanking: v?.showRanking === undefined ? true : !!v.showRanking,
    rankingSince: typeof v?.rankingSince === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.rankingSince) ? v.rankingSince : "",
    links: Object.fromEntries(LINK_DEFS.map(([k]) => [k, cleanUrl(v?.links?.[k])])),
    weekly: normalizeWeekly(v?.weekly),
    dday: {
      label: typeof v?.dday?.label === "string" && v.dday.label.trim() ? v.dday.label.trim().slice(0, 20) : "건축사 시험",
      date: typeof v?.dday?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.dday.date) ? v.dday.date : "",
    },
    notice: {
      text: typeof v?.notice?.text === "string" ? v.notice.text.slice(0, 500) : "",
      at: typeof v?.notice?.at === "string" ? v.notice.at.slice(0, 10) : "",
    },
    message: {
      title: typeof v?.message?.title === "string" && v.message.title.trim() ? v.message.title.trim().slice(0, 20) : "대표의 한마디",
      text: typeof v?.message?.text === "string" ? v.message.text.slice(0, 500) : "",
    },
    rooms,
  };
};

// 서버에서 설정 읽기 (서버가 rev가 가장 큰 값을 골라 줌)
const readConfig = async () => {
  const r = await rpc("sj_config", { p_entry: AUTH.entry });
  if (!r.ok) return { ok: false, status: r.status };
  const v = r.data.value;
  if (!v) return { ok: true, cfg: null };
  try { const j = JSON.parse(v); return { ok: true, cfg: j && j.rooms ? j : null }; } catch { return { ok: false, status: 200 }; }
};

// 관리자 설정 저장: 서버가 "내가 본 버전(expectedRev) 그대로인지" 확인하고 저장 (동시 저장 충돌 방지)
const saveConfigRemote = async (snap, expectedRev) => {
  const r = await rpc("sj_admin_save_config", { p_token: AUTH.token, p_value: JSON.stringify(snap), p_expected_rev: expectedRev });
  if (r.ok) return { ok: true };
  if (r.data.code === "conflict") return { ok: false, conflict: true };
  if (r.data.code === "auth") return { ok: false, msg: "관리자 로그인이 만료됐어요. 다시 로그인해주세요" };
  return { ok: false, msg: failMsg(r, "서버가 저장을 거부했어요") };
};

// ═════════════════════════════════════════════
//  디자인 / 상수 / 유틸
// ═════════════════════════════════════════════
const C = {
  navy: "#1A2A45", blue: "#2B58B8", accent: "#C8A655",
  bg: "#F0F4FB", card: "#fff", border: "#DAE0EF",
  tx: "#1A2A45", mid: "#475070", light: "#8290B0",
  ok: "#059669", warn: "#D97706", err: "#DC2626",
};
const DAY = ["일", "월", "화", "수", "목", "금", "토"];
// 담임 건축사 이름 정리 ("담임 홍길동 건축사" → "홍길동") / 표시용 태그
const cleanTutor = v => String(v || "").replace(/^\s*담임\s*/, "").replace(/\s*건축사\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 10);
const tutTag = c => (c ? ` (담임 ${c})` : "");
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return toStr(d); };

const SLOTS = [];
for (let h = 9; h <= 21; h++) {
  SLOTS.push(`${String(h).padStart(2, "0")}:00`);
  SLOTS.push(`${String(h).padStart(2, "0")}:30`);
}

const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const add30 = t => { const [h, m] = t.split(":").map(Number), tot = h * 60 + m + 30; return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`; };
const toStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dow   = s => new Date(s + "T12:00:00").getDay();
const fmt   = s => { const [, m, d] = s.split("-"); return `${parseInt(m)}.${parseInt(d)}`; };
const today = () => toStr(new Date());
const hm    = t => String(t || "").slice(0, 5);
const normT = r => ({ ...r, start_time: hm(r.start_time), end_time: hm(r.end_time) });
const clock = d => d ? d.toLocaleTimeString("ko-KR", { hour12: false }) : "";

// 학생: 오늘~3일 뒤까지 시간 제한 없이 항상 예약 가능 / 관리자: 14일
const isOpenDate = () => true;
const getDates      = () => Array.from({ length: 4 },  (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return toStr(d); });
const getAdminDates = () => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return toStr(d); });

// 이미 지나간 시간인지 (지난 시간은 예약 불가 → 랭킹 시간 조작·실수 방지)
const isPastSlot = (date, slot) => date < today() || (date === today() && add30(slot) <= nowHM());
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + n); return toStr(d); };
const daysUntil = ds => Math.round((new Date(ds + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);

const overlaps = (r, slot) => r.start_time < add30(slot) && r.end_time > slot;
const manualLock = (locks, sid, slot) => locks.find(l => (l.studio_id === sid || l.studio_id === "ALL") && l.start_time < add30(slot) && l.end_time > slot);
const slotBooked = (res, sid, slot) => res.filter(r => r.studio_id === sid && overlaps(r, slot)).length;

const fetchDay = async d => {
  const r = await rpc("sj_day", { p_entry: AUTH.entry, p_date: d, p_token: AUTH.token || null });
  // 읽지 못했으면 '빈자리'로 착각하지 않도록 실패로 처리
  if (!r.ok || !Array.isArray(r.data.res) || !Array.isArray(r.data.locks)) return null;
  return { res: r.data.res.map(normT), locks: r.data.locks.map(normT), admin: !!r.data.admin };
};

// 정기 규칙 → 해당 날짜의 잠금(서버 설정에서 계산, 학생·관리자 동일)
const ruleLocks = (weekly, date) => (weekly || [])
  .filter(r => r.days.includes(dow(date)) && !(r.skip || []).includes(date))
  .map(r => ({ id: `rule:${r.id}:${date}`, rule_id: r.id, rule: true, date, studio_id: r.studio_id, start_time: r.start, end_time: r.end, reason: r.reason }));

// ═════════════════════════════════════════════
//  예약 처리 핵심
//  서버 함수(sj_book)가 한 번에 한 건씩 정원·잠금·한 사람 한 자리·날짜 범위를 모두 검사하고 저장해요.
//  연결이 끊겨 응답을 못 받으면 같은 예약 번호로 다시 보내요 (서버가 중복 저장하지 않음).
// ═════════════════════════════════════════════
const UNKNOWN_MSG = "서버 응답을 확인하지 못했어요. 예약이 저장됐을 수 있어요. '예약 확정'을 한 번 더 눌러도 중복 예약되지 않아요.";
const placeBooking = async payload => {
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await rpc("sj_book", { p_entry: AUTH.entry, p: payload, p_token: AUTH.token || null });
    if (r.status !== 0 && r.status < 500) break;
    if (i < 2) await new Promise(x => setTimeout(x, 700));
  }
  if (r.ok) return { ok: true };
  if (r.status === 0 || r.status >= 500) return { ok: false, unknown: true, msg: UNKNOWN_MSG };
  return { ok: false, msg: failMsg(r, "예약 저장에 실패했어요. 잠시 후 다시 시도해주세요.") };
};

// ═════════════════════════════════════════════
//  랭킹 계산 (예약해서 이용이 끝난 시간 기준)
// ═════════════════════════════════════════════
const toMin    = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmtDur   = min => { const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h}시간 ${m}분` : h ? `${h}시간` : `${m}분`; };
// 이름 규칙: 한글 2~5자(뒤에 구분 알파벳 1자 가능, 예: 김민수B) 또는 영문 2~20자. 숫자·기호·이모지·자음/모음만 있는 이름은 안 돼요.
const NAME_BAD = ["바보", "멍청", "똥", "씨발", "시발", "병신", "개새", "좆", "지랄", "섹스", "관리자", "운영자", "익명", "테스트", "test", "admin"];
const nameProblem = n => {
  const ok = /^[가-힣]{2,5}[A-Za-z]?$/.test(n) || /^[A-Za-z][A-Za-z ]{1,19}$/.test(n);
  if (!ok) return "이름은 본명(한글 2~5자)으로 입력해주세요. 숫자·기호·이모지·자음만 있는 이름은 쓸 수 없어요. 같은 이름이 있으면 뒤에 알파벳을 붙여주세요 (예: 김민수B)";
  const low = n.toLowerCase();
  if (NAME_BAD.some(w => low.includes(w))) return "장난 이름은 쓸 수 없어요. 본명으로 올려주세요.";
  if (/^(.)\1+$/.test(n.replace(/[A-Za-z]$/, ""))) return "장난 이름은 쓸 수 없어요. 본명으로 올려주세요.";
  return "";
};
const normName = s => String(s || "").replace(/\s+/g, " ").trim();
const nowHM    = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const weekStart  = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toStr(d); }; // 월요일 시작
const monthStart = () => { const d = new Date(); return toStr(new Date(d.getFullYear(), d.getMonth(), 1)); };

// rows: 예약 목록 / 이미 끝난 예약만 집계, 같은 사람이 같은 시간에 겹쳐 예약한 건 한 번만 계산
const buildRanking = (rows, todayStr, nowStr) => {
  const people = new Map();
  for (const raw of rows) {
    const r = normT(raw);
    const name = normName(r.user_name);
    if (!name) continue;
    if (r.date > todayStr || (r.date === todayStr && r.end_time > nowStr)) continue; // 아직 안 끝난 예약 제외
    const s = toMin(r.start_time), e = toMin(r.end_time);
    if (!(e > s)) continue;
    const key = name;
    if (!people.has(key)) people.set(key, { key, name, cls: "", days: new Map() });
    const p = people.get(key);
    if (r.user_class) p.cls = r.user_class;
    if (!p.days.has(r.date)) p.days.set(r.date, []);
    p.days.get(r.date).push([s, e]);
  }
  const list = [...people.values()].map(p => {
    let minutes = 0;
    for (const spans of p.days.values()) {
      spans.sort((a, b) => a[0] - b[0]);
      let [cs, ce] = spans[0];
      for (let i = 1; i < spans.length; i++) {
        if (spans[i][0] <= ce) ce = Math.max(ce, spans[i][1]);
        else { minutes += ce - cs; [cs, ce] = spans[i]; }
      }
      minutes += ce - cs;
    }
    return { key: p.key, name: p.name, cls: p.cls, minutes, days: p.days.size };
  }).filter(p => p.minutes > 0);
  list.sort((a, b) => b.minutes - a.minutes || b.days - a.days || a.name.localeCompare(b.name, "ko"));
  let prev = null, rk = 0;
  list.forEach((p, i) => { if (p.minutes !== prev) { rk = i + 1; prev = p.minutes; } p.rank = rk; });
  return list;
};

// 많을 때를 대비해 나눠서 모두 가져옴
const fetchRankRows = async (from, to) => {
  const PAGE = 5000, all = [];
  for (let page = 0; page < 20; page++) {
    const r = await rpc("sj_rank_rows", { p_entry: AUTH.entry, p_from: from, p_to: to, p_off: page * PAGE, p_lim: PAGE });
    if (!r.ok || !Array.isArray(r.data.rows)) return null;
    for (const a of r.data.rows) all.push({ user_name: a[0], user_class: a[1], date: a[2], start_time: a[3], end_time: a[4] });
    if (r.data.rows.length < PAGE) break;
  }
  return all;
};

const slotStyle = (booked, total, locked) => {
  if (locked) return { bg: "#F1F3F9", tc: "#A8B4CC", label: "🔒" };
  const rem = total - booked;
  if (rem <= 0) return { bg: "#FEE2E2", tc: C.err, label: "마감" };
  if (rem <= 2) return { bg: "#FEF3C7", tc: C.warn, label: `${rem}석` };
  return { bg: "#ECFDF5", tc: C.ok, label: `${rem}석` };
};

// ═════════════════════════════════════════════
//  작은 UI 부품
// ═════════════════════════════════════════════
const Tag = ({ c, children }) => (
  <span style={{ background: c + "1A", color: c, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center" }}>{children}</span>
);

const Sheet = ({ onClose, children }) => (
  <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#00000099", zIndex: 900, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={e => e.stopPropagation()}
      style={{ background: C.card, borderRadius: "20px 20px 0 0", padding: "28px 24px 36px", width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto" }}>
      <div style={{ width: 40, height: 4, borderRadius: 99, background: C.border, margin: "-8px auto 20px" }} />
      {children}
    </div>
  </div>
);

const inputStyle = { width: "100%", padding: "13px 14px", borderRadius: 11, border: `1.5px solid ${C.border}`, fontSize: 15, outline: "none", boxSizing: "border-box" };
const labelStyle = { fontSize: 12, fontWeight: 700, color: C.mid, display: "block", marginBottom: 5 };
const ErrBox = ({ children }) => <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, padding: "9px 14px", fontSize: 12, color: C.err, marginBottom: 12 }}>{children}</div>;

// 한 번 누르면 "확인?"으로 바뀌고, 한 번 더 눌러야 실행 (브라우저 팝업 사용 안 함)
function ConfirmBtn({ label = "삭제", onConfirm, style }) {
  const [arm, setArm] = useState(false);
  useEffect(() => { if (!arm) return; const t = setTimeout(() => setArm(false), 3500); return () => clearTimeout(t); }, [arm]);
  if (arm) {
    return <button onClick={() => { setArm(false); onConfirm(); }}
      style={{ ...style, background: C.err, color: "#fff", border: "none" }}>정말 {label}?</button>;
  }
  return <button onClick={() => setArm(true)} style={style}>{label}</button>;
}

const Toggle = ({ on, onChange, color }) => (
  <button onClick={() => onChange(!on)} aria-pressed={on}
    style={{ width: 52, height: 30, borderRadius: 99, border: "none", cursor: "pointer", background: on ? (color || C.ok) : "#C8D0E0", position: "relative", flexShrink: 0, transition: "background .15s" }}>
    <span style={{ position: "absolute", top: 3, left: on ? 25 : 3, width: 24, height: 24, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
  </button>
);

const DEFAULT_LINKS = { home: "https://shinjeonsquare.com", cafe: "https://cafe.naver.com/shinjeon", blog: "https://blog.naver.com/ahffkanjfkrhgo", kakao: "https://pf.kakao.com/_MKxiYG/chat" };
function useWide(px = 900) {
  const q = () => typeof window !== "undefined" && window.innerWidth >= px;
  const [w, setW] = useState(q);
  useEffect(() => { const f = () => setW(q()); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return w;
}
const LINK_MASCOT = { home: ["board1", "홈페이지", "신전스퀘어 공식 사이트"], cafe: ["eraser1", "네이버 카페", "수강생 커뮤니티"], blog: ["pen1", "네이버 블로그", "합격 이야기·공지"], kakao: ["tri1", "카카오톡 상담", "1:1 문의하기"] };
function LinkBar({ links: given, dark }) {
  const links = Object.fromEntries(LINK_DEFS.map(([k]) => [k, cleanUrl(given?.[k]) || DEFAULT_LINKS[k]]));
  const wide = useWide(900);
  const items = LINK_DEFS.filter(([k]) => cleanUrl(links?.[k]));
  if (!items.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: wide && !dark ? "repeat(4, 1fr)" : "1fr 1fr", gap: 8, margin: dark ? "14px 0 0" : "0" }}>
      {items.map(([k]) => {
        const [img, t, sub] = LINK_MASCOT[k];
        const kk = k === "kakao";
        const grn = k === "cafe" || k === "blog";
        const nav = k === "home";
        const bg = kk ? "#FEE500" : grn ? "#03C75A" : nav ? (dark ? "#2B4C8C" : C.navy) : C.card;
        const fg = kk ? "#191919" : "#fff";
        return (
          <a key={k} href={cleanUrl(links[k])} target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, boxSizing: "border-box", textDecoration: "none", padding: "8px 10px", borderRadius: 14,
              background: bg, color: fg, border: `1px solid ${bg}`, boxShadow: dark ? "none" : "0 1px 4px #1B2B5A22" }}>
            <img src={`/mascot/${img}.webp`} alt="" width={40} height={44} loading="lazy" style={{ width: 40, height: 44, objectFit: "contain", flexShrink: 0 }} />
            <span style={{ minWidth: 0, textAlign: "left", lineHeight: 1.3 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 800, whiteSpace: "nowrap" }}>{t}</span>
              <span style={{ display: "block", fontSize: 10, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

// 입장 코드 화면용: 코드 입력 전에도 링크를 볼 수 있어요
function EntryLinks() {
  const [links, setLinks] = useState(null);
  useEffect(() => {
    let dead = false;
    (async () => { const r = await rpc("sj_public_links", {}, true); if (!dead && r.ok && r.data.ok) setLinks(r.data.links); })();
    return () => { dead = true; };
  }, []);
  return <LinkBar links={links || {}} dark />;
}

function TextCommit({ value, onCommit, multiline, maxLength, style, placeholder, allowEmpty }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const commit = () => {
    const t = multiline ? v : v.trim();
    if (!multiline && !t && !allowEmpty) { setV(value); return; }
    if (t !== value) onCommit(t);
  };
  if (multiline) {
    return <textarea value={v} maxLength={maxLength} rows={5} onChange={e => setV(e.target.value)} onBlur={commit} style={style} />;
  }
  return <input value={v} maxLength={maxLength} placeholder={placeholder} onChange={e => setV(e.target.value)} onBlur={commit}
    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} style={style} />;
}

// ═════════════════════════════════════════════
//  예약 시트
// ═════════════════════════════════════════════
function BookSheet({ studio, date, s1, s2, onClose, onSubmit, onSuccess }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem("sj_last_name") || ""; } catch { return ""; } });
  const [tutor, setTutor] = useState(() => { try { return localStorage.getItem("sj_last_tutor") || ""; } catch { return ""; } });
  const [pw, setPw]     = useState("");
  const [err, setErr]   = useState("");
  const [busy, setBusy] = useState(false);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = uid(); // 같은 예약 화면에서 다시 눌러도 같은 id → 중복 저장 방지
  const endTime = add30(s2);

  const confirm = async () => {
    if (busy) return;
    if (!name.trim()) { setErr("이름을 입력해주세요"); return; }
    if (!/^[0-9]{4}$/.test(pw)) { setErr("비밀번호는 숫자 4자리로 입력해주세요"); return; }
    setBusy(true); setErr("");
    const nm = name.replace(/\s+/g, " ").trim();
    const payload = { id: idRef.current, date, studio_id: studio.id, start_time: s1, end_time: endTime, user_name: nm, user_class: cleanTutor(tutor), user_pw: pw };
    const r = await onSubmit(payload);
    setBusy(false);
    if (r.ok) {
      try { localStorage.setItem("sj_last_name", nm); localStorage.setItem("sj_last_tutor", cleanTutor(tutor)); } catch {}
      onSuccess(payload);
    } else setErr(r.msg);
  };

  return (
    <Sheet onClose={busy ? () => {} : onClose}>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>예약하기</div>
      <div style={{ fontSize: 13, color: C.mid, marginBottom: 18 }}>
        <b style={{ color: studio.color }}>{studio.name}</b> · {fmt(date)}({DAY[dow(date)]}) · <b>{s1} ~ {endTime}</b>
      </div>
      {err && <ErrBox>{err}</ErrBox>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
        <div>
          <label style={labelStyle}>이름 *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="홍길동" autoFocus style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>담임 건축사 (선택)</label>
          <input value={tutor} onChange={e => setTutor(e.target.value)} maxLength={14} placeholder="이름만 입력 (예: 홍길동)" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>예약 비밀번호 (숫자 4자리) *</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pw}
            onChange={e => setPw(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={e => e.key === "Enter" && confirm()}
            placeholder="예약 취소 시 필요해요" style={{ ...inputStyle, letterSpacing: 8 }} />
          <div style={{ fontSize: 10, color: C.light, marginTop: 5 }}>⚠️ 예약 취소 시 이 비밀번호가 필요합니다. 기억해주세요!</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={confirm} disabled={busy}
          style={{ flex: 1, background: busy ? C.light : C.blue, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>
          {busy ? "예약 확인 중…" : "예약 확정"}
        </button>
        <button onClick={onClose} disabled={busy}
          style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px", cursor: "pointer", color: C.mid, fontSize: 13 }}>취소</button>
      </div>
    </Sheet>
  );
}

function DoneSheet({ booking, studio, info, onClose }) {
  return (
    <Sheet onClose={onClose}>
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{ fontSize: 52, marginBottom: 8 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: C.navy, marginBottom: 16 }}>예약 완료!</div>
        <div style={{ background: studio.bg, borderRadius: 14, padding: 18, marginBottom: 18, textAlign: "left", lineHeight: 2 }}>
          <b style={{ color: studio.color }}>{studio.name}</b><br />
          📅 {fmt(booking.date)} ({DAY[dow(booking.date)]})<br />
          🕐 {booking.start_time} ~ {booking.end_time}<br />
          👤 {booking.user_name}{tutTag(booking.user_class)}
        </div>
        {info && <div style={{ background: "#FFF8E8", borderRadius: 12, padding: 14, fontSize: 11, color: C.mid, textAlign: "left", lineHeight: 1.9, marginBottom: 20 }}>
          {info.split("\n").map((l, i) => <div key={i}>{l}</div>)}
        </div>}
        <button onClick={onClose} style={{ width: "100%", background: C.navy, color: "#fff", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>확인</button>
      </div>
    </Sheet>
  );
}

// ═════════════════════════════════════════════
//  관리자: 비밀번호 변경 / 잠금 추가
// ═════════════════════════════════════════════
function ChangePwSheet({ onClose, onChange }) {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [con, setCon] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const save = async () => {
    if (next.length < 4) { setErr("새 비밀번호는 4자 이상이어야 해요"); return; }
    if (next !== con) { setErr("새 비밀번호가 일치하지 않아요"); return; }
    setBusy(true); setErr("");
    const r = await onChange(cur, next);
    setBusy(false);
    if (r.ok) { setDone(true); setTimeout(onClose, 1300); } else setErr(r.msg);
  };
  return (
    <Sheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 6 }}>🔑 관리자 비밀번호 변경</div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 16 }}>4자 이상. 숫자만 쓰는 것보다 문자를 섞으면 훨씬 안전해요</div>
      {done ? (
        <div style={{ textAlign: "center", padding: "20px 0" }}><div style={{ fontSize: 40 }}>✅</div><div style={{ fontSize: 15, fontWeight: 700, color: C.ok }}>변경됐어요!</div></div>
      ) : (<>
        {err && <ErrBox>{err}</ErrBox>}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
          {[["현재 비밀번호", cur, setCur], ["새 비밀번호", next, setNext], ["새 비밀번호 확인", con, setCon]].map(([l, v, s]) => (
            <div key={l}><label style={labelStyle}>{l}</label><input type="password" value={v} onChange={e => s(e.target.value)} style={inputStyle} /></div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={save} disabled={busy} style={{ flex: 1, background: C.navy, color: "#fff", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, cursor: "pointer" }}>{busy ? "확인 중…" : "변경하기"}</button>
          <button onClick={onClose} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 16px", cursor: "pointer", color: C.mid }}>취소</button>
        </div>
      </>)}
    </Sheet>
  );
}

function LockSheet({ date, studio, studios, res = [], onClose, onSubmit }) {
  const [sid, setSid] = useState(studio?.id || "A");
  const [t1, setT1] = useState("09:00"); const [t2, setT2] = useState("22:00");
  const [reason, setReason] = useState("강의"); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const conflicts = res.filter(r => (sid === "ALL" || r.studio_id === sid) && r.start_time < t2 && r.end_time > t1);
  useEffect(() => { setAck(false); }, [sid, t1, t2]);
  const save = async () => {
    if (t1 >= t2) { setErr("종료시간이 시작보다 늦어야 해요"); return; }
    if (conflicts.length && !ack) { setAck(true); return; } // 기존 예약과 겹치면 한 번 더 확인 (예약은 자동 삭제하지 않음)
    setBusy(true);
    const ok = await onSubmit({ id: uid(), date, studio_id: sid, start_time: t1, end_time: t2, reason: reason.trim() || "강의" });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🔒 시간 잠금</div>
      <div style={{ fontSize: 12, color: C.mid, marginBottom: 16 }}>{fmt(date)}({DAY[dow(date)]}) 하루만 적용돼요</div>
      {err && <ErrBox>{err}</ErrBox>}
      {conflicts.length > 0 && (
        <div style={{ background: "#FFF7E0", border: `1.5px solid ${C.accent}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#8A6A12" }}>
          <b>⚠️ 이 시간에 이미 예약이 {conflicts.length}건 있어요.</b> 잠금을 설정해도 기존 예약은 지워지지 않아요.
          <div style={{ marginTop: 6, color: C.tx }}>{conflicts.slice(0, 6).map(r => <div key={r.id}>· {r.start_time}~{r.end_time} {r.user_name}{tutTag(r.user_class)}</div>)}{conflicts.length > 6 && <div>… 외 {conflicts.length - 6}건</div>}</div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
        <div>
          <label style={labelStyle}>스튜디오</label>
          <select value={sid} onChange={e => setSid(e.target.value)} style={{ ...inputStyle, padding: "11px 12px", fontSize: 14 }}>
            <option value="ALL">전체 스튜디오</option>
            {studios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[["시작", t1, setT1], ["종료", t2, setT2]].map(([l, v, s]) => (
            <div key={l}><label style={labelStyle}>{l}</label>
              <select value={v} onChange={e => s(e.target.value)} style={{ ...inputStyle, padding: "11px 12px", fontSize: 14 }}>
                {[...SLOTS, "22:00"].map(x => <option key={x} value={x}>{x}</option>)}
              </select></div>
          ))}
        </div>
        <div><label style={labelStyle}>사유</label><input value={reason} onChange={e => setReason(e.target.value)} style={{ ...inputStyle, padding: "11px 12px", fontSize: 14 }} /></div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={save} disabled={busy} style={{ flex: 1, background: C.err, color: "#fff", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, cursor: "pointer" }}>{busy ? "저장 중…" : conflicts.length && ack ? "예약이 있어도 잠금 설정" : "잠금 설정"}</button>
        <button onClick={onClose} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 16px", cursor: "pointer", color: C.mid }}>취소</button>
      </div>
    </Sheet>
  );
}

// ═════════════════════════════════════════════
//  타임 그리드 (학생/관리자 공용)
// ═════════════════════════════════════════════
function TimeGrid({ studio, studios, date, res, locks, isAdmin, info, onBook, onAddLock, blocked }) {
  const [sel1, setSel1] = useState(null);
  const [sel2, setSel2] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { setSel1(null); setSel2(null); }, [studio.id, date]);

  const lockOf = slot => manualLock(locks, studio.id, slot);
  const full = slot => slotBooked(res, studio.id, slot) >= studio.seats;
  const clearSel = () => { setSel1(null); setSel2(null); };

  const click = slot => {
    if (blocked || !studio.runs || lockOf(slot) || full(slot) || isPastSlot(date, slot)) return;
    if (!sel1 || slot < sel1) { setSel1(slot); setSel2(slot); return; }
    const range = SLOTS.filter(s => s >= sel1 && s <= slot);
    if (range.some(s => lockOf(s) || full(s) || isPastSlot(date, s))) { setSel1(slot); setSel2(slot); } // 중간에 잠금/마감이 있으면 새로 시작
    else setSel2(slot);
  };
  const inRange = s => sel1 && sel2 && s >= sel1 && s <= sel2;

  if (!studio.runs) {
    return (
      <div style={{ textAlign: "center", padding: "36px 10px", color: C.mid }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>🔒</div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>지금은 운영하지 않는 자습실이에요</div>
        {isAdmin && <div style={{ fontSize: 11, color: C.light, marginTop: 6 }}>관리 탭에서 열 수 있어요</div>}
      </div>
    );
  }

  return (
    <div>
      {sel1 ? (
        <div style={{ background: studio.bg, border: `1.5px solid ${studio.color}44`, borderRadius: 12, padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: studio.color }}>{sel1} ~ {add30(sel2)} 선택</span>
          <button onClick={() => setSheet("book")} style={{ background: studio.color, color: "#fff", border: "none", borderRadius: 9, padding: "7px 18px", fontWeight: 800, cursor: "pointer", fontSize: 13 }}>예약하기</button>
          <button onClick={clearSel} style={{ background: "none", border: `1px solid ${studio.color}66`, borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: studio.color, fontSize: 12 }}>취소</button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: C.light, marginBottom: 10 }}>☝️ 시작 시간 → 끝 시간 순서로 터치하세요</div>
      )}

      {blocked && <div style={{ background: "#FFF7E0", border: `1px solid ${C.accent}`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#8A6A12", fontWeight: 700, marginBottom: 12 }}>⏳ 최신 예약 현황을 확인하는 중이에요. 확인되면 예약할 수 있어요.</div>}

      {isAdmin && (
        <button onClick={() => setSheet("lock")}
          style={{ width: "100%", background: "#FEF2F2", border: `1px solid ${C.err}44`, borderRadius: 10, padding: 9, color: C.err, fontWeight: 700, cursor: "pointer", fontSize: 12, marginBottom: 12 }}>🔒 이 날 시간 잠금 추가</button>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {SLOTS.map(slot => {
          const lk = lockOf(slot);
          const cnt = slotBooked(res, studio.id, slot);
          const ss = slotStyle(cnt, studio.seats, lk);
          const sel = inRange(slot);
          const past = isPastSlot(date, slot);
          const who = isAdmin ? res.filter(r => r.studio_id === studio.id && overlaps(r, slot)) : [];
          return (
            <div key={slot}>
              <div onClick={() => click(slot)} style={{
                opacity: past ? 0.45 : 1,
                display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 9,
                background: sel ? studio.color : ss.bg,
                border: `1.5px solid ${sel ? studio.color : lk ? "#E2E8F0" : ss.tc + "44"}`,
                cursor: lk || full(slot) || past ? "not-allowed" : "pointer", userSelect: "none" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: sel ? "#fff9" : C.light, width: 40, flexShrink: 0 }}>{slot}</span>
                <div style={{ flex: 1, height: 5, background: sel ? "#fff4" : C.border, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: lk ? "100%" : `${Math.min((cnt / studio.seats) * 100, 100)}%`, background: sel ? "#fff" : lk ? "#C8D0E0" : ss.tc, borderRadius: 99 }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: sel ? "#fff" : ss.tc, width: lk ? 60 : 32, textAlign: "right", flexShrink: 0 }}>{lk ? `🔒${lk.reason || ""}` : ss.label}</span>
              </div>
              {who.length > 0 && (
                <div style={{ paddingLeft: 52, display: "flex", gap: 4, flexWrap: "wrap", margin: "2px 0" }}>
                  {who.map(r => <span key={r.id} style={{ background: studio.bg, borderRadius: 6, padding: "2px 8px", fontSize: 11, color: studio.color }}>{r.user_name}{tutTag(r.user_class)}</span>)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sheet === "book" && sel1 && (
        <BookSheet studio={studio} date={date} s1={sel1} s2={sel2}
          onClose={() => setSheet(null)} onSubmit={onBook}
          onSuccess={p => { setDone(p); setSheet(null); clearSel(); }} />
      )}
      {sheet === "lock" && <LockSheet date={date} studio={studio} studios={studios} res={res} onClose={() => setSheet(null)} onSubmit={onAddLock} />}
      {done && <DoneSheet booking={done} studio={studio} info={info} onClose={() => setDone(null)} />}
    </div>
  );
}

// ═════════════════════════════════════════════
//  내 예약 (서버에서 직접 조회 → 어느 날짜든 보임)
// ═════════════════════════════════════════════
function CancelSheet({ bookings, studios, onClose, onCancelOne, onDone }) {
  const [pws, setPws] = useState({}); const [errs, setErrs] = useState({}); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const run = async () => {
    const e = {};
    bookings.forEach(b => { if (!/^\d{4}$/.test(pws[b.id] || "")) e[b.id] = "비밀번호 4자리를 입력해주세요"; });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setMsg("");
    const bad = {}; let stop = "";
    for (const b of bookings) { // 비밀번호는 서버가 확인해요 (이 화면에는 비밀번호가 내려오지 않아요)
      const r = await onCancelOne(b.id, pws[b.id]);
      if (r.ok) continue;
      if (r.wrong) bad[b.id] = r.msg; else { stop = r.msg; break; }
    }
    setBusy(false); onDone();
    if (stop) { setMsg(stop); return; }
    if (Object.keys(bad).length) { setErrs(bad); return; }
    onClose();
  };
  return (
    <Sheet onClose={busy ? () => {} : onClose}>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>예약 취소</div>
      <div style={{ fontSize: 12, color: C.mid, marginBottom: 16 }}>{bookings.length}건 · 각 예약의 비밀번호를 입력하세요</div>
      {msg && <ErrBox>{msg}</ErrBox>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {bookings.map(b => {
          const st = studios.find(s => s.id === b.studio_id) || studios[0];
          return (
            <div key={b.id} style={{ background: st.bg, borderRadius: 11, padding: 12, border: `1px solid ${st.color}33` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: st.color, marginBottom: 6 }}>{st.name} · {fmt(b.date)}({DAY[dow(b.date)]}) {b.start_time}~{b.end_time}</div>
              <input type="password" inputMode="numeric" maxLength={4} value={pws[b.id] || ""}
                onChange={e => { setPws(p => ({ ...p, [b.id]: e.target.value.replace(/\D/g, "").slice(0, 4) })); setErrs(p => ({ ...p, [b.id]: "" })); }}
                placeholder="비밀번호 4자리"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: `1.5px solid ${errs[b.id] ? C.err : C.border}`, fontSize: 14, outline: "none", letterSpacing: 6, boxSizing: "border-box" }} />
              {errs[b.id] && <div style={{ fontSize: 11, color: C.err, marginTop: 4 }}>{errs[b.id]}</div>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={run} disabled={busy} style={{ flex: 1, background: C.err, color: "#fff", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, cursor: "pointer" }}>{busy ? "취소 중…" : `${bookings.length}건 취소`}</button>
        <button onClick={onClose} disabled={busy} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 16px", cursor: "pointer", color: C.mid }}>돌아가기</button>
      </div>
    </Sheet>
  );
}

function RankingTab({ since }) {
  const [period, setPeriod] = useState("week");
  const [rows, setRows] = useState(null);
  const [fail, setFail] = useState(false);
  const [me, setMe] = useState("");
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const base = period === "week" ? weekStart() : period === "month" ? monthStart() : "2000-01-01";
    const from = since && since > base ? since : base;
    if (from > today()) { setFail(false); setRows([]); return; }
    const data = await fetchRankRows(from, today());
    if (id !== reqId.current) return;
    if (data === null) { setFail(true); return; }
    setFail(false);
    setRows(buildRanking(data, today(), nowHM()));
  }, [period, since]);

  useEffect(() => { setRows(null); load(); const t = setInterval(() => { if (document.visibilityState !== "hidden") load(); }, 60000); return () => clearInterval(t); }, [load]);

  const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
  const top = rows ? rows.filter(p => p.rank <= 5).slice(0, 10) : [];
  const max = top.length ? top[0].minutes : 1;
  const q = normName(me);
  const mine = q && rows ? rows.filter(p => p.name === q) : [];

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🏆 공부왕 랭킹</div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 12 }}>예약해서 이용을 마친 시간 기준이에요 (출석 체크가 아니라 예약 기준){since && ` · ${fmt(since)}부터 집계`}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[["week", "이번 주"], ["month", "이번 달"], ["all", "전체"]].map(([k, l]) => (
          <button key={k} onClick={() => setPeriod(k)} style={{ flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 13,
            border: `1.5px solid ${period === k ? C.blue : C.border}`, background: period === k ? C.blue : C.card, color: period === k ? "#fff" : C.mid }}>{l}</button>
        ))}
      </div>
      {fail && <div style={{ background: "#FFF1F0", color: C.err, borderRadius: 10, padding: 12, fontSize: 12, marginBottom: 12 }}>랭킹을 불러오지 못했어요. <button onClick={load} style={{ border: "none", background: "none", color: C.err, fontWeight: 800, textDecoration: "underline", cursor: "pointer" }}>다시 시도</button></div>}
      {rows === null && !fail && <div style={{ textAlign: "center", padding: 40, color: C.mid }}>⏳ 불러오는 중…</div>}
      {rows && rows.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.mid }}>아직 기록이 없어요. 첫 번째 공부왕이 되어보세요! 📚</div>}
      {top.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {top.map(p => (
            <div key={p.key} style={{ background: C.card, border: `1px solid ${p.rank <= 3 ? C.accent : C.border}`, borderRadius: 13, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 40, fontSize: p.rank <= 3 ? 24 : 15, fontWeight: 900, color: C.navy, textAlign: "center" }}>{medal(p.rank)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}{p.cls && <span style={{ fontWeight: 400, fontSize: 11, color: C.light }}> · 담임 {p.cls}</span>}</div>
                  <div style={{ fontSize: 11, color: C.mid }}>{p.days}일 이용</div>
                </div>
                <div style={{ fontWeight: 900, color: C.blue, fontSize: 15 }}>{fmtDur(p.minutes)}</div>
              </div>
              <div style={{ height: 6, background: C.bg, borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                <div style={{ width: `${Math.max(4, Math.round(p.minutes / max * 100))}%`, height: "100%", background: p.rank === 1 ? C.accent : C.blue }} />
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 18, background: C.card, border: `1px solid ${C.border}`, borderRadius: 13, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.mid, marginBottom: 8 }}>내 순위 찾기</div>
          <input value={me} onChange={e => setMe(e.target.value)} placeholder="이름 입력" style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 14, boxSizing: "border-box" }} />
          {q && mine.length === 0 && <div style={{ fontSize: 12, color: C.light, marginTop: 8 }}>이 기간에 이용 완료한 기록이 없어요</div>}
          {mine.map(p => <div key={p.key} style={{ fontSize: 13, color: C.navy, marginTop: 8, fontWeight: 700 }}>{p.name}{tutTag(p.cls)} — {p.rank}등 · {fmtDur(p.minutes)} · {p.days}일</div>)}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════
//  ✍️ 작도 챌린지: 인증 사진 올리기 · 주간 순위 · 누적 순위
//  사진은 작게 줄여서 서버에 올리고, 조회·삭제·순위 계산은 모두 서버 함수가 처리해요.
// ═════════════════════════════════════════════
const thumbCache = new Map();
const readImageEl = file => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file); const im = new Image();
  im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
  im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img")); };
  im.src = url;
});
// 일반 방식이 안 되면 브라우저의 다른 해독 방식으로 한 번 더 시도해요
const readImage = async file => {
  try { return await readImageEl(file); }
  catch (e) { if (typeof createImageBitmap === "function") return await createImageBitmap(file); throw e; }
};
const photoErrMsg = f => /hei[cf]/i.test((f && (f.type + " " + f.name)) || "")
  ? "HEIC 사진은 읽을 수 없어요. 갤러리에서 사진을 열어 '캡처(스크린샷)'하거나 JPG로 저장해서 올려주세요"
  : "사진을 읽지 못했어요. 갤러리에서 다시 선택하거나, 사진을 캡처(스크린샷)해서 올려주세요";
const shrinkImg = (im, max, q) => {
  const k = Math.min(1, max / Math.max(im.width, im.height));
  const w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(im, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", q);
};
// 긴 변 1000px로 줄이고 용량이 크면 화질을 낮춰요 (보관 용량 절약)
const compressPhoto = async file => {
  const im = await readImage(file);
  let q = 0.62, photo = shrinkImg(im, 1000, q);
  while (photo.length > 150000 && q > 0.36) { q -= 0.08; photo = shrinkImg(im, 1000, q); }
  if (photo.length > 150000) photo = shrinkImg(im, 800, 0.5);
  return { photo, thumb: shrinkImg(im, 220, 0.6) };
};
const rankRows = (rows, keyOf) => {
  let r = 1;
  return rows.map((p, i) => { if (i > 0 && keyOf(p) !== keyOf(rows[i - 1])) r = i + 1; return { ...p, rank: r }; });
};
const byDays = rows => [...(rows || [])].sort((a, b) => (b.days || 0) - (a.days || 0) || String(a.name).localeCompare(String(b.name), "ko"));
const COMBO = n => n >= 30 ? ["👑", "#B8860B", "#FFF3C4"] : n >= 21 ? ["🏆", "#B8860B", "#FFF3C4"] : n >= 14 ? ["🥇", "#9A6A00", "#FFF0CC"] : n >= 7 ? ["🏅", "#C2410C", "#FFE7D6"] : n >= 3 ? ["🔥", "#C2410C", "#FFE7D6"] : ["✨", "#4A5A85", "#EEF3FF"];
const RAINBOW = ["#EF4444", "#F97316", "#FACC15", "#22C55E", "#3B82F6", "#4F46E5", "#A855F7"]; // 빨 주 노 초 파 남 보
// 요일 칸 색: 연속 인증 n번째 날 = 빨·주·노·초·파·남·보 순서, 2바퀴째부터 칸 안에 ×2, ×3
function dotLevels(ds, today, cur) {
  const days = [...(ds || [])].sort(); const out = {};
  let run = [];
  const flush = (isLast) => {
    if (!run.length) return;
    const last = run[run.length - 1];
    const live = isLast && cur > 0 && (last === today || last === addDays(today, -1));
    run.forEach((d, i) => { out[d] = live ? Math.max(1, cur - (run.length - 1 - i)) : i + 1; });
    run = [];
  };
  days.forEach((d, i) => { if (run.length && addDays(run[run.length - 1], 1) !== d) flush(false); run.push(d); });
  flush(true);
  return out;
}
const dotStyle = (idx) => ({ background: RAINBOW[(idx - 1) % 7], color: ((idx - 1) % 7) === 2 ? "#5B4B00" : "#fff" });
function Combo({ streaks, name, dark }) {
  const n = streaks && streaks[name] ? streaks[name].cur || 0 : 0;
  if (n < 2) return null;
  const [ic] = COMBO(n);
  const k = Math.ceil(n / 7); const cyc = ((n - 1) % 7) + 1; const col = RAINBOW[cyc - 1];
  const darkTxt = cyc === 3; // 노랑 위에는 어두운 글씨
  return (
    <span style={{ display: "inline-block", marginLeft: 8, fontSize: dark ? 13 : 15, fontWeight: 900, padding: dark ? "3px 11px" : "4px 13px", borderRadius: 999, background: col, color: darkTxt ? "#5B4B00" : "#fff", boxShadow: `0 0 12px ${col}AA`, animation: "sjGlow 1.6s ease-in-out infinite", whiteSpace: "nowrap", verticalAlign: "middle", lineHeight: 1.3 }}>{ic} {n}일 연속{n >= 3 ? " COMBO!" : ""}{k >= 2 ? ` ×${k}` : ""}</span>
  );
}
const COMBO_TIERS = [["✨", "2일 연속", "좋은 시작!"], ["🔥", "3일 연속", "COMBO 시작! 불이 붙었어요"], ["🏅", "7일 연속", "일주일 개근 메달"], ["🥇", "14일 연속", "2주 연속, 금메달"], ["🏆", "21일 연속", "3주 연속, 트로피"], ["👑", "30일 연속", "명예의 전당 입성!"]];
function StreakBoard({ streaks }) {
  const rows = Object.entries(streaks || {}).map(([name, v]) => ({ name, cur: v.cur || 0, best: v.best || 0 })).filter(r => r.cur >= 1)
    .sort((a, b) => b.cur - a.cur || b.best - a.best || a.name.localeCompare(b.name, "ko"));
  let rk = 0, prev = null; rows.forEach((r, i) => { if (r.cur !== prev) { rk = i + 1; prev = r.cur; } r.rank = rk; });
  const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
  if (!rows.length) return <div style={{ textAlign: "center", padding: 30, color: C.mid, fontSize: 13 }}>아직 연속 기록이 없어요. 오늘부터 시작해 보세요! 🔥</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, color: C.light }}>지금 연속으로 인증 중인 일수 순이에요 (같은 일수는 같은 등수) · 하루 빠지면 처음부터!</div>
      {rows.map(p => (
        <div key={p.name} style={{ background: C.card, border: `1px solid ${p.rank <= 3 ? C.accent : C.border}`, borderRadius: 13, padding: "11px 14px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 40, fontSize: p.rank <= 3 ? 24 : 15, fontWeight: 900, color: C.navy, textAlign: "center" }}>{medal(p.rank)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}<Combo streaks={streaks} name={p.name} /></div>
            <div style={{ fontSize: 11, color: C.mid }}>지금 {p.cur}일 연속 · 최고 {p.best}일</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ComboGuide({ dark }) {
  const fg = dark ? "#fff" : C.navy, sub = dark ? "#a0b0cc" : C.mid;
  return (
    <details style={{ marginTop: 10, background: dark ? "#ffffff10" : "#EEF3FF", borderRadius: 10, padding: "8px 12px", textAlign: "left" }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, color: dark ? "#FFD27A" : C.navy, listStyle: "none" }}>🔥 COMBO가 뭐예요? <span style={{ fontWeight: 600, color: sub }}>(눌러서 보기)</span></summary>
      <div style={{ fontSize: 11, color: sub, lineHeight: 1.8, marginTop: 6 }}>하루에 한 장이라도 완성된 도면을 올리면 그날은 인증 OK! 인증한 날이 이어질수록 이름 아래에 배지가 붙고, 🌈 빨·주·노·초·파·남·보 칸이 하루에 하나씩 채워져요. 7칸이 다 차면 다음 바퀴는 칸 안에 ×2, ×3…으로 쌓여요. 하루라도 건너뛰면 처음부터 다시 세요. (어제까지 이어졌다면 오늘 안에 올리면 유지돼요)</div>
      {COMBO_TIERS.map(([ic, d, t]) => <div key={d} style={{ display: "flex", gap: 8, fontSize: 12, color: fg, padding: "3px 0" }}><span style={{ width: 22, textAlign: "center" }}>{ic}</span><b style={{ width: 62 }}>{d}</b><span style={{ color: sub }}>{t}</span></div>)}
    </details>
  );
}
const byPosts = rows => [...(rows || [])].sort((a, b) => (b.posts || 0) - (a.posts || 0) || String(a.name).localeCompare(String(b.name), "ko"));
const SESS_LABEL = { 1: "1교시", 2: "2교시", 3: "3교시" };

function ChalPostSheet({ title, onClose, onDone }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem("sj_last_name") || ""; } catch { return ""; } });
  const [sess, setSess] = useState(0); const [minutes, setMinutes] = useState("");
  const [file, setFile] = useState(null); const [preview, setPreview] = useState("");
  const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const idRef = useRef(uid()); const prepRef = useRef(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const pick = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFile(f); setPreview(URL.createObjectURL(f)); setErr("");
    // 사진을 고르자마자 바로 줄여서 준비해요 (나중에 파일 접근이 끊겨도 올릴 수 있게)
    const pr = compressPhoto(f).catch(() => null); prepRef.current = pr;
    pr.then(r => { if (prepRef.current === pr && !r) setErr(photoErrMsg(f)); });
  };
  const submit = async () => {
    const nm = normName(name); const mins = parseInt(minutes, 10);
    if (!nm) return setErr("이름을 입력해주세요");
    { const np = nameProblem(nm); if (np) return setErr(np); }
    if (!sess) return setErr("교시를 선택해주세요");
    if (!mins || mins < 5 || mins > 600) return setErr("작도시간(분)을 5~600 사이로 입력해주세요");
    if (!file) return setErr("작도한 사진을 선택해주세요");
    if (!/^\d{4}$/.test(pw)) return setErr("삭제용 비밀번호 숫자 4자리를 입력해주세요");
    setBusy(true); setErr("");
    let img;
    try { img = (prepRef.current && await prepRef.current) || await compressPhoto(file); } catch { setBusy(false); return setErr(photoErrMsg(file)); }
    let r = null;
    for (let i = 0; i < 3; i++) { // 같은 번호로 다시 보내므로 중복으로 올라가지 않아요
      r = await rpc("sj_chal_post", { p_entry: AUTH.entry, p: { id: idRef.current, name: nm, sess, minutes: mins, photo: img.photo, thumb: img.thumb, pw } });
      if (r.status !== 0 && r.status < 500) break;
      if (i < 2) await new Promise(x => setTimeout(x, 800));
    }
    setBusy(false);
    if (r.ok) { try { localStorage.setItem("sj_last_name", nm); } catch {} onDone(); return; }
    setErr(r.status === 0 || r.status >= 500 ? "서버 응답을 확인하지 못했어요. 올라갔을 수 있으니 목록을 확인하고, 없으면 다시 눌러주세요" : failMsg(r, "올리지 못했어요. 잠시 후 다시 시도해주세요"));
  };
  return (
    <Sheet onClose={busy ? () => {} : onClose}>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>📸 작도 인증 올리기</div>
      <div style={{ fontSize: 12, color: C.mid, marginBottom: 16 }}>{title} · 하루에 몰아서 올리는 건 1일로 계산돼요</div>
      <div style={{ fontSize: 12, color: C.navy, background: "#EEF3FF", borderRadius: 8, padding: "8px 10px", marginBottom: 12, lineHeight: 1.5, fontWeight: 700 }}>✅ <b>완성된 도면만</b> 올려주세요. 하루에 한 장만 올려도 <b>그날은 인증 OK</b>예요. 연속으로 하면 🔥 <b>COMBO!</b></div>
      <div style={{ fontSize: 11, color: C.err, background: "#FFF8E6", borderRadius: 8, padding: "8px 10px", marginBottom: 12, lineHeight: 1.5 }}>📦 서버 용량을 아끼기 위해 <b>올린 지 3주가 지난 사진은 작은 사진으로 바뀌고 확대할 수 없어요.</b> (인증 횟수·순위는 그대로예요)</div>
      {err && <ErrBox>{err}</ErrBox>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
        <div><label style={labelStyle}>이름 *</label><input value={name} onChange={e => setName(e.target.value)} placeholder="홍길동" style={inputStyle} /></div>
        <div>
          <label style={labelStyle}>교시 *</label>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3].map(n => <button key={n} onClick={() => setSess(n)} style={{ flex: 1, padding: "11px 0", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 14,
              border: `1.5px solid ${sess === n ? C.blue : C.border}`, background: sess === n ? C.blue : C.card, color: sess === n ? "#fff" : C.mid }}>{SESS_LABEL[n]}</button>)}
          </div>
        </div>
        <div>
          <label style={labelStyle}>작도 시간(분) *</label>
          <input type="number" inputMode="numeric" min={5} max={600} value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="예: 50" style={inputStyle} />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {[30, 50, 60, 90, 120].map(n => <button key={n} onClick={() => setMinutes(String(n))} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, color: C.mid, fontSize: 12, cursor: "pointer" }}>{n}분</button>)}
          </div>
        </div>
        <div>
          <label style={labelStyle}>작도 사진 *</label>
          <input type="file" accept="image/*" onChange={pick} style={{ fontSize: 13, width: "100%" }} />
          {preview && <img src={preview} alt="미리보기" style={{ marginTop: 8, width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 10, background: C.bg }} />}
        </div>
        <div>
          <label style={labelStyle}>내 비밀번호 (숫자 4자리) *</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pw} onChange={e => setPw(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="항상 같은 번호로 입력해주세요" style={{ ...inputStyle, letterSpacing: 8 }} />
          <div style={{ fontSize: 10, color: C.light, marginTop: 5, lineHeight: 1.6 }}>🛡 부적절한 사진은 삭제해도 3일간 관리자가 올린 사람과 함께 확인할 수 있어요.<br />🔒 <b>이름 + 비밀번호</b>가 나예요. 처음 정한 번호를 계속 써주세요. 이름이 같은 다른 분은 번호가 다르면 이름 뒤에 B 같은 구분을 붙여요. 잘못 올린 인증을 지울 때도 필요해요.<br />🙋 비밀번호를 잊었다면 <b>카카오톡 상담</b>으로 이름과 함께 알려주세요. 관리자가 새 번호를 정해드려요. (기록은 그대로예요)</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={submit} disabled={busy} style={{ flex: 1, background: busy ? C.light : C.blue, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>{busy ? "올리는 중…" : "인증 올리기"}</button>
        <button onClick={onClose} disabled={busy} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px", cursor: "pointer", color: C.mid, fontSize: 13 }}>닫기</button>
      </div>
    </Sheet>
  );
}

function ChalPhotoSheet({ post, admin, onClose, onDeleted }) {
  const [photo, setPhoto] = useState(""); const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => {
    if (post.arch) return undefined;
    let dead = false;
    (async () => {
      const r = await rpc("sj_chal_photo", { p_entry: AUTH.entry, p_id: post.id }, true);
      if (dead) return;
      if (r.ok) setPhoto(r.data.photo); else setErr(failMsg(r, "사진을 불러오지 못했어요"));
    })();
    return () => { dead = true; };
  }, [post.id, post.arch]);
  const del = async () => {
    if (!admin && !/^\d{4}$/.test(pw)) return setErr("비밀번호 4자리를 입력해주세요");
    setBusy(true); setErr("");
    const r = admin ? await rpc("sj_admin_chal_del", { p_token: AUTH.token, p_id: post.id }) : await rpc("sj_chal_del", { p_entry: AUTH.entry, p_id: post.id, p_pw: pw });
    setBusy(false);
    if (r.ok || r.data.code === "not_found") { thumbCache.delete(post.id); onDeleted(); return; }
    setErr(r.data.code === "wrong_pw" ? `비밀번호가 틀려요${typeof r.data.left === "number" ? ` (남은 시도 ${r.data.left}번)` : ""}` : failMsg(r, "삭제하지 못했어요"));
  };
  return (
    <Sheet onClose={busy ? () => {} : onClose}>
      <div style={{ fontSize: 16, fontWeight: 900, color: C.navy, marginBottom: 2 }}>{post.name}</div>
      <div style={{ fontSize: 12, color: C.mid, marginBottom: 12 }}>{fmt(post.day)} {post.at} · {SESS_LABEL[post.sess]} · {post.minutes}분</div>
      {post.arch ? (
        <div style={{ textAlign: "center" }}>
          {thumbCache.get(post.id) && <img src={thumbCache.get(post.id)} alt="작도 사진(축소)" style={{ width: 160, borderRadius: 10, background: C.bg }} />}
          <div style={{ fontSize: 12, color: C.mid, marginTop: 8 }}>올린 지 3주가 지나 작은 사진만 남아 있어요 (확대 불가)</div>
        </div>
      ) : photo ? <img src={photo} alt="작도 사진" style={{ width: "100%", borderRadius: 10, background: C.bg }} /> : !err && <div style={{ textAlign: "center", padding: 40, color: C.mid }}>⏳ 사진 불러오는 중…</div>}
      {err && <div style={{ marginTop: 10 }}><ErrBox>{err}</ErrBox></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        {!admin && <input type="password" inputMode="numeric" maxLength={4} value={pw} onChange={e => setPw(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="삭제용 비밀번호" style={{ ...inputStyle, padding: "10px 12px", fontSize: 13, flex: 1 }} />}
        <ConfirmBtn label={busy ? "삭제 중…" : admin ? "관리자 삭제" : "내 인증 삭제"} onConfirm={del} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", color: C.err, fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }} />
        <button onClick={onClose} style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", cursor: "pointer", fontWeight: 800, fontSize: 13 }}>닫기</button>
      </div>
    </Sheet>
  );
}

function TrashBox() {
  const [open, setOpen] = useState(false); const [items, setItems] = useState(null); const [err, setErr] = useState(""); const [big, setBig] = useState(null);
  const load = async () => {
    setErr(""); const r = await rpc("sj_admin_chal_trash", { p_token: AUTH.token });
    if (r.ok) setItems(r.data.items || []); else if (r.data.code !== "auth") setErr(failMsg(r, "불러오지 못했어요"));
  };
  const show = async it => {
    setBig({ ...it, photo: it.thumb });
    const r = await rpc("sj_admin_chal_trash_photo", { p_token: AUTH.token, p_id: it.id });
    if (r.ok) setBig(b => b && b.id === it.id ? { ...b, photo: r.data.photo } : b);
  };
  return (
    <div style={{ marginTop: 14, padding: 12, background: C.bg, borderRadius: 12 }}>
      <div onClick={() => { const n = !open; setOpen(n); if (n) load(); }} style={{ fontSize: 13, fontWeight: 800, color: C.navy, cursor: "pointer" }}>🗑 삭제된 인증 (3일 보관) {open ? "▲" : "▼"}</div>
      <div style={{ fontSize: 11, color: C.light, marginTop: 4, lineHeight: 1.6 }}>누가 지웠든 삭제된 인증은 3일 동안 관리자만 볼 수 있어요. 올린 이름·시각·접속 주소가 함께 보여요.</div>
      {open && (<div style={{ marginTop: 10 }}>
        {err && <div style={{ fontSize: 12, color: C.err, marginBottom: 8 }}>{err} <button onClick={load} style={{ border: "none", background: "none", color: C.blue, fontWeight: 700, cursor: "pointer" }}>다시 시도</button></div>}
        {!items && !err && <div style={{ fontSize: 12, color: C.mid }}>⏳ 불러오는 중…</div>}
        {items && items.length === 0 && <div style={{ fontSize: 12, color: C.mid }}>삭제된 인증이 없어요.</div>}
        {items && items.map(it => (
          <div key={it.id} onClick={() => show(it)} style={{ display: "flex", gap: 10, alignItems: "center", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8, marginBottom: 6, cursor: "pointer" }}>
            <img src={it.thumb} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, background: C.bg }} />
            <div style={{ fontSize: 11, color: C.mid, lineHeight: 1.6, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>{it.name} · {SESS_LABEL[it.sess]} · {it.minutes}분</div>
              <div>올림 {it.up_at} · 삭제 {it.del_at}</div>
              <div style={{ wordBreak: "break-all" }}>접속 주소 {it.ip || "기록 없음"}</div>
            </div>
          </div>
        ))}
      </div>)}
      {big && (
        <div onClick={() => setBig(null)} style={{ position: "fixed", inset: 0, background: "#000000CC", zIndex: 400, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <img src={big.photo} alt="" style={{ maxWidth: "100%", maxHeight: "75vh", borderRadius: 10 }} />
          <div style={{ color: "#fff", fontSize: 13, marginTop: 10, textAlign: "center", lineHeight: 1.7 }}>{big.name} · 올림 {big.up_at} · 삭제 {big.del_at}<br />접속 주소 {big.ip || "기록 없음"} · 화면을 누르면 닫혀요</div>
        </div>
      )}
    </div>
  );
}
function ResetPw() {
  const [name, setName] = useState(""); const [pw, setPw] = useState(""); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const go = async () => {
    const n = normName(name);
    if (!n || !/^\d{4}$/.test(pw)) { setMsg({ ok: false, t: "이름과 새 비밀번호(숫자 4자리)를 입력해주세요" }); return; }
    setBusy(true); setMsg(null);
    const r = await rpc("sj_admin_chal_reset_pw", { p_token: AUTH.token, p_name: n, p_new: pw });
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, t: `${n} 님의 비밀번호를 새로 정했어요 (인증 ${r.data.count}건)` }); setPw(""); } else if (r.data.code !== "auth") setMsg({ ok: false, t: failMsg(r, "바꾸지 못했어요") });
  };
  return (
    <div style={{ marginTop: 14, padding: 12, background: C.bg, borderRadius: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.navy, marginBottom: 8 }}>🔑 참가자 비밀번호 초기화</div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 8, lineHeight: 1.6 }}>비밀번호를 잊은 참가자의 이름과 새 번호를 정해주면, 그 이름의 모든 인증 비밀번호가 새 번호로 바뀌어요. 기록(연속·인증일)은 그대로예요.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="이름" maxLength={30} style={{ ...inputStyle, flex: 1 }} />
        <input value={pw} onChange={e => setPw(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="새 번호 4자리" inputMode="numeric" style={{ ...inputStyle, width: 120 }} />
      </div>
      <button onClick={go} disabled={busy} style={{ marginTop: 8, background: C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "9px 16px", fontWeight: 800, cursor: "pointer", fontSize: 13 }}>{busy ? "바꾸는 중…" : "비밀번호 새로 정하기"}</button>
      {msg && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: msg.ok ? C.ok : C.err }}>{msg.ok ? "✅ " : "⚠️ "}{msg.t}</div>}
    </div>
  );
}
function ChalAdmin({ cfg, examDate, onSaved }) {
  const [name, setName] = useState(cfg.name || "작도 챌린지");
  const [start, setStart] = useState(cfg.start || ""); const [end, setEnd] = useState(cfg.end || examDate || ""); const [goal, setGoal] = useState(String(cfg.goal || 5));
  const [active, setActive] = useState(!!cfg.active); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [usage, setUsage] = useState(null);
  useEffect(() => { setName(cfg.name || "작도 챌린지"); setStart(cfg.start || ""); setEnd(cfg.end || examDate || ""); setGoal(String(cfg.goal || 5)); setActive(!!cfg.active); }, [cfg.name, cfg.start, cfg.end, cfg.goal, cfg.active, examDate]);
  const loadUsage = useCallback(async () => { const r = await rpc("sj_admin_chal_usage", { p_token: AUTH.token }); if (r.ok) setUsage(r.data); }, []);
  useEffect(() => { loadUsage(); }, [loadUsage]);
  const days = start && end ? Math.round((new Date(end + "T12:00:00") - new Date(start + "T12:00:00")) / 86400000) + 1 : 0;
  const weeks = days > 0 ? Math.ceil(days / 7) : 0;
  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await rpc("sj_admin_chal_cfg", { p_token: AUTH.token, p: { name, start, end, goal: parseInt(goal, 10), active } });
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, t: "저장했어요" }); onSaved(); } else if (r.data.code !== "auth") setMsg({ ok: false, t: failMsg(r, "저장하지 못했어요") });
  };
  const mb = usage ? (usage.bytes / 1048576).toFixed(1) : "-";
  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 12 }}>✍️ 작도 챌린지 설정</div>
      <label style={labelStyle}>챌린지 이름</label>
      <input value={name} onChange={e => setName(e.target.value)} maxLength={30} style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
        <div style={{ flex: 1 }}><label style={labelStyle}>시작일</label><input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} /></div>
        <div style={{ flex: 1 }}><label style={labelStyle}>종료일</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} /></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {examDate && <button onClick={() => setEnd(examDate)} style={{ border: `1px solid ${C.border}`, background: C.bg, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, color: C.mid, cursor: "pointer" }}>종료일을 시험일({fmt(examDate)})로</button>}
        <span style={{ fontSize: 12, color: C.light }}>{weeks > 0 ? `총 ${days}일 · ${weeks}주 (시작일부터 7일씩 1주차)` : "날짜를 선택해주세요"}</span>
      </div>
      <div style={{ marginBottom: 10 }}><label style={labelStyle}>주 목표 (일)</label><input type="number" min={1} max={7} value={goal} onChange={e => setGoal(e.target.value)} style={{ ...inputStyle, width: 100 }} /></div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}><Toggle on={active} onChange={setActive} color={C.ok} /><span style={{ fontSize: 13, color: C.mid }}>{active ? "진행 중 (학생이 인증을 올릴 수 있어요)" : "중지 (탭에 '준비 중'으로 표시)"}</span></div>
      {msg && <div style={{ fontSize: 12, color: msg.ok ? C.ok : C.err, marginBottom: 8, fontWeight: 700 }}>{msg.t}</div>}
      {(() => {
        const dirty = name !== (cfg.name || "작도 챌린지") || start !== (cfg.start || "") || end !== (cfg.end || examDate || "") || String(goal) !== String(cfg.goal || 5) || !!active !== !!cfg.active;
        return (<>
          {dirty && <div style={{ fontSize: 12, color: C.warn, fontWeight: 800, background: "#FFF8E6", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>⚠️ 아직 저장 전이에요. 아래 <b>챌린지 설정 저장</b> 버튼을 눌러야 적용돼요.</div>}
          <button onClick={save} disabled={busy} style={{ background: dirty ? C.blue : C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 800, cursor: "pointer", fontSize: 14, boxShadow: dirty ? "0 0 0 3px #3A5BB544" : "none" }}>{busy ? "저장 중…" : dirty ? "💾 챌린지 설정 저장 (눌러야 적용)" : "챌린지 설정 저장"}</button>
        </>);
      })()}
      <div style={{ fontSize: 11, color: C.light, marginTop: 12, lineHeight: 1.7 }}>🗜 올린 지 3주가 지난 사진은 자동으로 작은 사진(확대 불가)이 돼요. <button onClick={async () => { const r = await rpc("sj_admin_chal_purge", { p_token: AUTH.token }); if (r.ok) { setMsg({ ok: true, t: `${r.data.n}장을 작은 사진으로 줄였어요` }); loadUsage(); } }} style={{ border: `1px solid ${C.border}`, background: C.bg, borderRadius: 7, padding: "3px 8px", fontSize: 11, fontWeight: 700, color: C.mid, cursor: "pointer" }}>지금 정리하기</button></div>
      <ResetPw />
      <TrashBox />
      <div style={{ fontSize: 11, color: C.light, marginTop: 6, lineHeight: 1.7 }}>📦 보관 중인 인증 사진: {usage ? `${usage.count}장 · ${mb}MB` : "확인 중…"} (무료 서버 용량은 약 500MB예요)</div>
      {usage && usage.bytes > 350 * 1048576 && <div style={{ fontSize: 12, color: C.err, fontWeight: 800, marginTop: 6 }}>⚠️ 용량이 {Math.round(usage.bytes / 5242880)}% 찼어요. 500MB가 넘으면 예약 저장도 멈춰요. 오래된 사진을 지우거나 유료 전환이 필요해요.</div>}
    </div>
  );
}

// 관리 탭 안의 "작도 챌린지" 설정 화면
function ChalSettings({ examDate }) {
  const [cfg, setCfg] = useState(null); const [fail, setFail] = useState("");
  const load = useCallback(async () => {
    const r = await rpc("sj_chal_board", { p_entry: AUTH.entry, p_week: null });
    if (!r.ok) { setFail(failMsg(r, "챌린지 설정을 불러오지 못했어요")); return; }
    setFail(""); setCfg(r.data.cfg);
  }, []);
  useEffect(() => { load(); }, [load]);
  if (fail) return <div style={{ background: "#FFF1F0", color: C.err, borderRadius: 10, padding: 12, fontSize: 12 }}>{fail} <button onClick={load} style={{ border: "none", background: "none", color: C.blue, fontWeight: 700, cursor: "pointer" }}>다시 시도</button></div>;
  if (!cfg) return <div style={{ textAlign: "center", padding: 30, color: C.mid }}>⏳ 불러오는 중…</div>;
  return <ChalAdmin cfg={cfg} examDate={examDate} onSaved={load} />;
}

// 👀 둘러보기: 입장 코드 없이 구경만 (예약 현황·예약자·큰 사진은 보이지 않고, 예약·인증도 할 수 없어요)
function GuestView({ onExit }) {
  const wide = useWide(900);
  const [tab, setTab] = useState("book");
  const todayN = useTodayN(); const [info, setInfo] = useState(null); const [chal, setChal] = useState(null); const [week, setWeek] = useState(null); const [view, setView] = useState("week"); const [fail, setFail] = useState("");
  useEffect(() => {
    let dead = false;
    (async () => {
      const [r, l] = await Promise.all([rpc("sj_public_info", {}, true), rpc("sj_public_links", {}, true)]);
      if (dead) return;
      if (r.ok && r.data.ok) setInfo({ ...r.data, links: l.ok && l.data.ok ? l.data.links : {} }); else setFail("정보를 불러오지 못했어요");
    })();
    return () => { dead = true; };
  }, []);
  useEffect(() => {
    if (tab !== "chal") return undefined;
    let dead = false;
    (async () => { const r = await rpc("sj_public_chal", { p_week: week }, true); if (!dead) { if (r.ok && r.data.ok) { setChal(r.data); setFail(""); } else setFail("챌린지 정보를 불러오지 못했어요"); } })();
    return () => { dead = true; };
  }, [tab, week]);
  const [day, setDay] = useState(0); const [dayData, setDayData] = useState(null);
  const dayStr = addDays(today(), day);
  useEffect(() => {
    if (tab !== "book") return undefined;
    let dead = false; setDayData(null);
    (async () => { const r = await rpc("sj_public_day", { p_date: dayStr }, true); if (!dead) setDayData(r.ok && r.data.ok ? r.data : { fail: true }); })();
    return () => { dead = true; };
  }, [tab, dayStr]);
  const links = info ? info.links : null;
  const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 };
  const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
  const dd = info && info.dday && info.dday.date ? daysUntil(info.dday.date) : null;
  const rooms = info ? Object.entries(info.rooms || {}) : [];
  const Book = () => (
    <div>
      {info && dd !== null && dd >= 0 && <div style={{ ...card, background: C.navy, color: "#fff", textAlign: "center" }}><div style={{ fontSize: 12, color: "#a0b0cc" }}>{info.dday.label || "건축사 시험"}</div><div style={{ fontSize: 26, fontWeight: 900, color: C.accent }}>{dd === 0 ? "D-DAY" : `D-${dd}`}</div></div>}
      {info && info.notice && info.notice.text && <div style={{ ...card, background: "#FFF8E6" }}><div style={{ fontSize: 12, fontWeight: 800, color: C.navy, marginBottom: 4 }}>📢 공지</div><div style={{ fontSize: 12, color: C.mid, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{info.notice.text}</div></div>}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: C.navy }}>🏢 지금 예약 가능한 좌석</div>
          {info && info.slot && <div style={{ fontSize: 11, color: C.light, fontWeight: 700 }}>{info.in_hours ? `${info.slot} 기준` : "운영 시간 09:00~22:00"}</div>}
        </div>
        {rooms.length === 0 && <div style={{ fontSize: 12, color: C.light }}>불러오는 중…</div>}
        {rooms.map(([id, r]) => (
          <div key={id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderTop: `1px solid ${C.bg}`, fontSize: 13 }}>
            <span style={{ fontWeight: 800, color: C.navy }}>{r.name || `스튜디오 ${id}`}</span>
            {(() => {
              if (!r.open) return <span style={{ color: C.light, fontWeight: 700 }}>운영 안 함</span>;
              if (typeof r.avail !== "number") return <span style={{ color: C.ok, fontWeight: 700 }}>{r.seats}석 운영</span>;
              if (!info.in_hours) return <span style={{ color: C.light, fontWeight: 700 }}>운영 시간 아님</span>;
              if (r.locked) return <span style={{ color: C.light, fontWeight: 700 }}>지금은 이용 불가</span>;
              if (r.avail <= 0) return <span style={{ color: C.err, fontWeight: 800 }}>만석</span>;
              return <span style={{ color: r.avail <= 3 ? C.warn : C.ok, fontWeight: 800 }}>{r.avail}석 <span style={{ color: C.light, fontWeight: 600, fontSize: 11 }}>/ {r.seats}석</span></span>;
            })()}
          </div>
        ))}
        <div style={{ fontSize: 11, color: C.light, marginTop: 10, lineHeight: 1.7 }}>예약은 수강생 입장 코드로 입장한 뒤, 오늘부터 3일 뒤까지 시간대별로 할 수 있어요. (둘러보기에서는 지금 남은 좌석 수만 보이고, 시간대별 예약 현황은 보이지 않아요)</div>
      </div>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 900, color: C.navy, marginBottom: 10 }}>📅 날짜별 남은 좌석 <span style={{ fontSize: 11, color: C.light, fontWeight: 600 }}>(오늘~3일 뒤)</span></div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[0, 1, 2, 3].map(i => { const ds = addDays(today(), i); const dt = new Date(ds + "T12:00:00"); const on = i === day; return (
            <button key={i} onClick={() => setDay(i)} style={{ flex: 1, padding: "8px 2px", borderRadius: 10, cursor: "pointer", border: `1.5px solid ${on ? C.navy : C.border}`, background: on ? C.navy : C.card, color: on ? "#fff" : C.navy, fontWeight: 800, fontSize: 12, lineHeight: 1.3 }}>
              {i === 0 ? "오늘" : `${i}일 뒤`}<div style={{ fontSize: 10, fontWeight: 600, opacity: 0.75 }}>{dt.getMonth() + 1}/{dt.getDate()} ({["일", "월", "화", "수", "목", "금", "토"][dt.getDay()]})</div>
            </button>); })}
        </div>
        {!dayData && <div style={{ fontSize: 12, color: C.light, textAlign: "center", padding: 16 }}>불러오는 중…</div>}
        {dayData && dayData.fail && <div style={{ fontSize: 12, color: C.err, textAlign: "center", padding: 16 }}>불러오지 못했어요. SQL 13 적용 전일 수 있어요.</div>}
        {dayData && !dayData.fail && Object.entries(dayData.rooms || {}).map(([id, r]) => (
          <div key={id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.navy, marginBottom: 6 }}>{r.name || `스튜디오 ${id}`} <span style={{ fontSize: 11, color: C.light, fontWeight: 600 }}>{r.open ? `${r.seats}석` : "운영 안 함"}</span></div>
            {r.open && <div style={{ display: "grid", gridTemplateColumns: `repeat(${wide ? 24 : 8}, 1fr)`, gap: 3 }}>
              {r.slots.map((a, i) => { const m = 540 + i * 30; const hhmm = `${Math.floor(m / 60)}:${m % 60 ? "30" : "00"}`;
                const bg = a === -2 ? "#EEF0F5" : a === -1 ? "#E4E7EF" : a <= 0 ? "#FDE3E3" : a <= 3 ? "#FFF0D6" : "#E3F6EA";
                const fg = a === -2 || a === -1 ? C.light : a <= 0 ? C.err : a <= 3 ? C.warn : C.ok;
                return <div key={i} style={{ background: bg, borderRadius: 6, textAlign: "center", padding: "3px 0" }}><div style={{ fontSize: 8, color: C.light }}>{hhmm}</div><div style={{ fontSize: 12, fontWeight: 800, color: fg }}>{a >= 0 ? a : "–"}</div></div>; })}
            </div>}
          </div>
        ))}
        <div style={{ fontSize: 10, color: C.light, lineHeight: 1.7 }}>숫자는 그 시간대에 남은 좌석 수예요. – 는 지난 시간·이용 불가예요. 예약자 정보는 보이지 않아요.</div>
      </div>
      {info && info.info && info.info.trim() && <div style={card}><div style={{ fontSize: 12, fontWeight: 800, color: C.navy, marginBottom: 6 }}>📋 이용 안내</div><div style={{ fontSize: 11, color: C.mid, lineHeight: 2 }}>{info.info.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div></div>}
    </div>
  );
  const Chal = () => {
    if (!chal) return <div style={{ textAlign: "center", padding: 40, color: C.mid }}>{fail || "⏳ 불러오는 중…"}</div>;
    if (!chal.configured) return <div style={{ ...card, textAlign: "center", color: C.mid }}>✍️ 작도 챌린지가 곧 시작돼요!</div>;
    const goal = chal.cfg.goal;
    const wk = rankRows(byDays(chal.ranking), p => `${p.days}`);
    const tt = rankRows(byDays(chal.total), p => `${p.days}`);
    return (
      <div>
        <div style={{ ...card, background: C.navy, color: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900 }}>✍️ {chal.cfg.name}</div>
          </div>
          <div style={{ fontSize: 12, color: "#a0b0cc", marginTop: 4 }}>{fmt(chal.cfg.start)} ~ {fmt(chal.cfg.end)} · 주 {goal}일 이상 인증 · {chal.started ? `${chal.cur_week}/${chal.cfg.weeks}주차` : "곧 시작"}</div>
          <BigDday end={chal.cfg.end} t={todayN} />
        </div>
        <div style={{ marginBottom: 12, marginTop: -4 }}><ComboGuide /></div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[["week", "주간 순위"], ["total", "누적 순위"], ["streak", "🔥 연속"]].map(([k, l]) => <button key={k} onClick={() => setView(k)} style={{ flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 13, border: `1.5px solid ${view === k ? C.blue : C.border}`, background: view === k ? C.blue : C.card, color: view === k ? "#fff" : C.mid }}>{l}</button>)}
        </div>
        {view === "week" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button onClick={() => setWeek(Math.max(1, chal.week - 1))} disabled={chal.week <= 1} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.mid, opacity: chal.week <= 1 ? 0.4 : 1 }}>◀</button>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>{chal.week}주차 <span style={{ fontWeight: 400, color: C.light, fontSize: 11 }}>({fmt(chal.week_start)} ~ {fmt(chal.week_end)})</span></div>
            <button onClick={() => setWeek(Math.min(chal.cfg.weeks, chal.week + 1))} disabled={chal.week >= chal.cfg.weeks} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.mid, opacity: chal.week >= chal.cfg.weeks ? 0.4 : 1 }}>▶</button>
          </div>
        )}
        {view !== "streak" && (view === "week" ? wk : tt).length === 0 && <div style={{ ...card, textAlign: "center", color: C.mid, fontSize: 13 }}>아직 인증이 없어요</div>}
        {view === "streak" ? <StreakBoard streaks={chal.streaks} /> : (view === "week" ? wk : tt).map(p => (
          <div key={p.name} style={{ ...card, padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, textAlign: "center", fontSize: p.rank <= 3 ? 22 : 14, fontWeight: 900, color: C.navy }}>{medal(p.rank)}</div>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}<Combo streaks={chal.streaks} name={p.name} /></div>
                <div style={{ fontSize: 11, color: C.mid }}>{view === "week" ? `이번 주 ${p.days}일 인증` : `총 ${p.days}일 인증`}</div></div>
            </div>
            {view === "week" && (
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                {[0, 1, 2, 3, 4, 5, 6].map(i => {
                  const d = addDays(chal.week_start, i); const inRange = d <= chal.week_end; const on = (p.ds || []).includes(d); const lv = dotLevels(p.ds, chal.today, (chal.streaks && chal.streaks[p.name] && chal.streaks[p.name].cur) || 0)[d] || 1;
                  return (
                    <div key={i} style={{ flex: 1, textAlign: "center", opacity: inRange ? 1 : 0.25 }}>
                      <div style={{ height: 18, borderRadius: 5, ...(on ? dotStyle(lv) : { background: C.bg }), border: `1px solid ${on ? "transparent" : C.border}`, fontSize: 11, lineHeight: "18px", fontWeight: 900 }}>{on ? (lv > 7 ? `×${Math.ceil(lv / 7)}` : "✓") : ""}</div>
                      <div style={{ fontSize: 9, color: C.light, marginTop: 2 }}>{DAY[new Date(d + "T12:00:00").getDay()]}</div>
                    </div>
                  );
                })}
                <div style={{ width: 34, textAlign: "right", fontSize: 12, fontWeight: 900, color: p.days >= goal ? C.ok : C.navy, lineHeight: "20px" }}>{p.days}/7</div>
              </div>
            )}
          </div>
        ))}
        <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, margin: "20px 0 10px" }}>📷 {chal.week}주차 도면 구경 <span style={{ fontSize: 11, fontWeight: 400, color: C.light }}>({chal.feed_count}장 · 최근 {chal.feed.length}장)</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {chal.feed.map(f => (
            <div key={f.id} style={{ position: "relative", border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", background: C.bg, aspectRatio: "1 / 1" }}>
              <img src={f.thumb} alt="작도" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#000000AA", color: "#fff", fontSize: 10, padding: "3px 5px" }}>{fmt(f.day)} · {SESS_LABEL[f.sess]} · {f.minutes}분</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.light, textAlign: "center", marginTop: 14 }}>둘러보기에서는 작은 그림만 보여요. 확대·인증 올리기는 수강생 입장 후 할 수 있어요.</div>
      </div>
    );
  };
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'SeoulNamsanM','Noto Sans KR',sans-serif" }}>
      <header style={{ background: C.navy, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ color: "#fff", fontWeight: 900, fontSize: 15 }}>🏛 신전스퀘어 <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>둘러보기</span></div>
        <button onClick={onExit} style={{ background: C.accent, color: C.navy, border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 800, cursor: "pointer", fontSize: 12 }}>입장하기</button>
      </header>
      {<div style={{ padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.border}` }}><LinkBar links={links || {}} /></div>}
      <div style={{ display: "flex", background: C.card, borderBottom: `1px solid ${C.border}` }}>
        {[["book", "📅 자습실 안내"], ["chal", "✍️ 작도 챌린지"]].map(([k, l]) => <button key={k} onClick={() => setTab(k)} style={{ flex: 1, padding: "13px 2px", border: "none", background: "none", cursor: "pointer", fontWeight: tab === k ? 800 : 400, fontSize: 13, color: tab === k ? C.blue : C.light, borderBottom: `2.5px solid ${tab === k ? C.blue : "transparent"}` }}>{l}</button>)}
      </div>
      <div style={{ maxWidth: wide ? 1000 : 480, margin: "0 auto", padding: 16 }}>
        <div style={{ fontSize: 11, color: C.mid, background: "#EEF3FF", borderRadius: 10, padding: "8px 12px", marginBottom: 12, textAlign: "center" }}>👀 구경만 할 수 있는 화면이에요. 예약·인증은 <b>입장</b> 후 가능해요.</div>
        {tab === "book" ? Book() : Chal()}
        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

// 입장 코드 화면 아래 순위판: 이번 주 자습실 이용 TOP 5 + 작도 챌린지 전체 TOP 5 (입장 전에도 볼 수 있고, 이름은 가려서 보여줘요)

function useTodayN() {
  const [n, setN] = useState(null);
  useEffect(() => {
    let dead = false;
    const go = async () => { const r = await rpc("sj_chal_today", {}, true); if (!dead && r.ok && r.data && r.data.ok) setN({ n: r.data.people, m: r.data.members }); };
    go();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") go(); }, 60000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return n;
}
function BigDday({ end, t, dark }) {
  const n = t ? t.n : null; const m = t ? t.m : null;
  const dd = end ? daysUntil(end) : null;
  const show = dd !== null && dd >= 0;
  if (!show && n === null) return null;
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "stretch" }}>
      {show && <div style={{ flex: 1.2, background: C.accent, color: C.navy, borderRadius: 14, padding: "10px 8px", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.8 }}>건축사 시험까지</div>
        <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.1, letterSpacing: 1 }}>{dd === 0 ? "D-DAY" : `D-${dd}`}</div>
      </div>}
      {m != null && <div style={{ flex: 1, background: "#ffffff18", border: "1px solid #ffffff33", color: "#fff", borderRadius: 14, padding: "10px 8px", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#a0b0cc" }}>참여자</div>
        <div style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.15 }}>{m}<span style={{ fontSize: 14, fontWeight: 800 }}>명</span></div>
      </div>}
      {n != null && <div style={{ flex: 1, background: "#ffffff18", border: "1px solid #ffffff33", color: "#fff", borderRadius: 14, padding: "10px 8px", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#a0b0cc" }}>오늘 인증</div>
        <div style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.15 }}>{n}<span style={{ fontSize: 14, fontWeight: 800 }}>명</span></div>
      </div>}
    </div>
  );
}

function KakaoCopy({ data, t }) {
  const [ok, setOk] = useState(false);
  const build = () => {
    const rows = rankRows(byDays(data.total), p => `${p.days}`);
    const g = {}; rows.forEach(p => { (g[p.rank] = g[p.rank] || { days: p.days, names: [] }).names.push(p.name); });
    const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
    const dd = data.cfg && data.cfg.end ? daysUntil(data.cfg.end) : null;
    const L = [`🔥 ${data.cfg.name}`, `📅 ${fmt(data.today)} 현황${dd !== null && dd >= 0 ? ` · 시험 ${dd === 0 ? "D-DAY" : "D-" + dd}` : ""}`,
      `✍️ 참여 ${t && t.m != null ? t.m : rows.length}명${t && t.n != null ? ` · 오늘 인증 ${t.n}명` : ""}`, "", "🏆 누적 순위 (인증한 날 기준)"];
    Object.keys(g).map(Number).sort((a, b) => a - b).forEach(r => L.push(`${medal(r)} ${g[r].days}일 (${g[r].names.length}명): ${g[r].names.join(", ")}`));
    L.push("", "하루 한 장이면 인증 OK! 연속하면 🔥 COMBO", "앱에서 인증하고 순위 확인 👉 https://shinjeon-booking.vercel.app");
    return L.join("\n");
  };
  const copy = async () => {
    const text = build();
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} document.body.removeChild(ta); }
    setOk(true); setTimeout(() => setOk(false), 2500);
  };
  return <button onClick={copy} style={{ width: "100%", background: "#FEE500", color: "#3A1D1D", border: "none", borderRadius: 13, padding: 12, fontWeight: 900, fontSize: 14, cursor: "pointer", marginBottom: 12 }}>{ok ? "복사됐어요 ✅ 톡방에 붙여넣기" : "💬 톡방에 올릴 순위 복사 (관리자)"}</button>;
}

function EntryRank() {
  const [d, setD] = useState(null);
  const todayN = useTodayN();
  useEffect(() => {
    let dead = false;
    const go = async () => { const r = await rpc("sj_public_board", {}, true); if (!dead && r.ok && r.data.ok) setD(r.data); };
    go();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") go(); }, 60000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  if (!d) return null;
  const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
  const box = { marginTop: 14, background: "#ffffff10", borderRadius: 16, padding: "16px 16px 12px", border: "1px solid #ffffff22", textAlign: "left" };
  const study = rankRows(d.study || [], p => `${p.minutes}`);
  const chal = d.chal && d.chal.show ? d.chal : null;
  const chalRows = chal ? rankRows(byDays((chal.top || []).map(p => ({ ...p, days: p.days ?? p.posts }))), p => `${p.days}`).filter(p => p.rank <= 5) : [];
  const line = (k, r, name, val, st) => (
    <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid #ffffff14" }}>
      <div style={{ width: 34, fontSize: r <= 3 ? 20 : 13, fontWeight: 900, color: "#fff", textAlign: "center" }}>{medal(r)}</div>
      <div style={{ flex: 1, color: "#fff", fontWeight: 700, fontSize: 14 }}>{name}{st && <Combo streaks={st} name={name} dark />}</div>
      <div style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>{val}</div>
    </div>
  );
  return (
    <div>
      {d.study_show !== false && <div style={box}>
        <div style={{ color: "#fff", fontSize: 14, fontWeight: 800 }}>📚 이번 주 자습실 이용 TOP 5</div>
        <div style={{ color: "#a0b0cc", fontSize: 11, margin: "3px 0 10px" }}>{fmt(d.week_start)} ~ {fmt(d.week_end)} · 이용을 마친 시간 · 🏆 공부왕 랭킹과 같은 기준</div>
        {study.length === 0 && <div style={{ color: "#a0b0cc", fontSize: 12, padding: "6px 0 8px" }}>이번 주 첫 번째 주인공이 되어보세요! 💪</div>}
        {study.map(p => line(p.name, p.rank, p.name, fmtDur(p.minutes)))}
      </div>}
      {chal && (<>
        <div style={box}>
          <div style={{ color: "#fff", fontSize: 14, fontWeight: 800, display: "flex", justifyContent: "space-between" }}><span>✍️ {chal.name} 전체 TOP 5</span></div>
          <BigDday end={chal.end} t={todayN} dark />
          <div style={{ color: "#a0b0cc", fontSize: 11, margin: "3px 0 10px" }}>{chal.started ? `하루 한 장만 그려도 인증 1일 · 인증한 날이 많은 순` : `${fmt(chal.start)}(${DAY[new Date(chal.start + "T12:00:00").getDay()]}) 시작`}</div>
          {chalRows.length === 0 && <div style={{ color: "#a0b0cc", fontSize: 12, padding: "6px 0 8px" }}>{chal.started ? "아직 인증이 없어요. 첫 번째 주인공이 되어보세요! 💪" : "시작하면 이곳에 순위가 나와요"}</div>}
          {chalRows.map(p => line(p.name, p.rank, p.name, `${p.days}일`, chal.streaks))}
          <ComboGuide dark />
        </div>
        {(() => {
          const hof = Object.entries(chal.streaks || {}).filter(([, v]) => (v.best || 0) >= 30).sort((x, y) => y[1].best - x[1].best || x[0].localeCompare(y[0], "ko"));
          const next = Object.entries(chal.streaks || {}).filter(([, v]) => (v.cur || 0) >= 7 && (v.cur || 0) < 30).sort((x, y) => y[1].cur - x[1].cur).slice(0, 3);
          if (!hof.length && !next.length) return null;
          return (
            <div style={{ ...box, borderColor: "#FFD27A55" }}>
              <div style={{ color: "#FFD27A", fontSize: 14, fontWeight: 800 }}>👑 명예의 전당 <span style={{ fontSize: 11, color: "#a0b0cc", fontWeight: 600 }}>30일 연속 인증 달성</span></div>
              {hof.length === 0 && <div style={{ color: "#a0b0cc", fontSize: 12, padding: "8px 0 4px" }}>아직 달성자가 없어요. 첫 번째 👑이 되어보세요!</div>}
              {hof.map(([n, v]) => <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderTop: "1px solid #ffffff14", color: "#fff", fontWeight: 800, fontSize: 14 }}><span>👑 {n}</span><span style={{ color: "#FFD27A", fontSize: 12 }}>최고 {v.best}일 연속</span></div>)}
              {next.length > 0 && <div style={{ color: "#a0b0cc", fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>🔥 도전 중: {next.map(([n, v]) => `${n} ${v.cur}일`).join(" · ")}</div>}
            </div>
          );
        })()}
      </>)}
    </div>
  );
}

// 도면 갤러리: "전체 도면"(모든 주·모든 사람, 이름으로 걸러보기) / "내 작도"(내 이름으로 모아보기). 45장씩 더 보기
function Gallery({ names, onOpen, reloadKey, mineMode }) {
  const saved = (() => { try { return normName(localStorage.getItem("sj_last_name") || ""); } catch { return ""; } })();
  const [who, setWho] = useState(mineMode ? saved : ""); const [me, setMe] = useState(saved);
  const [items, setItems] = useState([]); const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [thumbs, setThumbs] = useState({}); const seq = useRef(0);
  const fetchPage = useCallback(async (off, reset) => {
    if (mineMode && !who) { setItems([]); setTotal(0); return; }
    const id = ++seq.current; setBusy(true); setErr("");
    const r = await rpc("sj_chal_gallery", { p_entry: AUTH.entry, p_name: who || null, p_off: off }, true);
    if (id !== seq.current) return;
    setBusy(false);
    if (!r.ok) { setErr(failMsg(r, "도면을 불러오지 못했어요")); return; }
    setTotal(r.data.total); setItems(prev => reset ? r.data.items : [...prev, ...r.data.items]);
  }, [who, mineMode]);
  useEffect(() => { fetchPage(0, true); }, [fetchPage, reloadKey]);
  useEffect(() => {
    const ids = items.map(f => f.id); const need = ids.filter(id => !thumbCache.has(id));
    const pull = () => setThumbs(Object.fromEntries(ids.filter(id => thumbCache.has(id)).map(id => [id, thumbCache.get(id)])));
    pull(); if (!need.length) return undefined;
    let dead = false;
    (async () => {
      for (let i = 0; i < need.length; i += 20) {
        const r = await rpc("sj_chal_thumbs", { p_entry: AUTH.entry, p_ids: need.slice(i, i + 20) }, true);
        if (r.ok && r.data.thumbs) for (const [k, v] of Object.entries(r.data.thumbs)) thumbCache.set(k, v);
        if (dead) return; pull();
      }
    })();
    return () => { dead = true; };
  }, [items]);
  const find = () => { const n = normName(me); if (n) { try { localStorage.setItem("sj_last_name", n); } catch {} setWho(n); } };
  const box = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 13, padding: 12, marginBottom: 12 };
  return (
    <div>
      <div style={box}>
        {mineMode ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input value={me} onChange={e => setMe(e.target.value)} onKeyDown={e => { if (e.key === "Enter") find(); }} placeholder="내 이름" style={{ ...inputStyle, flex: 1 }} />
            <button onClick={find} style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "0 18px", fontWeight: 800, cursor: "pointer", fontSize: 13 }}>조회</button>
          </div>
        ) : (
          <select value={who} onChange={e => setWho(e.target.value)} style={inputStyle}>
            <option value="">모든 사람</option>
            {[...new Set(names)].sort().map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <div style={{ fontSize: 12, color: C.mid, marginTop: 10, fontWeight: 700 }}>
          {mineMode ? (who ? `${who} 님의 인증 ${total}장` : "이름을 입력하고 조회를 눌러주세요") : `${who ? `${who} 님` : "전체"} · 인증 ${total}장`}
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: C.err, marginBottom: 8 }}>{err}</div>}
      {!busy && items.length === 0 && !err && (!mineMode || who) && <div style={{ textAlign: "center", padding: 30, color: C.mid, fontSize: 13 }}>아직 올라온 도면이 없어요</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
        {items.map(f => (
          <button key={f.id} onClick={() => onOpen(f)} style={{ padding: 0, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.card, cursor: "pointer", textAlign: "left" }}>
            <div style={{ aspectRatio: "4 / 3", background: C.bg }}>
              {thumbs[f.id] ? <img src={thumbs[f.id]} alt={`${f.name} 작도`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.light, fontSize: 11 }}>…</div>}
            </div>
            <div style={{ padding: "8px 10px" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>{f.name}{f.arch && <span style={{ fontSize: 10, fontWeight: 600, color: C.light }}> · 축소</span>}</div>
              <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>{fmt(f.day)} · {SESS_LABEL[f.sess]} · {f.minutes}분</div>
            </div>
          </button>
        ))}
      </div>
      {items.length < total && <button onClick={() => fetchPage(items.length, false)} disabled={busy} style={{ width: "100%", marginTop: 12, padding: 12, borderRadius: 10, border: `1px solid ${C.border}`, background: C.card, color: C.mid, fontWeight: 800, cursor: "pointer" }}>{busy ? "불러오는 중…" : `더 보기 (${items.length}/${total})`}</button>}
    </div>
  );
}

function ChallengeTab({ admin }) {
  const todayN = useTodayN();
  const [data, setData] = useState(null); const [fail, setFail] = useState(""); const [week, setWeek] = useState(null);
  const [view, setView] = useState("week"); const [posting, setPosting] = useState(false); const [open, setOpen] = useState(null);
  const [thumbs, setThumbs] = useState({}); const reqId = useRef(0);
  const me = (() => { try { return normName(localStorage.getItem("sj_last_name") || ""); } catch { return ""; } })();

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await rpc("sj_chal_board", { p_entry: AUTH.entry, p_week: week });
    if (id !== reqId.current) return;
    if (!r.ok) { setFail(failMsg(r, "챌린지 정보를 불러오지 못했어요")); return; }
    setFail(""); setData(r.data);
  }, [week]);
  useEffect(() => { load(); const t = setInterval(() => { if (document.visibilityState !== "hidden") load(); }, 30000); return () => clearInterval(t); }, [load]);

  const feed = useMemo(() => (data && data.configured ? data.feed : []), [data]);
  useEffect(() => { // 화면에 보이는 작은 사진만 필요한 만큼 불러와요
    const ids = feed.map(f => f.id); const need = ids.filter(id => !thumbCache.has(id));
    const pull = () => setThumbs(Object.fromEntries(ids.filter(id => thumbCache.has(id)).map(id => [id, thumbCache.get(id)])));
    pull();
    if (!need.length) return undefined;
    let dead = false;
    (async () => {
      for (let i = 0; i < need.length; i += 20) {
        const r = await rpc("sj_chal_thumbs", { p_entry: AUTH.entry, p_ids: need.slice(i, i + 20) }, true);
        if (r.ok && r.data.thumbs) for (const [k, v] of Object.entries(r.data.thumbs)) thumbCache.set(k, v);
        if (dead) return;
      }
      if (!dead) pull();
    })();
    return () => { dead = true; };
  }, [feed]);

  const cfg = data && data.cfg;
  const body = (() => {
    if (!data && !fail) return <div style={{ textAlign: "center", padding: 40, color: C.mid }}>⏳ 불러오는 중…</div>;
    if (!data) return null;
    if (!data.configured) return <div style={{ textAlign: "center", padding: "36px 10px", color: C.mid, fontSize: 14, lineHeight: 1.8 }}>✍️ 작도 챌린지가 곧 시작돼요!<br />시작하면 이곳에서 인증 사진을 올리고<br />주간 순위를 확인할 수 있어요.</div>;
    const past = data.today > data.week_end;
    const wk = rankRows(byDays(data.ranking), p => `${p.days}`);
    const tt = rankRows(byDays(data.total), p => `${p.days}`);
    const goal = cfg.goal || 5;
    const mine = wk.find(p => p.name === me);
    const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
    const canPost = data.started && !data.ended;
    return (
      <div>
        <div style={{ background: C.navy, borderRadius: 16, padding: "16px 16px 14px", color: "#fff", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900 }}>✍️ {cfg.name}</div>
          </div>
          <div style={{ fontSize: 12, color: "#a0b0cc", marginTop: 4 }}>{cfg.end ? `${fmt(cfg.start)} ~ ${fmt(cfg.end)} · ` : ""}{data.ended ? "챌린지가 끝났어요 🎉" : data.started ? `${data.cur_week}/${cfg.weeks}주차 진행 중 · 주 ${goal}일 이상 인증 (7일 단위)` : `${fmt(cfg.start)}(${DAY[new Date(cfg.start + "T12:00:00").getDay()]})에 시작해요`}</div>
          <BigDday end={cfg.end} t={todayN} />
          {mine && <div style={{ fontSize: 13, marginTop: 10, color: C.accent, fontWeight: 800 }}>내 기록: {mine.name} · {mine.days}일 인증 · {mine.rank}등 {mine.days >= goal ? "✅" : past ? "" : `(${goal}일까지 ${goal - mine.days}일 남음)`}</div>}
        </div>
        {admin && <KakaoCopy data={data} t={todayN} />}
        <button onClick={() => canPost && setPosting(true)} disabled={!canPost} style={{ width: "100%", background: canPost ? C.blue : C.border, color: canPost ? "#fff" : C.mid, border: "none", borderRadius: 13, padding: 14, fontWeight: 900, fontSize: 15, cursor: canPost ? "pointer" : "default", marginBottom: canPost ? 14 : 4 }}>{canPost ? "📸 오늘 작도 인증 올리기" : data.ended ? "챌린지가 끝났어요" : `📸 ${fmt(cfg.start)}부터 인증을 올릴 수 있어요`}</button>
        {canPost && <div style={{ fontSize: 11, color: C.mid, textAlign: "center", marginBottom: 14 }}>✅ 완성된 도면만 올려주세요 · 하루(새벽 5시 기준) 한 장이면 OK · 연속하면 🔥 COMBO!</div>}
        <div style={{ marginBottom: 14, marginTop: -6 }}><ComboGuide /></div>
        {!canPost && !data.ended && <div style={{ fontSize: 11, color: C.light, textAlign: "center", marginBottom: 14 }}>시작일부터 이 자리에 인증 올리기 버튼이 활성화돼요</div>}

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[["week", "주간 순위"], ["total", "누적 순위"], ["streak", "🔥 연속"], ["gallery", "📷 전체 도면"], ["mine", "🙋 내 작도"]].map(([k, l]) => <button key={k} onClick={() => setView(k)} style={{ flex: 1, padding: "10px 2px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 12,
            border: `1.5px solid ${view === k ? C.blue : C.border}`, background: view === k ? C.blue : C.card, color: view === k ? "#fff" : C.mid }}>{l}</button>)}
        </div>

        {view === "week" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button onClick={() => setWeek(Math.max(1, data.week - 1))} disabled={data.week <= 1} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.mid, opacity: data.week <= 1 ? 0.4 : 1 }}>◀</button>
            <div style={{ textAlign: "center", fontSize: 13, fontWeight: 800, color: C.navy }}>{data.week}주차 <span style={{ fontWeight: 400, color: C.light, fontSize: 11 }}>({fmt(data.week_start)} ~ {fmt(data.week_end)})</span></div>
            <button onClick={() => setWeek(Math.min(cfg.weeks, data.week + 1))} disabled={data.week >= cfg.weeks} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.mid, opacity: data.week >= cfg.weeks ? 0.4 : 1 }}>▶</button>
          </div>
        )}

        {view === "week" && wk.length === 0 && <div style={{ textAlign: "center", padding: 30, color: C.mid, fontSize: 13 }}>이 주에는 아직 인증이 없어요. 첫 번째 인증을 올려보세요! 💪</div>}
        {view === "week" && wk.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {wk.map(p => (
              <div key={p.name} style={{ background: C.card, border: `1px solid ${p.rank <= 3 ? C.accent : C.border}`, borderRadius: 13, padding: "11px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 40, fontSize: p.rank <= 3 ? 24 : 15, fontWeight: 900, color: C.navy, textAlign: "center" }}>{medal(p.rank)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}<Combo streaks={data.streaks} name={p.name} /></div>
                    <div style={{ fontSize: 11, color: C.mid }}>이번 주 {p.days}일 인증</div>
                  </div>
                  <Tag c={p.days >= goal ? C.ok : past ? C.err : C.warn}>{p.days >= goal ? `주${goal}일 달성` : past ? "미달" : `${goal - p.days}일 더`}</Tag>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map(i => {
                    const d = addDays(data.week_start, i); const inRange = d <= data.week_end; const on = (p.ds || []).includes(d); const wd = DAY[new Date(d + "T12:00:00").getDay()]; const lv = dotLevels(p.ds, data.today, (data.streaks && data.streaks[p.name] && data.streaks[p.name].cur) || 0)[d] || 1;
                    return (
                      <div key={i} style={{ flex: 1, textAlign: "center", opacity: inRange ? 1 : 0.25 }}>
                        <div style={{ height: 18, borderRadius: 5, ...(on ? dotStyle(lv) : { background: C.bg }), border: `1px solid ${on ? "transparent" : C.border}`, fontSize: 11, lineHeight: "18px", fontWeight: 900 }}>{on ? (lv > 7 ? `×${Math.ceil(lv / 7)}` : "✓") : ""}</div>
                        <div style={{ fontSize: 9, color: d === data.today ? C.blue : C.light, fontWeight: d === data.today ? 900 : 400, marginTop: 2 }}>{wd}</div>
                      </div>
                    );
                  })}
                  <div style={{ width: 34, textAlign: "right", fontSize: 12, fontWeight: 900, color: p.days >= goal ? C.ok : C.navy, alignSelf: "flex-start", lineHeight: "20px" }}>{p.days}/7</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "total" && tt.length === 0 && <div style={{ textAlign: "center", padding: 30, color: C.mid, fontSize: 13 }}>아직 누적 기록이 없어요.</div>}
        {view === "total" && tt.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, color: C.light }}>인증한 날이 많은 순이에요 (같은 날수는 같은 등수) · 연속으로 하면 🔥 COMBO!</div>
            {tt.map(p => (
              <div key={p.name} style={{ background: C.card, border: `1px solid ${p.rank <= 3 ? C.accent : C.border}`, borderRadius: 13, padding: "11px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 40, fontSize: p.rank <= 3 ? 24 : 15, fontWeight: 900, color: C.navy, textAlign: "center" }}>{medal(p.rank)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}<Combo streaks={data.streaks} name={p.name} /></div>
                  <div style={{ fontSize: 11, color: C.mid }}>총 {p.days}일 인증{data.streaks && data.streaks[p.name] && data.streaks[p.name].best >= 3 ? ` · 최고 ${data.streaks[p.name].best}일 연속` : ""}</div>
                </div>
                <Tag c={C.ok}>{p.weeks_ok}주 달성</Tag>
              </div>
            ))}
          </div>
        )}

        {view === "streak" && <StreakBoard streaks={data.streaks} />}

        {(view === "gallery" || view === "mine") && <Gallery key={view} mineMode={view === "mine"} names={data.total.map(t => t.name)} onOpen={setOpen} reloadKey={data.feed.length} />}

        {(view === "week" || view === "total") && <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, margin: "22px 0 10px" }}>📷 {data.week}주차 인증 사진 <span style={{ fontSize: 11, fontWeight: 400, color: C.light }}>({feed.length}장)</span></div>}
        {(view === "week" || view === "total") && feed.length === 0 && <div style={{ fontSize: 12, color: C.light }}>아직 올라온 사진이 없어요</div>}
        {(view === "week" || view === "total") && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {feed.map(f => (
            <button key={f.id} onClick={() => setOpen(f)} style={{ position: "relative", padding: 0, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", background: C.bg, cursor: "pointer", aspectRatio: "1 / 1" }}>
              {thumbs[f.id] ? <img src={thumbs[f.id]} alt={`${f.name} 작도`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.light, fontSize: 11 }}>…</div>}
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#000000AA", color: "#fff", fontSize: 10, padding: "3px 5px", textAlign: "left", lineHeight: 1.3 }}>{f.name}<br />{SESS_LABEL[f.sess]} · {f.minutes}분</div>
            </button>
          ))}
        </div>}
      </div>
    );
  })();

  return (
    <div>
      {fail && <div style={{ background: "#FFF1F0", color: C.err, borderRadius: 10, padding: 12, fontSize: 12, marginBottom: 12 }}>{fail} <button onClick={load} style={{ border: "none", background: "none", color: C.blue, fontWeight: 700, cursor: "pointer" }}>다시 시도</button></div>}
      {body}
      {posting && <ChalPostSheet title={cfg ? cfg.name : ""} onClose={() => setPosting(false)} onDone={() => { setPosting(false); setWeek(null); load(); }} />}
      {open && <ChalPhotoSheet post={open} admin={admin} onClose={() => setOpen(null)} onDeleted={() => { setOpen(null); load(); }} />}
    </div>
  );
}

function MyTab({ studios, onCancelRes }) {
  const [name, setName] = useState(""); const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [selected, setSelected] = useState(new Set()); const [cancelList, setCancelList] = useState(null);

  const search = async () => {
    const n = name.trim(); if (!n) return;
    setBusy(true); setErr(""); setSelected(new Set());
    const r = await rpc("sj_my", { p_entry: AUTH.entry, p_name: n });
    setBusy(false);
    if (!r.ok || !Array.isArray(r.data.rows)) { setErr(failMsg(r, "서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.")); setList(null); return; }
    setList(r.data.rows.map(normT));
  };
  const toggle = id => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = list && list.length > 0 && selected.size === list.length;

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>내 예약 조회</div>
      <div style={{ fontSize: 12, color: C.mid, marginBottom: 18 }}>이름으로 예약 내역을 확인하고 취소할 수 있어요</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={e => { setName(e.target.value); setList(null); }} onKeyDown={e => e.key === "Enter" && search()}
          placeholder="예약자 이름" style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 15, outline: "none" }} />
        <button onClick={search} disabled={busy} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 700, cursor: "pointer" }}>{busy ? "…" : "조회"}</button>
      </div>
      {err && <ErrBox>{err}</ErrBox>}
      {list && (list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: C.light }}><div style={{ fontSize: 36 }}>📭</div><div style={{ fontSize: 14 }}>"{name}" 이름으로 예약된 내역이 없어요</div></div>
      ) : (<>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "10px 14px", background: C.bg, borderRadius: 10, border: `1px solid ${C.border}` }}>
          <input type="checkbox" checked={!!allSel} onChange={() => setSelected(allSel ? new Set() : new Set(list.map(r => r.id)))} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 13, color: C.mid, flex: 1 }}>전체 선택 ({list.length}건)</span>
          {selected.size > 0 && <button onClick={() => setCancelList(list.filter(r => selected.has(r.id)))}
            style={{ background: C.err, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, cursor: "pointer", fontSize: 12 }}>선택 {selected.size}건 취소</button>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(r => {
            const st = studios.find(s => s.id === r.studio_id) || studios[0];
            return (
              <div key={r.id} style={{ background: st.bg, borderRadius: 13, padding: 14, border: `1.5px solid ${selected.has(r.id) ? st.color : st.color + "33"}`, display: "flex", alignItems: "center", gap: 12 }}>
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} style={{ width: 16, height: 16 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 14, color: st.color }}>{st.name}</div>
                  <div style={{ fontSize: 13, color: C.mid, marginTop: 2 }}>{fmt(r.date)} ({DAY[dow(r.date)]}) · <b>{r.start_time} ~ {r.end_time}</b></div>
                  <div style={{ fontSize: 11, color: C.light, marginTop: 2 }}>{r.user_class ? `담임 ${r.user_class}` : ""}</div>
                </div>
                <button onClick={() => setCancelList([r])} style={{ background: "#FEE2E2", color: C.err, border: "none", borderRadius: 8, padding: "7px 10px", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>취소</button>
              </div>
            );
          })}
        </div>
      </>))}
      {cancelList && <CancelSheet bookings={cancelList} studios={studios} onClose={() => setCancelList(null)} onCancelOne={onCancelRes} onDone={search} />}
    </div>
  );
}

// ═════════════════════════════════════════════
//  관리자: 자습실 운영 설정 (열기/닫기 · 좌석 · 전체 제어)
// ═════════════════════════════════════════════
function SyncChip({ sync, onRetry }) {
  if (sync.state === "saving") return <div style={{ fontSize: 12, color: C.warn, fontWeight: 700 }}>⏳ 서버에 저장 중…</div>;
  if (sync.state === "fail") return (
    <div style={{ fontSize: 12, color: C.err, fontWeight: 700 }}>
      ❌ 저장 실패 {sync.msg && `(${sync.msg})`} <button onClick={onRetry} style={{ marginLeft: 6, background: C.err, color: "#fff", border: "none", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>다시 시도</button>
      <div style={{ fontWeight: 400, color: C.mid, marginTop: 3 }}>아래 "서버 진단"으로 원인을 확인하세요. 학생 화면에는 아직 반영되지 않았어요.</div>
    </div>
  );
  return <div style={{ fontSize: 12, color: C.ok, fontWeight: 700 }}>✅ 서버 반영 완료 {sync.at && clock(sync.at)} <span style={{ fontWeight: 400, color: C.light }}>· 학생 화면에 5초 안에 반영</span></div>;
}

function RoomSettings({ cfg, onChange, sync, onRetry }) {
  const [bulk, setBulk] = useState(MAX_SEATS);
  const setRoom = (id, patch) => onChange(c => ({ ...c, rooms: { ...c.rooms, [id]: { ...c.rooms[id], ...patch } } }));
  const setAll = fn => onChange(c => ({ ...c, rooms: Object.fromEntries(STUDIO_META.map(m => [m.id, { ...c.rooms[m.id], ...fn(c.rooms[m.id]) }])) }));
  const openN = STUDIO_META.filter(m => cfg.rooms[m.id].open && cfg.rooms[m.id].seats > 0).length;

  const btn = (active, color) => ({ flex: 1, padding: "11px 8px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 13,
    border: `1.5px solid ${active ? color : C.border}`, background: active ? color : C.card, color: active ? "#fff" : C.mid });

  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, flex: 1 }}>🏛 자습실 운영 설정</div>
        <Tag c={openN === 4 ? C.ok : openN === 0 ? C.err : C.warn}>{openN}/4 운영중</Tag>
      </div>
      <div style={{ marginBottom: 14 }}><SyncChip sync={sync} onRetry={onRetry} /></div>

      <div style={{ background: C.bg, borderRadius: 12, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 8 }}>전체 제어</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button onClick={() => setAll(r => ({ open: true, seats: r.seats || MAX_SEATS }))} style={btn(openN === 4, C.ok)}>전체 열기</button>
          <button onClick={() => setAll(() => ({ open: false }))} style={btn(openN === 0, C.err)}>전체 닫기</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: C.mid }}>전체 좌석</span>
          <select value={bulk} onChange={e => setBulk(Number(e.target.value))} style={{ flex: 1, padding: "9px 10px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 14 }}>
            {Array.from({ length: MAX_SEATS + 1 }, (_, i) => <option key={i} value={i}>{i}석</option>)}
          </select>
          <button onClick={() => setAll(() => ({ seats: bulk }))} style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 9, padding: "10px 14px", fontWeight: 700, cursor: "pointer", fontSize: 12 }}>일괄 적용</button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {STUDIO_META.map(m => {
          const r = cfg.rooms[m.id]; const runs = r.open && r.seats > 0;
          return (
            <div key={m.id} style={{ background: runs ? m.bg : "#F4F5F9", borderRadius: 13, padding: 13, border: `1.5px solid ${runs ? m.color + "55" : C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <TextCommit value={r.name} maxLength={20} onCommit={v => setRoom(m.id, { name: v })}
                  style={{ flex: 1, minWidth: 0, padding: "9px 12px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 14, fontWeight: 800, color: m.color, outline: "none", background: "#fff", boxSizing: "border-box" }} />
                <div style={{ textAlign: "center" }}>
                  <Toggle on={r.open} color={m.color} onChange={on => setRoom(m.id, on ? { open: true, seats: r.seats || MAX_SEATS } : { open: false })} />
                  <div style={{ fontSize: 10, fontWeight: 700, color: r.open ? m.color : C.light, marginTop: 3 }}>{r.open ? "열림" : "닫힘"}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: C.mid, width: 52 }}>열어둘 좌석</span>
                <button onClick={() => setRoom(m.id, { seats: Math.max(0, r.seats - 1) })} style={{ width: 36, height: 36, borderRadius: 9, border: `1.5px solid ${C.border}`, background: "#fff", fontSize: 18, cursor: "pointer", fontWeight: 800 }}>−</button>
                <div style={{ minWidth: 44, textAlign: "center", fontSize: 18, fontWeight: 900, color: m.color }}>{r.seats}</div>
                <button onClick={() => setRoom(m.id, { seats: Math.min(MAX_SEATS, r.seats + 1) })} style={{ width: 36, height: 36, borderRadius: 9, border: `1.5px solid ${C.border}`, background: "#fff", fontSize: 18, cursor: "pointer", fontWeight: 800 }}>+</button>
                {[5, 10, MAX_SEATS].map(n => (
                  <button key={n} onClick={() => setRoom(m.id, { seats: n })}
                    style={{ padding: "7px 10px", borderRadius: 8, border: `1px solid ${r.seats === n ? m.color : C.border}`, background: r.seats === n ? m.color : "#fff", color: r.seats === n ? "#fff" : C.mid, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{n}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.light, marginTop: 8 }}>
                {runs ? `학생들에게 ${r.seats}석 운영중으로 보여요` : r.open ? "좌석이 0석이라 학생들에게는 닫힘으로 보여요" : "학생들에게 '운영 안 함'으로 보여요 (기존 예약은 그대로 남아요)"}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12, background: C.bg, borderRadius: 12, padding: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>🏆 공부왕 랭킹 공개</div>
          <div style={{ fontSize: 11, color: C.light, marginTop: 2 }}>{cfg.showRanking ? "학생 화면에 랭킹 탭이 보여요" : "학생에게는 숨김 (관리자만 확인)"}</div>
        </div>
        <Toggle on={cfg.showRanking} color={C.accent} onChange={on => onChange(c => ({ ...c, showRanking: on }))} />
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 6 }}>이용 안내 문구 (주소·이용수칙 등, 학생 화면 하단에 표시)</div>
        <TextCommit multiline value={cfg.info} maxLength={600} onCommit={v => onChange(c => ({ ...c, info: v }))}
          style={{ width: "100%", padding: 10, borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 12, lineHeight: 1.7, outline: "none", boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" }} />
        <div style={{ fontSize: 10, color: C.light, marginTop: 4 }}>입력창 밖을 터치하면 서버에 저장돼요</div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 6 }}>🔗 바로가기 링크 (입장 화면·메인 화면에 버튼으로 표시, 비워두면 숨김)</div>
        {LINK_DEFS.map(([k, ic, label]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 92, fontSize: 12, fontWeight: 700, color: C.navy }}>{ic} {label}</div>
            <TextCommit value={cfg.links?.[k] || ""} maxLength={300} allowEmpty onCommit={v => onChange(c => ({ ...c, links: { ...(c.links || {}), [k]: cleanUrl(v) } }))} placeholder="https://"
              style={{ flex: 1, minWidth: 0, padding: "9px 10px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
        ))}
        <div style={{ fontSize: 10, color: C.light, marginTop: 2 }}>주소를 붙여넣고 입력창 밖을 터치하면 저장돼요 (https:// 는 없어도 돼요)</div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════
//  관리자: 날짜별 예약·잠금 현황
// ═════════════════════════════════════════════
function HomeBoard({ cfg }) {
  const dd = cfg.dday.date ? daysUntil(cfg.dday.date) : null;
  const ddText = dd === null || dd < 0 ? null : dd === 0 ? "D-DAY" : `D-${dd}`;
  const n = cfg.notice, m = cfg.message;
  if (!ddText && !n.text && !m.text) return null;
  const dt = cfg.dday.date ? new Date(cfg.dday.date + "T12:00:00") : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
      {ddText && (
        <div style={{ background: `linear-gradient(135deg, ${C.navy}, #2B3F66)`, borderRadius: 16, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>{cfg.dday.label}</div>
            <div style={{ color: "#fff9", fontSize: 11, marginTop: 2 }}>{dt && `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()} (${DAY[dt.getDay()]})`}</div>
          </div>
          <div style={{ color: "#fff", fontSize: 34, fontWeight: 900, letterSpacing: -1 }}>{ddText}</div>
        </div>
      )}
      {n.text && (
        <div style={{ background: "#FFF7E0", border: `1.5px solid ${C.accent}`, borderRadius: 14, padding: "13px 15px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 900, color: "#8A6A12" }}>📢 공지사항</span>
            {n.at && <span style={{ fontSize: 10, color: "#A8893A" }}>{fmt(n.at)} 등록</span>}
          </div>
          <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.text}</div>
        </div>
      )}
      {m.text && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.blue}`, borderRadius: 14, padding: "13px 15px" }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: C.blue, marginBottom: 6 }}>💬 {m.title}</div>
          <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
        </div>
      )}
    </div>
  );
}

function BoardSettings({ cfg, onChange }) {
  const box = { width: "100%", padding: 10, borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, lineHeight: 1.7, outline: "none", boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" };
  const one = { ...box, lineHeight: 1.3, padding: "11px 12px", resize: "none" };
  const dd = cfg.dday.date ? daysUntil(cfg.dday.date) : null;
  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 12 }}>📢 시험 D-day · 공지 · 대표 글</div>

      <label style={labelStyle}>D-day 이름</label>
      <TextCommit value={cfg.dday.label} maxLength={20} onCommit={v => onChange(c => ({ ...c, dday: { ...c.dday, label: v } }))} style={{ ...one, marginBottom: 10 }} />
      <label style={labelStyle}>시험 날짜</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <input type="date" value={cfg.dday.date} onChange={e => onChange(c => ({ ...c, dday: { ...c.dday, date: e.target.value } }))} style={{ ...one, flex: 1 }} />
        {cfg.dday.date && <button onClick={() => onChange(c => ({ ...c, dday: { ...c.dday, date: "" } }))} style={{ border: `1px solid ${C.border}`, background: C.bg, borderRadius: 9, padding: "10px 12px", cursor: "pointer", fontSize: 12, color: C.mid }}>지우기</button>}
      </div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 14 }}>{dd === null ? "날짜를 정하면 학생 화면 맨 위에 D-day가 표시돼요" : dd < 0 ? "이미 지난 날짜라 학생 화면에는 표시되지 않아요" : `학생 화면에 ${dd === 0 ? "D-DAY" : "D-" + dd}로 표시돼요`}</div>

      <label style={labelStyle}>📢 공지사항 (비우면 숨김)</label>
      <TextCommit multiline value={cfg.notice.text} maxLength={500} style={box}
        onCommit={v => onChange(c => ({ ...c, notice: { text: v, at: v ? (v === c.notice.text ? c.notice.at : today()) : "" } }))} />
      <div style={{ fontSize: 10, color: C.light, margin: "4px 0 14px" }}>입력창 밖을 터치하면 저장돼요 · 최대 500자</div>

      <label style={labelStyle}>💬 대표 글 제목</label>
      <TextCommit value={cfg.message.title} maxLength={20} onCommit={v => onChange(c => ({ ...c, message: { ...c.message, title: v } }))} style={{ ...one, marginBottom: 10 }} />
      <label style={labelStyle}>💬 대표 글 (목표·응원 메시지, 비우면 숨김)</label>
      <TextCommit multiline value={cfg.message.text} maxLength={500} style={box} onCommit={v => onChange(c => ({ ...c, message: { ...c.message, text: v } }))} />
      <div style={{ fontSize: 10, color: C.light, marginTop: 4 }}>입력창 밖을 터치하면 저장돼요 · 최대 500자</div>

      <div style={{ marginTop: 16, background: C.bg, borderRadius: 12, padding: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.navy, marginBottom: 4 }}>🏆 랭킹 초기화</div>
        <div style={{ fontSize: 11, color: C.light, marginBottom: 10, lineHeight: 1.6 }}>
          {cfg.rankingSince ? `현재 ${fmt(cfg.rankingSince)}부터 집계 중이에요. ` : "지금은 전체 기록을 집계해요. "}
          누르면 내일부터 새로 집계하고, 이전 기록은 랭킹에서 빠져요. (예약 자료 자체는 지워지지 않아요)
        </div>
        <ConfirmBtn label="랭킹 초기화" onConfirm={() => onChange(c => ({ ...c, rankingSince: tomorrow() }))}
          style={{ border: "none", borderRadius: 9, padding: "10px 16px", cursor: "pointer", fontWeight: 800, fontSize: 12, background: C.err, color: "#fff" }} />
      </div>
    </div>
  );
}

function SaveBar({ sync, busy, onSave }) {
  const saving = busy || sync.state === "saving";
  const fail = sync.state === "fail";
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 150, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ width: "100%", maxWidth: window.innerWidth >= 900 ? 1100 : 520, background: C.card, borderTop: `2px solid ${fail ? C.err : C.accent}`, boxShadow: "0 -6px 20px #1A2A4522", padding: "10px 14px calc(10px + env(safe-area-inset-bottom))", display: "flex", alignItems: "center", gap: 12, pointerEvents: "auto", boxSizing: "border-box" }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: saving ? C.warn : fail ? C.err : C.ok }}>
          {saving ? "⏳ 서버에 저장 중…" : fail ? `❌ 저장 실패${sync.msg ? ` (${sync.msg})` : ""}` : `✅ 저장 확인됨 ${sync.at ? clock(sync.at) : ""}`}
          <div style={{ fontWeight: 400, fontSize: 10, color: C.light, marginTop: 2 }}>바꾸는 즉시 자동 저장돼요 · 불안하면 눌러서 한 번 더 확인</div>
        </div>
        <button onClick={onSave} disabled={saving} style={{ flexShrink: 0, background: saving ? C.light : C.navy, color: "#fff", border: "none", borderRadius: 12, padding: "13px 22px", fontWeight: 900, fontSize: 15, cursor: saving ? "default" : "pointer" }}>
          {saving ? "저장 중…" : "💾 저장"}
        </button>
      </div>
    </div>
  );
}

function WeeklyRules({ cfg, onChange, studios }) {
  const [sid, setSid] = useState("A");
  const [days, setDays] = useState([]);
  const [t1, setT1] = useState("19:00"); const [t2, setT2] = useState("22:00");
  const [reason, setReason] = useState("강의"); const [err, setErr] = useState("");
  const [ack, setAck] = useState(false); const [conf, setConf] = useState([]);
  useEffect(() => { setAck(false); setConf([]); }, [sid, days, t1, t2]);
  const rules = cfg.weekly || [];
  const nameOf = id => id === "ALL" ? "전체 스튜디오" : (studios.find(s => s.id === id)?.name || id);
  const toggleDay = d => setDays(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d].sort());
  const add = async () => {
    if (!days.length) { setErr("요일을 하나 이상 선택해주세요"); return; }
    if (t1 >= t2) { setErr("종료시간이 시작보다 늦어야 해요"); return; }
    if (rules.length >= 60) { setErr("규칙은 최대 60개까지 만들 수 있어요"); return; }
    setErr("");
    if (!ack) { // 앞으로의 기존 예약과 겹치는지 먼저 확인 (예약은 자동 삭제하지 않음)
      const q = await rpc("sj_admin_rows", { p_token: AUTH.token, p_from: today() });
      if (!q.ok || !Array.isArray(q.data.rows)) { setErr("기존 예약을 확인하지 못했어요. 다시 시도해주세요"); return; }
      const hit = q.data.rows.map(normT).filter(r => days.includes(dow(r.date)) && (sid === "ALL" || r.studio_id === sid) && r.start_time < t2 && r.end_time > t1);
      if (hit.length) { setConf(hit); setAck(true); return; }
    }
    onChange(c => ({ ...c, weekly: [...(c.weekly || []), { id: uid(), studio_id: sid, days, start: t1, end: t2, reason: reason.trim() || "강의", skip: [] }] }));
    setDays([]);
  };
  const del = id => onChange(c => ({ ...c, weekly: (c.weekly || []).filter(r => r.id !== id) }));
  const sel = { ...inputStyle, padding: "10px 10px", fontSize: 14 };
  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🔁 매주 반복 강의 (자동 닫힘)</div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 12 }}>한 번 등록하면 매주 해당 요일·시간에 자습실이 자동으로 닫혀요. 학생 화면에도 바로 반영돼요.</div>

      <div style={{ background: C.bg, borderRadius: 12, padding: 12, marginBottom: 12 }}>
        {err && <ErrBox>{err}</ErrBox>}
        <label style={labelStyle}>스튜디오</label>
        <select value={sid} onChange={e => setSid(e.target.value)} style={{ ...sel, marginBottom: 10 }}>
          <option value="ALL">전체 스튜디오</option>
          {studios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label style={labelStyle}>요일 (여러 개 선택 가능)</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {DAY.map((n, d) => (
            <button key={d} onClick={() => toggleDay(d)} style={{ flex: 1, padding: "10px 0", borderRadius: 9, cursor: "pointer", fontWeight: 800, fontSize: 13,
              border: `1.5px solid ${days.includes(d) ? C.blue : C.border}`, background: days.includes(d) ? C.blue : "#fff", color: days.includes(d) ? "#fff" : C.mid }}>{n}</button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          {[["시작", t1, setT1], ["종료", t2, setT2]].map(([l, v, st]) => (
            <div key={l}><label style={labelStyle}>{l}</label>
              <select value={v} onChange={e => st(e.target.value)} style={sel}>
                {[...SLOTS, "22:00"].map(x => <option key={x} value={x}>{x}</option>)}
              </select></div>
          ))}
        </div>
        <label style={labelStyle}>사유 (학생 화면에 표시)</label>
        <input value={reason} onChange={e => setReason(e.target.value)} maxLength={20} style={{ ...sel, marginBottom: 10 }} />
        {conf.length > 0 && (
          <div style={{ background: "#FFF7E0", border: `1.5px solid ${C.accent}`, borderRadius: 10, padding: "10px 14px", marginBottom: 10, fontSize: 12, color: "#8A6A12" }}>
            <b>⚠️ 이 규칙과 겹치는 기존 예약이 {conf.length}건 있어요.</b> 추가해도 기존 예약은 지워지지 않고, 새 예약만 막혀요.
            <div style={{ marginTop: 6, color: C.tx }}>{conf.slice(0, 6).map(r => <div key={r.id}>· {fmt(r.date)}({DAY[dow(r.date)]}) {r.start_time}~{r.end_time} {r.user_name}{tutTag(r.user_class)}</div>)}{conf.length > 6 && <div>… 외 {conf.length - 6}건</div>}</div>
          </div>
        )}
        <button onClick={add} style={{ width: "100%", background: conf.length && ack ? C.err : C.navy, color: "#fff", border: "none", borderRadius: 11, padding: 12, fontWeight: 800, cursor: "pointer", fontSize: 14 }}>{conf.length && ack ? "예약이 있어도 반복 강의 추가" : "+ 반복 강의 추가"}</button>
      </div>

      {rules.length === 0 && <div style={{ fontSize: 12, color: C.light, textAlign: "center", padding: 8 }}>등록된 반복 강의가 없어요</div>}
      {rules.map(r => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#FEE2E2", borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.err }}>{nameOf(r.studio_id)} · {r.days.map(d => DAY[d]).join("·")} {r.start}~{r.end}</div>
            <div style={{ fontSize: 11, color: C.mid }}>🔒 {r.reason}{r.skip?.length ? ` · 제외된 날짜 ${r.skip.length}일` : ""}</div>
          </div>
          <ConfirmBtn label="삭제" onConfirm={() => del(r.id)} style={{ border: "none", borderRadius: 7, padding: "6px 11px", cursor: "pointer", fontWeight: 700, fontSize: 11, background: C.err, color: "#fff" }} />
        </div>
      ))}
    </div>
  );
}

function AdminDay({ date, setDate, dates, studios, res, locks, loading, onCancelRes, onDelLock, onAddLock, onSkipRule }) {
  const [lockFor, setLockFor] = useState(null);
  const smallBtn = { border: "none", borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontWeight: 700, fontSize: 11, background: "#FEE2E2", color: C.err };
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 10 }}>📅 날짜별 예약·잠금 현황 {loading && <span style={{ fontSize: 10, color: C.light, fontWeight: 400 }}>불러오는 중…</span>}</div>
      <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 14, paddingBottom: 4 }}>
        {dates.map(d => (
          <button key={d} onClick={() => setDate(d)} style={{ flexShrink: 0, padding: "8px 13px", borderRadius: 9, border: `2px solid ${d === date ? C.blue : C.border}`, background: d === date ? C.blue : C.card, cursor: "pointer", color: d === date ? "#fff" : C.mid, fontWeight: 700, fontSize: 12 }}>{fmt(d)} ({DAY[dow(d)]})</button>
        ))}
      </div>
      {studios.map(s => {
        const sRes = res.filter(r => r.studio_id === s.id);
        const sLocks = locks.filter(l => l.studio_id === s.id || l.studio_id === "ALL");
        const overSlots = s.runs ? SLOTS.filter(sl => slotBooked(sRes, s.id, sl) > s.seats) : [];
        return (
          <div key={s.id} style={{ background: C.card, borderRadius: 14, padding: 14, marginBottom: 10, border: `1.5px solid ${s.color}33` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ width: 9, height: 9, borderRadius: "50%", background: s.color }} />
              <b style={{ color: s.color, fontSize: 13 }}>{s.name}</b>
              <Tag c={s.runs ? C.ok : C.light}>{s.runs ? `${s.seats}석 운영` : "닫힘"}</Tag>
              {sRes.length > 0 && <Tag c={s.color}>{sRes.length}건 예약</Tag>}
              <button onClick={() => setLockFor(s)} style={{ ...smallBtn, marginLeft: "auto", background: "#fff", border: `1px solid ${C.err}55` }}>🔒 잠금 추가</button>
            </div>
            {overSlots.length > 0 && (
              <div style={{ background: "#FEF2F2", border: `1.5px solid ${C.err}`, borderRadius: 8, padding: "8px 12px", marginBottom: 6, fontSize: 12, color: C.err, fontWeight: 700 }}>
                ⚠️ 정원({s.seats}석) 초과 시간이 있어요: {overSlots.slice(0, 6).join(", ")}{overSlots.length > 6 ? " …" : ""} · 아래 예약 중 일부를 취소해주세요
              </div>
            )}
            {sRes.length === 0 && sLocks.length === 0 && <div style={{ fontSize: 12, color: C.light }}>예약·잠금 없음</div>}
            {sRes.map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, background: s.bg, borderRadius: 8, padding: "8px 12px", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color, width: 84 }}>{r.start_time}~{r.end_time}</span>
                <span style={{ flex: 1, fontSize: 13, color: C.tx, fontWeight: 600 }}>{r.user_name} <span style={{ fontSize: 11, color: C.light }}>{tutTag(r.user_class).trim()}</span></span>
                <ConfirmBtn label="취소" onConfirm={() => onCancelRes(r.id)} style={smallBtn} />
              </div>
            ))}
            {sLocks.map(l => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#FEE2E2", borderRadius: 8, padding: "8px 12px", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.err, width: 84 }}>{l.start_time}~{l.end_time}</span>
                <span style={{ flex: 1, fontSize: 12, color: C.err }}>🔒 {l.reason}{l.studio_id === "ALL" ? " (전체)" : ""}{l.rule ? " 🔁" : ""}</span>
                {l.rule
                  ? <ConfirmBtn label="이 날만 해제" onConfirm={() => onSkipRule(l.rule_id, l.date)} style={{ ...smallBtn, background: C.err, color: "#fff" }} />
                  : <ConfirmBtn label="해제" onConfirm={() => onDelLock(l.id)} style={{ ...smallBtn, background: C.err, color: "#fff" }} />}
              </div>
            ))}
          </div>
        );
      })}
      {lockFor && <LockSheet date={date} studio={lockFor} studios={studios} res={res} onClose={() => setLockFor(null)} onSubmit={onAddLock} />}
    </div>
  );
}

// ═════════════════════════════════════════════
//  관리자: 서버 진단 (읽기만 해요. 데이터를 바꾸지 않아요)
// ═════════════════════════════════════════════
function Diagnostics() {
  const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); const out = [];
    const c = await rpc("sj_config", { p_entry: AUTH.entry }, true);
    out.push({ label: "설정 읽기", ok: c.ok, detail: c.ok ? "정상" : failMsg(c, `오류 (HTTP ${c.status})`) });
    const d = await rpc("sj_day", { p_entry: AUTH.entry, p_date: today(), p_token: AUTH.token || null }, true);
    out.push({ label: "예약 읽기", ok: d.ok, detail: d.ok ? "정상" : failMsg(d, `오류 (HTTP ${d.status})`) });
    out.push({ label: "관리자 열쇠", ok: d.ok && d.data.admin === true, detail: d.ok && d.data.admin === true ? "정상 (서버가 확인함)" : "로그인이 만료됐어요. 로그아웃 후 다시 로그인해주세요" });
    for (const [label, t] of [["예약표 잠금", "studio_reservations"], ["잠금표 잠금", "studio_locks"], ["설정표 잠금", "settings"]]) {
      const st = await probeTable(t);
      out.push({ label, ok: st === "blocked", detail: st === "blocked" ? "브라우저에서 직접 접근 차단됨" : st === "open" ? "아직 직접 열 수 있어요 (2단계 잠금 SQL 필요)" : "확인하지 못했어요" });
    }
    setRows(out); setBusy(false);
  };
  const allOk = rows && rows.every(r => r.ok);
  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginTop: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🛠 서버 진단</div>
      <div style={{ fontSize: 11, color: C.mid, marginBottom: 12 }}>서버 연결과 보안 잠금 상태를 점검해요. 읽기만 하므로 데이터는 바뀌지 않아요.</div>
      <button onClick={run} disabled={busy} style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 800, cursor: "pointer", fontSize: 13 }}>{busy ? "점검 중…" : "진단 실행"}</button>
      {rows && (
        <div style={{ marginTop: 12 }}>
          {rows.map(r => (
            <div key={r.label} style={{ display: "flex", gap: 8, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.bg}` }}>
              <span style={{ width: 20 }}>{r.ok ? "✅" : "❌"}</span><span style={{ width: 84, fontWeight: 700 }}>{r.label}</span><span style={{ color: r.ok ? C.light : C.err, flex: 1 }}>{r.detail}</span>
            </div>
          ))}
          {allOk && <div style={{ marginTop: 10, fontSize: 12, color: C.ok, fontWeight: 700 }}>모두 정상이에요. 서버가 안전하게 잠겨 있어요.</div>}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════
//  메인 앱
// ═════════════════════════════════════════════
export default function App() {
  const wide = useWide(900);
  // ── 입장 코드 ──
  const [guest, setGuest] = useState(false);
  const [entryOk, setEntryOk] = useState(false);
  const [role, setRole] = useState("full"); // full: 수강생(자습실+작도) / chal: 작도 챌린지 전용
  const [entryChecked, setEntryChecked] = useState(false);
  const [entryInput, setEntryInput] = useState("");
  const [entryErr, setEntryErr] = useState(false);
  const [entryMsg, setEntryMsg] = useState(""); const [entryBusy, setEntryBusy] = useState(false);
  useEffect(() => {
    try {
      const c = localStorage.getItem("sj_booking_entry_code");
      if (c && /^\d{1,10}$/.test(c)) {
        AUTH.entry = c;
        const saved = localStorage.getItem("sj_booking_role");
        if (saved === "chal") { setRole("chal"); setTab("chal"); }
        setEntryOk(true);
        rpc("sj_entry_check", { p_entry: c }, true).then(r => {
          if (r.ok && r.data && r.data.role === "chal") { setRole("chal"); setTab("chal"); try { localStorage.setItem("sj_booking_role", "chal"); } catch {} }
          else if (r.ok && r.data && r.data.role === "full") { setRole("full"); try { localStorage.setItem("sj_booking_role", "full"); } catch {} }
        });
      }
      localStorage.removeItem("sj_booking_entry_ok"); // 예전 방식(코드 없이 통과)은 더 이상 쓰지 않아요
    } catch {}
    setEntryChecked(true);
  }, []);
  const tryEntry = async () => {
    const code = entryInput.trim();
    if (!code || entryBusy) return;
    setEntryBusy(true); setEntryErr(false); setEntryMsg("");
    const r = await rpc("sj_entry_check", { p_entry: code }, true);
    setEntryBusy(false);
    if (r.ok) {
      const rl = r.data && r.data.role === "chal" ? "chal" : "full";
      AUTH.entry = code; setRole(rl); if (rl === "chal") setTab("chal"); setEntryOk(true);
      try { localStorage.setItem("sj_booking_entry_code", code); localStorage.setItem("sj_booking_role", rl); } catch {}
    }
    else if (r.status === 0 || r.missing || r.data.code === "locked") setEntryMsg(r.data.code === "locked" ? (r.data.msg || "잠시 후 다시 시도해주세요.") : failMsg(r, "잠시 후 다시 시도해주세요."));
    else { setEntryErr(true); setEntryInput(""); }
  };

  // ── UI 상태 ──
  const [tab, setTab] = useState("book");
  const [admin, setAdmin] = useState(false);
  const [pw, setPw] = useState(""); const [pwErr, setPwErr] = useState(""); const [loginBusy, setLoginBusy] = useState(false);
  const [showChgPw, setShowChgPw] = useState(false);
  const [adminSub, setAdminSub] = useState("rooms");
  useEffect(() => {
    hooks.adminFail = () => { if (!AUTH.token) return; AUTH.token = ""; setAdmin(false); setNotice({ kind: "err", text: "관리자 로그인이 만료됐어요. 다시 로그인해주세요" }); };
    hooks.entryFail = () => {
      AUTH.entry = ""; AUTH.token = "";
      try { localStorage.removeItem("sj_booking_entry_code"); localStorage.removeItem("sj_booking_role"); } catch {}
      setAdmin(false); setRole("full"); setEntryOk(false); setEntryInput(""); setEntryMsg("입장 코드를 다시 입력해주세요");
    };
    return () => { hooks.adminFail = null; hooks.entryFail = null; };
  }, []);
  const [date, setDate] = useState(today());
  const [sid, setSid] = useState("A");
  const [notice, setNotice] = useState(null);
  useEffect(() => { if (notice?.kind === "ok") { const t = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(t); } }, [notice]);

  // ── 자습실 설정: 서버가 유일한 기준. 이 기기의 저장값(localStorage)은 사용하지 않음 ──
  const [cfg, setCfg] = useState(makeDefaultCfg);
  const cfgRef = useRef(cfg);
  const baseRef = useRef(null); // 서버에서 마지막으로 확인한 설정 (동시 수정 병합의 기준)
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [cfgSync, setCfgSync] = useState({ state: "loading", at: null, msg: "" });
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);

  const flushCfg = useCallback(async () => {
    if (savingRef.current) { pendingRef.current = true; return false; }
    savingRef.current = true;
    setCfgSync(s => ({ ...s, state: "saving" }));
    try {
      do {
        pendingRef.current = false;
        let snap = null, saved = false;
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          // 저장 직전에 서버를 확인: 다른 기기가 먼저 저장했다면 내 변경만 그 위에 합쳐서 저장
          const pre = await readConfig();
          if (!pre.ok) throw new Error("서버에 연결할 수 없어요");
          let serverRev = 0;
          if (pre.cfg) {
            const theirs = normalizeCfg(pre.cfg);
            serverRev = theirs.rev;
            if (baseRef.current && theirs.rev > baseRef.current.rev && theirs.rev !== cfgRef.current.rev) {
              const merged = normalizeCfg({ ...mergeCfg(baseRef.current, cfgRef.current, theirs), rev: Math.max(Date.now(), theirs.rev + 1) });
              cfgRef.current = merged; setCfg(merged); baseRef.current = theirs;
            }
          }
          if (cfgRef.current.rev <= serverRev) {
            const bumped = normalizeCfg({ ...cfgRef.current, rev: Math.max(Date.now(), serverRev + 1) });
            cfgRef.current = bumped; setCfg(bumped);
          }
          snap = cfgRef.current;
          // 서버가 "내가 본 버전 그대로일 때만" 저장해요. 그 사이 누가 저장했으면 충돌로 돌려보내 다시 병합해요
          const w = await saveConfigRemote(snap, serverRev);
          if (w.ok) { saved = true; baseRef.current = snap; }
          else if (!w.conflict) throw new Error(w.msg);
        }
        if (!saved) throw new Error("다른 기기와 동시에 저장하느라 실패했어요. 저장 버튼을 다시 눌러주세요");
        const back = await readConfig();
        if (!pendingRef.current && (!back.ok || !back.cfg || back.cfg.rev < snap.rev)) throw new Error("서버에 반영됐는지 확인되지 않았어요");
      } while (pendingRef.current);
      dirtyRef.current = false;
      baseRef.current = cfgRef.current;
      setCfgSync({ state: "ok", at: new Date(), msg: "" });
      return true;
    } catch (e) {
      setCfgSync({ state: "fail", at: null, msg: e.message });
      return false;
    } finally { savingRef.current = false; }
  }, []);

  // 관리자 "저장" 버튼: 입력 중인 칸을 확정 → 서버에 저장 → 서버에서 다시 읽어 일치 확인
  const [saveBusy, setSaveBusy] = useState(false);
  const saveNow = async () => {
    if (saveBusy) return;
    setSaveBusy(true);
    try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    await new Promise(r => setTimeout(r, 150));
    for (let i = 0; i < 40 && savingRef.current; i++) await new Promise(r => setTimeout(r, 150));
    const ok = await flushCfg();
    setSaveBusy(false);
    setNotice(ok
      ? { kind: "ok", text: "서버에 저장하고 다시 확인했어요. 학생 화면에도 반영돼요" }
      : { kind: "err", text: "저장에 실패했어요. 관리 탭 아래 '서버 진단'을 확인하거나 다시 눌러주세요" });
  };

  const changeCfg = useCallback(fn => {
    const base = fn(cfgRef.current);
    const next = normalizeCfg({ ...base, rev: Math.max(Date.now(), cfgRef.current.rev + 1) });
    cfgRef.current = next; setCfg(next);
    dirtyRef.current = true;
    flushCfg();
  }, [flushCfg]);

  const pullCfg = useCallback(async () => {
    const r = await readConfig();
    if (!r.ok) { if (!savingRef.current) setCfgSync(s => ({ state: "fail", at: s.at, msg: "서버에 연결할 수 없어요" })); return; }
    setCfgLoaded(true);
    if (!baseRef.current) baseRef.current = r.cfg ? normalizeCfg(r.cfg) : cfgRef.current;
    if (dirtyRef.current || savingRef.current) return; // 내가 저장 중이면 덮어쓰지 않음
    if (r.cfg) {
      const n = normalizeCfg(r.cfg);
      if (n.rev > cfgRef.current.rev) { cfgRef.current = n; setCfg(n); baseRef.current = n; } // 더 새로운 설정만 반영 (늦게 도착한 옛 응답이 덮어쓰지 않도록)
    }
    setCfgSync({ state: "ok", at: new Date(), msg: "" });
  }, []);

  useEffect(() => {
    if (!entryOk || role === "chal") return;
    const tick = () => { pullCfg(); if (dirtyRef.current && !savingRef.current) flushCfg(); };
    tick();
    const iv = setInterval(() => { if (document.visibilityState !== "hidden") tick(); }, 4000); // 화면이 백그라운드면 요청 중단
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", tick);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", tick); };
  }, [entryOk, role, pullCfg, flushCfg]);

  const studios = useMemo(() => STUDIO_META.map(m => {
    const r = cfg.rooms[m.id];
    return { ...m, ...r, runs: r.open && r.seats > 0 };
  }), [cfg]);
  const studio = studios.find(s => s.id === sid) || studios[0];

  const picked = useRef(false);
  useEffect(() => {
    if (cfgLoaded && !picked.current) { picked.current = true; const f = studios.find(s => s.runs); if (f) setSid(f.id); }
  }, [cfgLoaded, studios]);

  // ── 날짜별 예약/잠금 (서버 기준, 6초마다 자동 갱신) ──
  const [day, setDay] = useState({ date: null, res: [], locks: [], ok: null });
  const [dayLoading, setDayLoading] = useState(false);
  const dateRef = useRef(date); dateRef.current = date;
  const loadDay = useCallback(async (d, silent) => {
    if (!silent) setDayLoading(true);
    const r = await fetchDay(d);
    if (dateRef.current === d) {
      if (r) { setDay({ date: d, res: r.res, locks: r.locks, ok: true }); if (AUTH.token && !r.admin && hooks.adminFail) hooks.adminFail(); }
      else setDay(p => ({ ...p, ok: false }));
    }
    if (!silent) setDayLoading(false);
  }, []);
  useEffect(() => {
    if (!entryOk || role === "chal") return;
    loadDay(date, false);
    const iv = setInterval(() => { if (document.visibilityState !== "hidden") loadDay(date, true); }, 6000);
    const onVis = () => { if (document.visibilityState === "visible") loadDay(date, true); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [date, entryOk, role, loadDay]);
  const dateRes = day.date === date ? day.res : [];
  const dateLocks = useMemo(() => [...(day.date === date ? day.locks : []), ...ruleLocks(cfg.weekly, date)], [day, date, cfg.weekly]);

  // 자정이 지나거나 시간이 흐르면 화면을 갱신하고, 지난 날짜가 선택돼 있으면 오늘로 이동
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => { setTick(t => t + 1); setDate(d => (d < today() ? today() : d)); }, 30000);
    return () => clearInterval(iv);
  }, []);

  const failNotice = (label, r) => setNotice({ kind: "err", text: `${label} (${failMsg(r, `코드 ${r.status}`)}). 관리 탭 › 서버 진단으로 원인을 확인해주세요.` });

  // ── 예약: 서버가 정원·잠금·중복·날짜를 한 번에 검사하고 저장 ──
  const onBook = useCallback(async payload => {
    const r = await placeBooking(payload);
    loadDay(payload.date, true);
    return r;
  }, [loadDay]);

  // 학생 취소: 비밀번호는 서버가 확인
  const cancelRes = useCallback(async (id, pw) => {
    const r = await rpc("sj_cancel", { p_entry: AUTH.entry, p_id: id, p_pw: pw });
    if (r.ok || r.data.code === "not_found") { loadDay(dateRef.current, true); return { ok: true }; }
    if (r.data.code === "wrong_pw") return { ok: false, wrong: true, msg: `비밀번호가 틀려요${typeof r.data.left === "number" ? ` (남은 시도 ${r.data.left}번)` : ""}` };
    return { ok: false, msg: failMsg(r, "취소에 실패했어요. 잠시 후 다시 시도해주세요.") };
  }, [loadDay]);

  const adminCancelRes = async id => {
    const r = await rpc("sj_admin_cancel", { p_token: AUTH.token, p_id: id });
    if (!r.ok) { if (r.data.code !== "auth") setNotice({ kind: "err", text: failMsg(r, "취소에 실패했어요") }); return; }
    setNotice({ kind: "ok", text: "예약을 취소했어요" }); loadDay(dateRef.current, true);
  };
  const addLock = async p => {
    const r = await rpc("sj_admin_lock_add", { p_token: AUTH.token, p });
    if (!r.ok) { if (r.data.code !== "auth") failNotice("잠금 저장에 실패했어요", r); return false; }
    setNotice({ kind: "ok", text: "잠금을 설정했어요" }); await loadDay(date, true); return true;
  };
  const skipRule = (ruleId, d) => {
    changeCfg(c => ({ ...c, weekly: (c.weekly || []).map(r => r.id === ruleId ? { ...r, skip: [...new Set([...(r.skip || []), d])] } : r) }));
    setNotice({ kind: "ok", text: `${fmt(d)} 하루만 정기 잠금을 해제했어요` });
  };
  const delLock = async id => {
    const r = await rpc("sj_admin_lock_del", { p_token: AUTH.token, p_id: id });
    if (!r.ok) { if (r.data.code !== "auth") failNotice("잠금 해제에 실패했어요", r); return; }
    setNotice({ kind: "ok", text: "잠금을 해제했어요" }); await loadDay(date, true);
  };

  // ── 관리자 로그인/비밀번호: 비밀번호 확인은 서버에서만, 로그인하면 12시간짜리 열쇠를 받아요 ──
  const loginAdmin = async () => {
    setLoginBusy(true); setPwErr("");
    const r = await rpc("sj_admin_login", { p_pw: pw }, true);
    if (r.ok && r.data.token) { AUTH.token = r.data.token; setAdmin(true); setPw(""); }
    else if (r.data.code === "wrong" && typeof r.data.left === "number") setPwErr(`비밀번호가 틀렸어요 (남은 시도 ${r.data.left}번)`);
    else setPwErr(failMsg(r, "비밀번호가 틀렸어요"));
    setLoginBusy(false);
  };
  const logoutAdmin = () => {
    const t = AUTH.token; AUTH.token = "";
    if (t) rpc("sj_admin_logout", { p_token: t }, true);
    setAdmin(false); setDate(today());
  };
  const leaveAll = () => { // 처음 화면(입장 코드)으로: 관리자 로그아웃 + 입장 코드 지움
    const t = AUTH.token; AUTH.token = ""; AUTH.entry = "";
    if (t) rpc("sj_admin_logout", { p_token: t }, true);
    try { localStorage.removeItem("sj_booking_entry_code"); localStorage.removeItem("sj_booking_role"); } catch {}
    setAdmin(false); setRole("full"); setTab("book"); setEntryOk(false); setEntryInput(""); setEntryMsg(""); setDate(today());
  };
  const changeAdminPw = async (cur, next) => {
    const r = await rpc("sj_admin_change_pw", { p_token: AUTH.token, p_cur: cur, p_new: next });
    return r.ok ? { ok: true } : { ok: false, msg: failMsg(r, "변경에 실패했어요") };
  };

  // ── 학생 화면용 스튜디오 상태 ──
  const studioStat = s => {
    if (!s.runs) return "closed";
    if (SLOTS.every(sl => manualLock(dateLocks, s.id, sl))) return "locked";
    const minRem = SLOTS.reduce((mn, sl) => manualLock(dateLocks, s.id, sl) ? mn : Math.min(mn, s.seats - slotBooked(dateRes, s.id, sl)), s.seats);
    return minRem <= 0 ? "full" : minRem <= 2 ? "low" : "ok";
  };

  // ── 입장 코드 화면 (모든 훅 호출 이후) ──
  if (!entryChecked) return null;
  if (!entryOk && guest) return <GuestView onExit={() => setGuest(false)} />;
  if (!entryOk) {
    return (
      <div style={{ minHeight: "100vh", background: C.navy, fontFamily: "'SeoulNamsanM','Noto Sans KR',sans-serif", display: "flex", alignItems: wide ? "flex-start" : "center", justifyContent: "center", padding: wide ? "48px 32px" : 20 }}>
        <div style={wide ? { width: "100%", maxWidth: 1040, display: "grid", gridTemplateColumns: "340px 1fr", gap: 40, alignItems: "start" } : { width: "100%", maxWidth: 340, textAlign: "center" }}>
          <div style={{ textAlign: "center" }}>
          <div style={{ marginBottom: 22 }}><EntryLinks /></div>
          <img src="/logo.webp" alt="신전스퀘어" width={72} height={72} style={{ width: 72, height: 72, borderRadius: 16, display: "block", margin: "0 auto 18px", boxShadow: "0 0 0 1px #ffffff22" }} />
          <div style={{ color: "#fff", fontWeight: 900, fontSize: 19, marginBottom: 4 }}>신전스퀘어</div>
          <div style={{ color: C.accent, fontSize: 11, letterSpacing: 1.5, marginBottom: 28 }}>STUDIO RESERVATION</div>
          <div style={{ background: "#ffffff10", borderRadius: 16, padding: 24, border: "1px solid #ffffff22" }}>
            <div style={{ color: "#fff", fontSize: 14, fontWeight: 700, marginBottom: 6 }}>입장 코드를 입력해주세요</div>
            <div style={{ color: "#a0b0cc", fontSize: 11, marginBottom: 16 }}>수강생 코드 · 작도 챌린지 참가 코드로 입장해요</div>
            <input value={entryInput} onChange={e => { setEntryInput(e.target.value.replace(/\D/g, "").slice(0, 10)); setEntryErr(false); }}
              onKeyDown={e => e.key === "Enter" && tryEntry()} placeholder="입장 코드" autoFocus inputMode="numeric"
              style={{ width: "100%", padding: "13px 14px", borderRadius: 11, border: `1.5px solid ${entryErr ? C.err : "#ffffff33"}`, fontSize: 16, outline: "none", boxSizing: "border-box", textAlign: "center", letterSpacing: 6, background: "#ffffff12", color: "#fff", marginBottom: 10 }} />
            {entryErr && <div style={{ fontSize: 12, color: "#FF8A8A", marginBottom: 10 }}>❌ 코드가 올바르지 않아요</div>}
            {entryMsg && <div style={{ fontSize: 12, color: "#FF8A8A", marginBottom: 10 }}>⚠️ {entryMsg}</div>}
            <button onClick={tryEntry} style={{ width: "100%", background: C.accent, color: C.navy, border: "none", borderRadius: 11, padding: 13, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>{entryBusy ? "확인 중…" : "입장하기"}</button>
          </div>
          <button onClick={() => setGuest(true)} style={{ width: "100%", marginTop: 12, background: "transparent", color: "#fff", border: "1.5px solid #ffffff55", borderRadius: 11, padding: 12, fontWeight: 700, cursor: "pointer", fontSize: 14 }}>👀 입장 전에 둘러보기</button>
          </div>
          <div style={{ paddingTop: wide ? 0 : 0 }}><EntryRank /></div>
        </div>
      </div>
    );
  }

  const week = admin ? getAdminDates() : getDates();
  const connOk = cfgSync.state === "ok" || cfgSync.state === "saving";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'SeoulNamsanM','Noto Sans KR',sans-serif", maxWidth: wide ? 1100 : 520, margin: "0 auto" }}>
      {notice && (
        <div style={{ position: "sticky", top: 0, zIndex: 200, background: notice.kind === "err" ? C.err : C.ok, color: "#fff", padding: "9px 14px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>{notice.kind === "err" ? "⚠️ " : "✅ "}{notice.text}</span>
          <button onClick={() => setNotice(null)} style={{ background: "#ffffff33", border: "none", borderRadius: 6, color: "#fff", padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>닫기</button>
        </div>
      )}

      <header style={{ background: C.navy, padding: "12px 16px", position: "sticky", top: notice ? 38 : 0, zIndex: 100, borderBottom: `2px solid ${C.accent}44` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/logo.webp" alt="" width={30} height={30} style={{ width: 30, height: 30, borderRadius: 8, display: "block" }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: "#fff", fontWeight: 900, fontSize: 15, lineHeight: 1.1 }}>신전스퀘어</div>
            <div style={{ color: C.accent, fontSize: 8, letterSpacing: 1.5 }}>STUDIO RESERVATION</div>
          </div>
          {role === "chal" ? <Tag c={C.accent}>작도 챌린지</Tag> : <Tag c={connOk ? C.ok : C.err}>{connOk ? "서버 연결됨" : cfgSync.state === "loading" ? "연결 중…" : "연결 끊김"}</Tag>}
          {admin && <Tag c={C.accent}>관리자</Tag>}
          {admin && <button onClick={logoutAdmin} style={{ background: "transparent", border: "1px solid #344060", borderRadius: 7, color: "#a0b0cc", padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>로그아웃</button>}
          <button onClick={leaveAll} style={{ background: "transparent", border: "1px solid #344060", borderRadius: 7, color: "#a0b0cc", padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>처음으로</button>
        </div>
      </header>

      {<div style={{ padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.border}` }}><LinkBar links={cfg.links} /></div>}

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, position: "sticky", top: (notice ? 38 : 0) + 54, zIndex: 99 }}>
        <div style={{ display: "flex" }}>
          {(role === "chal" ? [["chal", "✍️ 작도 챌린지"]] : [["book", "📅 예약"], ["mine", "🗒 내 예약"], ["chal", "✍️ 작도"], ...(admin || cfg.showRanking ? [["rank", "🏆 랭킹"]] : []), ["admin", admin ? "⚙️ 관리" : "🔒 관리"]]).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ flex: 1, padding: "13px 2px", border: "none", background: "none", cursor: "pointer", fontWeight: tab === k ? 800 : 400, fontSize: 12, color: tab === k ? C.blue : C.light, borderBottom: `2.5px solid ${tab === k ? C.blue : "transparent"}` }}>{l}</button>
          ))}
        </div>
      </div>

      <main style={{ padding: "16px 14px 40px" }}>

        {/* ───── 예약 탭 ───── */}
        {tab === "book" && (!cfgLoaded ? (
          <div style={{ textAlign: "center", padding: "50px 16px", color: C.mid }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>{cfgSync.state === "fail" ? "📡" : "⏳"}</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{cfgSync.state === "fail" ? "서버에 연결할 수 없어요" : "서버에서 최신 설정을 불러오는 중…"}</div>
            <div style={{ fontSize: 12, color: C.light, margin: "6px 0 14px" }}>최신 정보를 확인한 뒤에 예약할 수 있어요</div>
            <button onClick={pullCfg} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 10, padding: "10px 22px", fontWeight: 700, cursor: "pointer" }}>다시 시도</button>
          </div>
        ) : (<>
          {cfgSync.state === "fail" && !admin && (
            <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, padding: "9px 14px", fontSize: 12, color: C.err, marginBottom: 12 }}>
              서버 연결이 불안정해요. 지금 보이는 정보가 최신이 아닐 수 있어요. <button onClick={pullCfg} style={{ marginLeft: 6, background: C.err, color: "#fff", border: "none", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>다시 시도</button>
            </div>
          )}

          <HomeBoard cfg={cfg} />

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 8 }}>날짜{admin && " (관리자: 2주치)"}</div>
            <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 4 }}>
              {week.map(d => {
                const open = admin || isOpenDate(d), isToday = d === today(), sel = d === date;
                return (
                  <button key={d} onClick={() => open && setDate(d)} disabled={!open}
                    style={{ flexShrink: 0, padding: "9px 12px", borderRadius: 11, textAlign: "center", border: `2px solid ${sel ? C.blue : open ? C.border : "#E8ECF4"}`, background: sel ? C.blue : open ? C.card : "#F6F8FC", cursor: open ? "pointer" : "not-allowed", minWidth: 52 }}>
                    <div style={{ fontSize: 10, color: sel ? "#fff" : isToday ? C.blue : C.light, fontWeight: 700 }}>{isToday ? "오늘" : DAY[dow(d)]}</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: sel ? "#fff" : open ? C.tx : "#C0CAD8", marginTop: 1 }}>{parseInt(d.split("-")[2])}</div>
                    {!open && <div style={{ fontSize: 8, color: C.light }}>미오픈</div>}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: C.light, marginTop: 6 }}>💡 오늘부터 3일 뒤까지 언제든 예약할 수 있어요</div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mid, marginBottom: 8 }}>스튜디오 선택</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              {studios.map(s => {
                const st = studioStat(s), sel = s.id === sid;
                const stC = st === "closed" || st === "locked" ? "#B0BAD0" : st === "full" ? C.err : st === "low" ? C.warn : C.ok;
                const pct = s.runs ? SLOTS.reduce((mx, sl) => Math.max(mx, slotBooked(dateRes, s.id, sl) / s.seats), 0) : 0;
                return (
                  <button key={s.id} onClick={() => setSid(s.id)} style={{ background: sel ? s.color : st === "closed" ? "#F1F3F9" : s.bg, borderRadius: 13, padding: "13px 14px", border: `2px solid ${sel ? s.color : s.color + "33"}`, cursor: "pointer", textAlign: "left", opacity: st === "closed" && !sel ? 0.7 : 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 14, color: sel ? "#fff" : st === "closed" ? C.light : s.color }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: sel ? "#fff8" : C.light, marginTop: 2 }}>{s.runs ? `${s.seats}석 운영` : "운영 안 함"}</div>
                    <div style={{ marginTop: 8, background: sel ? "#fff4" : C.border, borderRadius: 99, height: 4 }}>
                      <div style={{ width: st === "closed" || st === "locked" ? "100%" : `${pct * 100}%`, height: "100%", background: sel ? "#fff" : stC, borderRadius: 99 }} />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 10, fontWeight: 700, color: sel ? "#fff" : stC }}>
                      {st === "closed" ? "🔒 운영 안 함" : st === "locked" ? "🔒 이용불가" : st === "full" ? "마감" : st === "low" ? "잔여 적음" : "이용 가능"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 9, height: 9, borderRadius: "50%", background: studio.color, flexShrink: 0 }} />
              <b style={{ fontSize: 14, color: C.tx }}>{studio.name}</b>
              <span style={{ fontSize: 11, color: C.light }}>{studio.runs ? `${studio.seats}석` : "운영 안 함"}</span>
              <button onClick={() => { pullCfg(); loadDay(date, false); }} style={{ marginLeft: "auto", background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "3px 9px", cursor: "pointer", fontSize: 10, color: C.mid }}>{dayLoading ? "불러오는 중…" : "새로고침"}</button>
            </div>
            {day.ok === false && <ErrBox>예약 현황을 불러오지 못했어요. 지금은 예약할 수 없어요. <button onClick={() => loadDay(date, false)} style={{ marginLeft: 6, background: C.err, color: "#fff", border: "none", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>다시 시도</button></ErrBox>}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              {[["#ECFDF5", C.ok, "여유"], ["#FEF3C7", C.warn, "잔여 적음"], ["#FEE2E2", C.err, "마감"], ["#F1F3F9", "#A8B4CC", "잠금"]].map(([bg, c, l]) => (
                <div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: bg, border: `1px solid ${c}44` }} /><span style={{ fontSize: 10, color: C.light }}>{l}</span></div>
              ))}
            </div>
            <TimeGrid studio={studio} studios={studios} date={date} res={dateRes} locks={dateLocks} isAdmin={admin} info={cfg.info} onBook={onBook} onAddLock={addLock} blocked={day.ok === false || day.date !== date} />
            <div style={{ fontSize: 10, color: C.light, marginTop: 10, textAlign: "right" }}>자동 동기화 · 설정 확인 {clock(cfgSync.at) || "…"}</div>
          </div>

          {cfg.info.trim() && (
            <div style={{ background: "#FFF8E8", borderRadius: 13, padding: 14, border: `1px solid ${C.accent}44`, marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.navy, marginBottom: 6 }}>📋 이용 안내</div>
              <div style={{ fontSize: 11, color: C.mid, lineHeight: 2 }}>{cfg.info.split("\n").map((l, i) => <div key={i}>{l}</div>)}</div>
            </div>
          )}
        </>))}

        {/* ───── 내 예약 탭 ───── */}
        {tab === "mine" && <MyTab studios={studios} onCancelRes={cancelRes} />}
        {tab === "chal" && <ChallengeTab admin={admin} />}
        {tab === "rank" && (admin || cfg.showRanking) && <RankingTab since={cfg.rankingSince} />}

        {/* ───── 관리 탭 ───── */}
        {tab === "admin" && (admin ? (
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 12 }}>관리자 모드</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {[["rooms", "🏢 자습실 관리"], ["chal", "✍️ 작도 챌린지"]].map(([k, l]) => <button key={k} onClick={() => setAdminSub(k)} style={{ flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 13,
                border: `1.5px solid ${adminSub === k ? C.blue : C.border}`, background: adminSub === k ? C.blue : C.card, color: adminSub === k ? "#fff" : C.mid }}>{l}</button>)}
            </div>
            {adminSub === "chal" && <ChalSettings examDate={cfg.dday.date || ""} />}
            {adminSub === "rooms" && <>
            <RoomSettings cfg={cfg} onChange={changeCfg} sync={cfgSync} onRetry={flushCfg} />
            <BoardSettings cfg={cfg} onChange={changeCfg} />
            <WeeklyRules cfg={cfg} onChange={changeCfg} studios={studios} />
            <AdminDay date={date} setDate={setDate} dates={getAdminDates()} studios={studios} res={dateRes} locks={dateLocks} loading={dayLoading}
              onCancelRes={adminCancelRes} onDelLock={delLock} onAddLock={addLock} onSkipRule={skipRule} />
            <button onClick={() => setShowChgPw(true)} style={{ marginTop: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 16px", cursor: "pointer", fontSize: 12, color: C.mid, fontWeight: 600 }}>🔑 관리자 비밀번호 변경</button>
            <Diagnostics />
            </>}
            <div style={{ height: 90 }} />
            <SaveBar sync={cfgSync} busy={saveBusy} onSave={saveNow} />
          </div>
        ) : (
          <div style={{ maxWidth: 360, margin: "0 auto", paddingTop: 20 }}>
            <div style={{ textAlign: "center", marginBottom: 24 }}><div style={{ fontSize: 44, marginBottom: 10 }}>🔒</div><div style={{ fontSize: 18, fontWeight: 900, color: C.navy }}>관리자 로그인</div></div>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && loginAdmin()} placeholder="비밀번호" autoFocus
              style={{ ...inputStyle, padding: "13px 16px", borderRadius: 12, border: `2px solid ${pwErr ? C.err : C.border}`, marginBottom: 8 }} />
            {pwErr && <div style={{ fontSize: 12, color: C.err, marginBottom: 10 }}>❌ {pwErr}</div>}
            <button onClick={loginAdmin} disabled={loginBusy} style={{ width: "100%", background: C.navy, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>{loginBusy ? "확인 중…" : "로그인"}</button>
          </div>
        ))}
      </main>

      {showChgPw && <ChangePwSheet onClose={() => setShowChgPw(false)} onChange={changeAdminPw} />}
    </div>
  );
}
