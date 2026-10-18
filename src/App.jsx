import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═════════════════════════════════════════════
//  서버(Supabase) 연결
// ═════════════════════════════════════════════
const SB  = "https://yigtucvlikxeddqghtqw.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpZ3R1Y3ZsaWt4ZWRkcWdodHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTcwNjgsImV4cCI6MjA5Nzg3MzA2OH0.MoTdu9sYMOLIaLhCNY9Ivs3hg32MbiHoqlOMcbRpIwY";
const H   = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const ENTRY_CODE       = "0529";
const DEFAULT_ADMIN_PW = "0000";
const MAX_SEATS        = 15;
const enc = encodeURIComponent;

// 서버 권한(RLS) 문제가 있을 때 한 번 실행하는 복구 SQL (관리 탭 > 서버 진단에서 복사 가능)
const FIX_SQL = `create table if not exists settings (key text primary key, value text);
create table if not exists studio_reservations (id text primary key, date text, studio_id text, start_time text, end_time text, user_name text, user_class text, user_pw text);
create table if not exists studio_locks (id text primary key, date text, studio_id text, start_time text, end_time text, reason text);

alter table settings add column if not exists key text;
alter table settings add column if not exists value text;
alter table studio_locks add column if not exists reason text;

alter table settings enable row level security;
alter table studio_reservations enable row level security;
alter table studio_locks enable row level security;

drop policy if exists sj_anon_all on settings;
create policy sj_anon_all on settings for all to anon using (true) with check (true);
drop policy if exists sj_anon_all on studio_reservations;
create policy sj_anon_all on studio_reservations for all to anon using (true) with check (true);
drop policy if exists sj_anon_all on studio_locks;
create policy sj_anon_all on studio_locks for all to anon using (true) with check (true);

grant usage on schema public to anon;
grant select, insert, update, delete on settings, studio_reservations, studio_locks to anon;
notify pgrst, 'reload schema';`;

// 모든 요청의 공통 통로: 성공 여부·상태코드·데이터를 항상 돌려줌 (조용히 실패하지 않음)
const req = async (method, path, body, prefer) => {
  try {
    const headers = { ...H };
    if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      method, headers, cache: "no-store",
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
};

// 행 추가 후 서버에 실제로 들어갔는지 다시 읽어서 확인
const insertRow = async (table, row) => {
  const r = await req("POST", table, row, "return=minimal");
  if (!r.ok) return { ok: false, status: r.status };
  const chk = await req("GET", `${table}?id=eq.${enc(row.id)}&select=id`);
  return { ok: chk.ok && Array.isArray(chk.data) && chk.data.length > 0, status: r.status };
};

// 행 삭제 후 실제로 지워졌는지 확인 (권한 때문에 0건 삭제되는 경우를 잡아냄)
const removeRow = async (table, id) => {
  const r = await req("DELETE", `${table}?id=eq.${enc(id)}`, null, "return=representation");
  if (!r.ok) return { ok: false, status: r.status };
  if (Array.isArray(r.data) && r.data.length > 0) return { ok: true };
  const chk = await req("GET", `${table}?id=eq.${enc(id)}&select=id`);
  if (chk.ok && Array.isArray(chk.data) && chk.data.length === 0) return { ok: true };
  return { ok: false, status: r.status, blocked: true };
};

// settings 테이블: 수정 먼저, 없으면 추가 (삭제 후 추가하는 빈 구간이 없음)
const upsertSetting = async (key, value) => {
  const p = await req("PATCH", `settings?key=eq.${enc(key)}`, { value }, "return=representation");
  if (p.ok && Array.isArray(p.data) && p.data.length > 0) return { ok: true };
  const i = await req("POST", "settings", { key, value }, "return=minimal");
  return { ok: i.ok, status: i.status };
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

const makeDefaultCfg = () => ({
  rev: 0,
  info: DEFAULT_INFO,
  showRanking: true,
  weekly: [],
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
    weekly: normalizeWeekly(v?.weekly),
    rooms,
  };
};

// 서버에서 설정 읽기 (중복 행이 있어도 rev가 가장 큰 값을 사용)
const readConfig = async () => {
  const r = await req("GET", "settings?key=eq.room_config&select=value");
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, status: r.status };
  let best = null;
  for (const row of r.data) {
    try {
      const v = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      if (v && v.rooms && (!best || (v.rev || 0) > (best.rev || 0))) best = v;
    } catch {}
  }
  return { ok: true, cfg: best };
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
const CLASSES = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + "반"),
  "온라인", "무한모의고사반", "기타",
];

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

// 학생: 오늘은 항상, 내일부터는 오전 9시 이후 오픈 / 관리자: 14일
const isOpenDate = ds => ds === today() || new Date().getHours() >= 9;
const getDates      = () => Array.from({ length: 4 },  (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return toStr(d); });
const getAdminDates = () => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return toStr(d); });

const slotsIn = (s, e) => SLOTS.filter(x => x >= s && x < e);
const overlaps = (r, slot) => r.start_time < add30(slot) && r.end_time > slot;
const manualLock = (locks, sid, slot) => locks.find(l => (l.studio_id === sid || l.studio_id === "ALL") && l.start_time < add30(slot) && l.end_time > slot);
const slotBooked = (res, sid, slot) => res.filter(r => r.studio_id === sid && overlaps(r, slot)).length;

// 동시 예약으로 정원이 넘쳤는지 (id 순서로 앞선 사람이 우선 → 두 기기가 같은 결론)
const overbooked = (res, mine, seats) => slotsIn(mine.start_time, mine.end_time).some(slot => {
  const rows = res.filter(r => r.studio_id === mine.studio_id && overlaps(r, slot)).sort((a, b) => (a.id < b.id ? -1 : 1));
  return rows.findIndex(r => r.id === mine.id) >= seats;
});

const fetchDay = async d => {
  const [a, b] = await Promise.all([
    req("GET", `studio_reservations?date=eq.${d}&order=start_time.asc`),
    req("GET", `studio_locks?date=eq.${d}`),
  ]);
  if (!a.ok || !Array.isArray(a.data)) return null;
  return { res: a.data.map(normT), locks: b.ok && Array.isArray(b.data) ? b.data.map(normT) : [] };
};

// 정기 규칙 → 해당 날짜의 잠금(서버 설정에서 계산, 학생·관리자 동일)
const ruleLocks = (weekly, date) => (weekly || [])
  .filter(r => r.days.includes(dow(date)) && !(r.skip || []).includes(date))
  .map(r => ({ id: `rule:${r.id}:${date}`, rule_id: r.id, rule: true, date, studio_id: r.studio_id, start_time: r.start, end_time: r.end, reason: r.reason }));

// ═════════════════════════════════════════════
//  랭킹 계산 (예약해서 이용이 끝난 시간 기준)
// ═════════════════════════════════════════════
const toMin    = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmtDur   = min => { const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h}시간 ${m}분` : h ? `${h}시간` : `${m}분`; };
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
    const key = `${name}|${r.user_class || ""}`;
    if (!people.has(key)) people.set(key, { key, name, cls: r.user_class || "", days: new Map() });
    const p = people.get(key);
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

// 서버가 한 번에 1000행까지만 주므로 나눠서 모두 가져옴
const fetchRankRows = async (from, to) => {
  const PAGE = 1000, all = [];
  for (let page = 0; page < 30; page++) {
    const r = await req("GET", `studio_reservations?select=user_name,user_class,date,start_time,end_time&date=gte.${from}&date=lte.${to}&order=date.asc,id.asc&limit=${PAGE}&offset=${page * PAGE}`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    all.push(...r.data);
    if (r.data.length < PAGE) break;
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

function TextCommit({ value, onCommit, multiline, maxLength, style }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const commit = () => {
    const t = multiline ? v : v.trim();
    if (!multiline && !t) { setV(value); return; }
    if (t !== value) onCommit(t);
  };
  if (multiline) {
    return <textarea value={v} maxLength={maxLength} rows={5} onChange={e => setV(e.target.value)} onBlur={commit} style={style} />;
  }
  return <input value={v} maxLength={maxLength} onChange={e => setV(e.target.value)} onBlur={commit}
    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} style={style} />;
}

// ═════════════════════════════════════════════
//  예약 시트
// ═════════════════════════════════════════════
function BookSheet({ studio, date, s1, s2, onClose, onSubmit, onSuccess }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem("sj_last_name") || ""; } catch { return ""; } });
  const [cls, setCls]   = useState(() => { try { return localStorage.getItem("sj_last_cls") || "A반"; } catch { return "A반"; } });
  const [pw, setPw]     = useState("");
  const [err, setErr]   = useState("");
  const [busy, setBusy] = useState(false);
  const endTime = add30(s2);

  const confirm = async () => {
    if (busy) return;
    if (!name.trim()) { setErr("이름을 입력해주세요"); return; }
    if (!/^[0-9]{4}$/.test(pw)) { setErr("비밀번호는 숫자 4자리로 입력해주세요"); return; }
    setBusy(true); setErr("");
    const payload = { id: uid(), date, studio_id: studio.id, start_time: s1, end_time: endTime, user_name: name.trim(), user_class: cls, user_pw: pw };
    const r = await onSubmit(payload);
    setBusy(false);
    if (r.ok) {
      try { localStorage.setItem("sj_last_name", name.trim()); localStorage.setItem("sj_last_cls", cls); } catch {}
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
          <label style={labelStyle}>반 *</label>
          <select value={cls} onChange={e => setCls(e.target.value)} style={{ ...inputStyle, background: C.card }}>
            {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
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
          👤 {booking.user_name} ({booking.user_class})
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
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 20 }}>🔑 관리자 비밀번호 변경</div>
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

function LockSheet({ date, studio, studios, onClose, onSubmit }) {
  const [sid, setSid] = useState(studio?.id || "A");
  const [t1, setT1] = useState("09:00"); const [t2, setT2] = useState("22:00");
  const [reason, setReason] = useState("강의"); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => {
    if (t1 >= t2) { setErr("종료시간이 시작보다 늦어야 해요"); return; }
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
        <button onClick={save} disabled={busy} style={{ flex: 1, background: C.err, color: "#fff", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, cursor: "pointer" }}>{busy ? "저장 중…" : "잠금 설정"}</button>
        <button onClick={onClose} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 16px", cursor: "pointer", color: C.mid }}>취소</button>
      </div>
    </Sheet>
  );
}

// ═════════════════════════════════════════════
//  타임 그리드 (학생/관리자 공용)
// ═════════════════════════════════════════════
function TimeGrid({ studio, studios, date, res, locks, isAdmin, info, onBook, onAddLock }) {
  const [sel1, setSel1] = useState(null);
  const [sel2, setSel2] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { setSel1(null); setSel2(null); }, [studio.id, date]);

  const lockOf = slot => manualLock(locks, studio.id, slot);
  const full = slot => slotBooked(res, studio.id, slot) >= studio.seats;
  const clearSel = () => { setSel1(null); setSel2(null); };

  const click = slot => {
    if (!studio.runs || lockOf(slot) || full(slot)) return;
    if (!sel1 || slot < sel1) { setSel1(slot); setSel2(slot); return; }
    const range = SLOTS.filter(s => s >= sel1 && s <= slot);
    if (range.some(s => lockOf(s) || full(s))) { setSel1(slot); setSel2(slot); } // 중간에 잠금/마감이 있으면 새로 시작
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
          const who = isAdmin ? res.filter(r => r.studio_id === studio.id && overlaps(r, slot)) : [];
          return (
            <div key={slot}>
              <div onClick={() => click(slot)} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 9,
                background: sel ? studio.color : ss.bg,
                border: `1.5px solid ${sel ? studio.color : lk ? "#E2E8F0" : ss.tc + "44"}`,
                cursor: lk || full(slot) ? "not-allowed" : "pointer", userSelect: "none" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: sel ? "#fff9" : C.light, width: 40, flexShrink: 0 }}>{slot}</span>
                <div style={{ flex: 1, height: 5, background: sel ? "#fff4" : C.border, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: lk ? "100%" : `${Math.min((cnt / studio.seats) * 100, 100)}%`, background: sel ? "#fff" : lk ? "#C8D0E0" : ss.tc, borderRadius: 99 }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: sel ? "#fff" : ss.tc, width: lk ? 60 : 32, textAlign: "right", flexShrink: 0 }}>{lk ? `🔒${lk.reason || ""}` : ss.label}</span>
              </div>
              {who.length > 0 && (
                <div style={{ paddingLeft: 52, display: "flex", gap: 4, flexWrap: "wrap", margin: "2px 0" }}>
                  {who.map(r => <span key={r.id} style={{ background: studio.bg, borderRadius: 6, padding: "2px 8px", fontSize: 11, color: studio.color }}>{r.user_name}({r.user_class})</span>)}
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
      {sheet === "lock" && <LockSheet date={date} studio={studio} studios={studios} onClose={() => setSheet(null)} onSubmit={onAddLock} />}
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
    bookings.forEach(b => { if ((pws[b.id] || "") !== String(b.user_pw)) e[b.id] = "비밀번호가 틀려요"; });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setMsg("");
    for (const b of bookings) {
      const r = await onCancelOne(b.id);
      if (!r.ok) { setBusy(false); setMsg(r.msg); return; }
    }
    setBusy(false); onDone(); onClose();
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

function RankingTab() {
  const [period, setPeriod] = useState("week");
  const [rows, setRows] = useState(null);
  const [fail, setFail] = useState(false);
  const [me, setMe] = useState("");
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    const from = period === "week" ? weekStart() : period === "month" ? monthStart() : "2000-01-01";
    const data = await fetchRankRows(from, today());
    if (id !== reqId.current) return;
    if (data === null) { setFail(true); return; }
    setFail(false);
    setRows(buildRanking(data, today(), nowHM()));
  }, [period]);

  useEffect(() => { setRows(null); load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const medal = r => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}등`;
  const top = rows ? rows.filter(p => p.rank <= 5).slice(0, 10) : [];
  const max = top.length ? top[0].minutes : 1;
  const q = normName(me);
  const mine = q && rows ? rows.filter(p => p.name === q) : [];

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🏆 공부왕 랭킹</div>
      <div style={{ fontSize: 11, color: C.light, marginBottom: 12 }}>예약해서 이용을 마친 시간 기준이에요 (출석 체크가 아니라 예약 기준)</div>
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
                  <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{p.name}{p.cls && <span style={{ fontWeight: 400, fontSize: 11, color: C.light }}> · {p.cls}</span>}</div>
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
          {mine.map(p => <div key={p.key} style={{ fontSize: 13, color: C.navy, marginTop: 8, fontWeight: 700 }}>{p.name}{p.cls && ` (${p.cls})`} — {p.rank}등 · {fmtDur(p.minutes)} · {p.days}일</div>)}
        </div>
      )}
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
    const r = await req("GET", `studio_reservations?user_name=eq.${enc(n)}&date=gte.${today()}&order=date.asc,start_time.asc`);
    setBusy(false);
    if (!r.ok || !Array.isArray(r.data)) { setErr("서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요."); setList(null); return; }
    setList(r.data.map(normT));
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
                  <div style={{ fontSize: 11, color: C.light, marginTop: 2 }}>{r.user_class}</div>
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
    </div>
  );
}

// ═════════════════════════════════════════════
//  관리자: 날짜별 예약·잠금 현황
// ═════════════════════════════════════════════
function WeeklyRules({ cfg, onChange, studios }) {
  const [sid, setSid] = useState("A");
  const [days, setDays] = useState([]);
  const [t1, setT1] = useState("19:00"); const [t2, setT2] = useState("22:00");
  const [reason, setReason] = useState("강의"); const [err, setErr] = useState("");
  const rules = cfg.weekly || [];
  const nameOf = id => id === "ALL" ? "전체 스튜디오" : (studios.find(s => s.id === id)?.name || id);
  const toggleDay = d => setDays(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d].sort());
  const add = () => {
    if (!days.length) { setErr("요일을 하나 이상 선택해주세요"); return; }
    if (t1 >= t2) { setErr("종료시간이 시작보다 늦어야 해요"); return; }
    if (rules.length >= 60) { setErr("규칙은 최대 60개까지 만들 수 있어요"); return; }
    setErr("");
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
        <button onClick={add} style={{ width: "100%", background: C.navy, color: "#fff", border: "none", borderRadius: 11, padding: 12, fontWeight: 800, cursor: "pointer", fontSize: 14 }}>+ 반복 강의 추가</button>
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
        return (
          <div key={s.id} style={{ background: C.card, borderRadius: 14, padding: 14, marginBottom: 10, border: `1.5px solid ${s.color}33` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ width: 9, height: 9, borderRadius: "50%", background: s.color }} />
              <b style={{ color: s.color, fontSize: 13 }}>{s.name}</b>
              <Tag c={s.runs ? C.ok : C.light}>{s.runs ? `${s.seats}석 운영` : "닫힘"}</Tag>
              {sRes.length > 0 && <Tag c={s.color}>{sRes.length}건 예약</Tag>}
              <button onClick={() => setLockFor(s)} style={{ ...smallBtn, marginLeft: "auto", background: "#fff", border: `1px solid ${C.err}55` }}>🔒 잠금 추가</button>
            </div>
            {sRes.length === 0 && sLocks.length === 0 && <div style={{ fontSize: 12, color: C.light }}>예약·잠금 없음</div>}
            {sRes.map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, background: s.bg, borderRadius: 8, padding: "8px 12px", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color, width: 84 }}>{r.start_time}~{r.end_time}</span>
                <span style={{ flex: 1, fontSize: 13, color: C.tx, fontWeight: 600 }}>{r.user_name} <span style={{ fontSize: 11, color: C.light }}>({r.user_class})</span></span>
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
      {lockFor && <LockSheet date={date} studio={lockFor} studios={studios} onClose={() => setLockFor(null)} onSubmit={onAddLock} />}
    </div>
  );
}

// ═════════════════════════════════════════════
//  관리자: 서버 진단 (읽기/쓰기/수정/삭제가 실제로 되는지 점검)
// ═════════════════════════════════════════════
function Diagnostics() {
  const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  const run = async () => {
    setBusy(true); const out = [];
    const st = r => {
      const why = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data.message || r.data.hint || r.data.details || "") : "";
      return `HTTP ${r.status || "연결 실패"}${why ? " · " + String(why).slice(0, 140) : ""}`;
    };
    const add = (label, r, needRows) => {
      const ok = r.ok && (!needRows || (Array.isArray(r.data) && r.data.length > 0));
      out.push({ label, ok, detail: r.ok && needRows && !ok ? "요청은 통과했지만 0건 처리됨 (권한이 막고 있어요)" : st(r) });
    };
    const k = `__diag_${Date.now().toString(36)}`;
    add("설정 읽기", await req("GET", "settings?select=key&limit=1"));
    add("설정 추가", await req("POST", "settings", { key: k, value: "1" }, "return=minimal"));
    add("설정 수정", await req("PATCH", `settings?key=eq.${k}`, { value: "2" }, "return=representation"), true);
    add("설정 삭제", await req("DELETE", `settings?key=eq.${k}`, null, "return=representation"), true);
    const lid = `diag-${Date.now().toString(36)}`;
    add("잠금 읽기", await req("GET", "studio_locks?select=id&limit=1"));
    add("잠금 추가", await req("POST", "studio_locks", { id: lid, date: "1999-01-01", studio_id: "A", start_time: "09:00", end_time: "10:00", reason: "diag" }, "return=minimal"));
    add("잠금 삭제", await req("DELETE", `studio_locks?id=eq.${lid}`, null, "return=representation"), true);
    const rid = `diag-${Date.now().toString(36)}r`;
    add("예약 읽기", await req("GET", "studio_reservations?select=id&limit=1"));
    add("예약 추가", await req("POST", "studio_reservations", { id: rid, date: "1999-01-01", studio_id: "A", start_time: "09:00", end_time: "10:00", user_name: "diag", user_class: "A반", user_pw: "0000" }, "return=minimal"));
    add("예약 삭제", await req("DELETE", `studio_reservations?id=eq.${rid}`, null, "return=representation"), true);
    setRows(out); setBusy(false);
  };
  const allOk = rows && rows.every(r => r.ok);
  const copy = async () => { try { await navigator.clipboard.writeText(FIX_SQL); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} };

  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, marginTop: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.navy, marginBottom: 4 }}>🛠 서버 진단</div>
      <div style={{ fontSize: 11, color: C.mid, marginBottom: 12 }}>설정이 학생들에게 안 보이거나 저장이 안 될 때 눌러보세요. 서버가 읽기·쓰기·수정·삭제를 실제로 허용하는지 점검해요. (테스트 데이터는 자동으로 지워져요)</div>
      <button onClick={run} disabled={busy} style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 800, cursor: "pointer", fontSize: 13 }}>{busy ? "점검 중…" : "진단 실행"}</button>
      {rows && (
        <div style={{ marginTop: 12 }}>
          {rows.map(r => (
            <div key={r.label} style={{ display: "flex", gap: 8, fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.bg}` }}>
              <span style={{ width: 20 }}>{r.ok ? "✅" : "❌"}</span><span style={{ width: 70, fontWeight: 700 }}>{r.label}</span><span style={{ color: r.ok ? C.light : C.err, flex: 1 }}>{r.detail}</span>
            </div>
          ))}
          {allOk ? (
            <div style={{ marginTop: 10, fontSize: 12, color: C.ok, fontWeight: 700 }}>모두 정상이에요. 설정은 학생 화면과 동일하게 동기화돼요.</div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: C.err, fontWeight: 700, marginBottom: 6 }}>서버 권한 설정이 막고 있어요. 아래 SQL을 Supabase › SQL Editor에 붙여넣고 Run 한 뒤 다시 진단하세요.</div>
              <textarea readOnly value={FIX_SQL} rows={8} onFocus={e => e.target.select()}
                style={{ width: "100%", fontSize: 10, fontFamily: "monospace", padding: 8, borderRadius: 8, border: `1px solid ${C.border}`, boxSizing: "border-box" }} />
              <button onClick={copy} style={{ marginTop: 6, background: C.blue, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", fontSize: 12 }}>{copied ? "복사됨 ✓" : "SQL 복사"}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════
//  메인 앱
// ═════════════════════════════════════════════
export default function App() {
  // ── 입장 코드 ──
  const [entryOk, setEntryOk] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);
  const [entryInput, setEntryInput] = useState("");
  const [entryErr, setEntryErr] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem("sj_booking_entry_ok") === "1") setEntryOk(true); } catch {}
    setEntryChecked(true);
  }, []);
  const tryEntry = () => {
    if (entryInput.trim() === ENTRY_CODE) { setEntryOk(true); try { localStorage.setItem("sj_booking_entry_ok", "1"); } catch {} }
    else { setEntryErr(true); setEntryInput(""); }
  };

  // ── UI 상태 ──
  const [tab, setTab] = useState("book");
  const [admin, setAdmin] = useState(false);
  const [pw, setPw] = useState(""); const [pwErr, setPwErr] = useState(""); const [loginBusy, setLoginBusy] = useState(false);
  const [showChgPw, setShowChgPw] = useState(false);
  const [date, setDate] = useState(today());
  const [sid, setSid] = useState("A");
  const [notice, setNotice] = useState(null);
  useEffect(() => { if (notice?.kind === "ok") { const t = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(t); } }, [notice]);

  // ── 자습실 설정: 서버가 유일한 기준. 이 기기의 저장값(localStorage)은 사용하지 않음 ──
  const [cfg, setCfg] = useState(makeDefaultCfg);
  const cfgRef = useRef(cfg);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [cfgSync, setCfgSync] = useState({ state: "loading", at: null, msg: "" });
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);

  const flushCfg = useCallback(async () => {
    if (savingRef.current) { pendingRef.current = true; return; }
    savingRef.current = true;
    setCfgSync(s => ({ ...s, state: "saving" }));
    try {
      do {
        pendingRef.current = false;
        const snap = cfgRef.current;
        const w = await upsertSetting("room_config", JSON.stringify(snap));
        if (!w.ok) throw new Error(`서버가 저장을 거부했어요 ${w.status || ""}`.trim());
        const back = await readConfig();
        if (!pendingRef.current && (!back.ok || !back.cfg || back.cfg.rev !== snap.rev)) throw new Error("서버에 반영됐는지 확인되지 않았어요");
      } while (pendingRef.current);
      dirtyRef.current = false;
      setCfgSync({ state: "ok", at: new Date(), msg: "" });
    } catch (e) {
      setCfgSync({ state: "fail", at: null, msg: e.message });
    } finally { savingRef.current = false; }
  }, []);

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
    if (dirtyRef.current || savingRef.current) return; // 내가 저장 중이면 덮어쓰지 않음
    if (r.cfg) {
      const n = normalizeCfg(r.cfg);
      if (n.rev > cfgRef.current.rev) { cfgRef.current = n; setCfg(n); } // 더 새로운 설정만 반영 (늦게 도착한 옛 응답이 덮어쓰지 않도록)
    }
    setCfgSync({ state: "ok", at: new Date(), msg: "" });
  }, []);

  useEffect(() => {
    if (!entryOk) return;
    const tick = () => { pullCfg(); if (dirtyRef.current && !savingRef.current) flushCfg(); };
    tick();
    const iv = setInterval(tick, 4000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", tick);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", tick); };
  }, [entryOk, pullCfg, flushCfg]);

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
      if (r) setDay({ date: d, res: r.res, locks: r.locks, ok: true });
      else setDay(p => ({ ...p, ok: false }));
    }
    if (!silent) setDayLoading(false);
  }, []);
  useEffect(() => {
    if (!entryOk) return;
    loadDay(date, false);
    const iv = setInterval(() => loadDay(date, true), 6000);
    const onVis = () => { if (document.visibilityState === "visible") loadDay(date, true); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [date, entryOk, loadDay]);
  const dateRes = day.date === date ? day.res : [];
  const dateLocks = useMemo(() => [...(day.date === date ? day.locks : []), ...ruleLocks(cfg.weekly, date)], [day, date, cfg.weekly]);

  const failNotice = (label, r) => setNotice({ kind: "err", text: `${label} (코드 ${r.status || "연결 실패"}${r.blocked ? ", 권한 차단" : ""}). 관리 탭 › 서버 진단으로 원인을 확인해주세요.` });

  // ── 예약: 서버에서 최신 설정·예약·잠금을 다시 확인하고, 저장 후에도 검증 ──
  const onBook = useCallback(async payload => {
    const [c, d] = await Promise.all([readConfig(), fetchDay(payload.date)]);
    if (!c.ok || !d) return { ok: false, msg: "서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요." };
    const room = normalizeCfg(c.cfg || makeDefaultCfg()).rooms[payload.studio_id];
    if (!room.open || room.seats <= 0) return { ok: false, msg: "지금은 운영하지 않는 자습실이에요." };
    for (const sl of slotsIn(payload.start_time, payload.end_time)) {
      if (manualLock([...d.locks, ...ruleLocks(normalizeCfg(c.cfg || makeDefaultCfg()).weekly, payload.date)], payload.studio_id, sl)) return { ok: false, msg: "선택한 시간에 잠금이 설정돼 있어요." };
      if (slotBooked(d.res, payload.studio_id, sl) >= room.seats) return { ok: false, msg: "방금 마감된 시간이 있어요. 다른 시간을 선택해주세요." };
    }
    const ins = await req("POST", "studio_reservations", payload, "return=minimal");
    if (!ins.ok) return { ok: false, msg: `예약 저장에 실패했어요 (코드 ${ins.status || "연결 실패"}). 관리자에게 알려주세요.` };
    const after = await fetchDay(payload.date);
    if (!after || !after.res.some(r => r.id === payload.id)) return { ok: false, msg: "예약이 서버에서 확인되지 않았어요. '내 예약'에서 확인해주세요." };
    if (overbooked(after.res, payload, room.seats)) {
      await removeRow("studio_reservations", payload.id);
      loadDay(payload.date, true);
      return { ok: false, msg: "동시에 예약이 겹쳐 마감됐어요. 다른 시간을 선택해주세요." };
    }
    loadDay(payload.date, true);
    return { ok: true };
  }, [loadDay]);

  const cancelRes = useCallback(async id => {
    const r = await removeRow("studio_reservations", id);
    if (!r.ok) return { ok: false, msg: `취소에 실패했어요 (코드 ${r.status || "연결 실패"}${r.blocked ? ", 권한 차단" : ""}). 관리자에게 알려주세요.` };
    loadDay(dateRef.current, true);
    return { ok: true };
  }, [loadDay]);

  const adminCancelRes = async id => {
    const r = await cancelRes(id);
    if (!r.ok) setNotice({ kind: "err", text: r.msg }); else setNotice({ kind: "ok", text: "예약을 취소했어요" });
  };
  const addLock = async p => {
    const r = await insertRow("studio_locks", p);
    if (!r.ok) { failNotice("잠금 저장에 실패했어요", r); return false; }
    setNotice({ kind: "ok", text: "잠금을 설정했어요" }); await loadDay(date, true); return true;
  };
  const skipRule = (ruleId, d) => {
    changeCfg(c => ({ ...c, weekly: (c.weekly || []).map(r => r.id === ruleId ? { ...r, skip: [...new Set([...(r.skip || []), d])] } : r) }));
    setNotice({ kind: "ok", text: `${fmt(d)} 하루만 정기 잠금을 해제했어요` });
  };
  const delLock = async id => {
    const r = await removeRow("studio_locks", id);
    if (!r.ok) { failNotice("잠금 해제에 실패했어요", r); return; }
    setNotice({ kind: "ok", text: "잠금을 해제했어요" }); await loadDay(date, true);
  };

  // ── 관리자 로그인/비밀번호 (항상 서버 값과 비교) ──
  const loginAdmin = async () => {
    setLoginBusy(true); setPwErr("");
    const r = await req("GET", "settings?key=eq.booking_admin_pw&select=value");
    if (!r.ok) { setPwErr("서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요."); setLoginBusy(false); return; }
    const server = Array.isArray(r.data) && r.data.length ? String(r.data[r.data.length - 1].value) : DEFAULT_ADMIN_PW;
    if (pw === server) { setAdmin(true); setPw(""); } else setPwErr("비밀번호가 틀렸어요");
    setLoginBusy(false);
  };
  const logoutAdmin = () => { setAdmin(false); setDate(today()); };
  const changeAdminPw = async (cur, next) => {
    const r = await req("GET", "settings?key=eq.booking_admin_pw&select=value");
    if (!r.ok) return { ok: false, msg: "서버에 연결할 수 없어요" };
    const server = Array.isArray(r.data) && r.data.length ? String(r.data[r.data.length - 1].value) : DEFAULT_ADMIN_PW;
    if (cur !== server) return { ok: false, msg: "현재 비밀번호가 틀렸어요" };
    const w = await upsertSetting("booking_admin_pw", next);
    if (!w.ok) return { ok: false, msg: `서버 저장 실패 (코드 ${w.status || "연결 실패"}). 서버 진단을 실행해주세요.` };
    const chk = await req("GET", "settings?key=eq.booking_admin_pw&select=value");
    const last = chk.ok && Array.isArray(chk.data) && chk.data.length ? String(chk.data[chk.data.length - 1].value) : null;
    if (last !== next) return { ok: false, msg: "서버에서 변경이 확인되지 않았어요. 서버 진단을 실행해주세요." };
    return { ok: true };
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
  if (!entryOk) {
    return (
      <div style={{ minHeight: "100vh", background: C.navy, fontFamily: "'Noto Sans KR',sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 340, textAlign: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 18px" }}>🏛</div>
          <div style={{ color: "#fff", fontWeight: 900, fontSize: 19, marginBottom: 4 }}>신전스퀘어</div>
          <div style={{ color: C.accent, fontSize: 11, letterSpacing: 1.5, marginBottom: 28 }}>STUDIO RESERVATION</div>
          <div style={{ background: "#ffffff10", borderRadius: 16, padding: 24, border: "1px solid #ffffff22" }}>
            <div style={{ color: "#fff", fontSize: 14, fontWeight: 700, marginBottom: 6 }}>입장 코드를 입력해주세요</div>
            <div style={{ color: "#a0b0cc", fontSize: 11, marginBottom: 16 }}>신전스퀘어 수강생만 이용할 수 있어요</div>
            <input value={entryInput} onChange={e => { setEntryInput(e.target.value.replace(/\D/g, "").slice(0, 10)); setEntryErr(false); }}
              onKeyDown={e => e.key === "Enter" && tryEntry()} placeholder="입장 코드" autoFocus inputMode="numeric"
              style={{ width: "100%", padding: "13px 14px", borderRadius: 11, border: `1.5px solid ${entryErr ? C.err : "#ffffff33"}`, fontSize: 16, outline: "none", boxSizing: "border-box", textAlign: "center", letterSpacing: 6, background: "#ffffff12", color: "#fff", marginBottom: 10 }} />
            {entryErr && <div style={{ fontSize: 12, color: "#FF8A8A", marginBottom: 10 }}>❌ 코드가 올바르지 않아요</div>}
            <button onClick={tryEntry} style={{ width: "100%", background: C.accent, color: C.navy, border: "none", borderRadius: 11, padding: 13, fontWeight: 800, cursor: "pointer", fontSize: 15 }}>입장하기</button>
          </div>
        </div>
      </div>
    );
  }

  const week = admin ? getAdminDates() : getDates();
  const connOk = cfgSync.state === "ok" || cfgSync.state === "saving";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Noto Sans KR',sans-serif", maxWidth: 520, margin: "0 auto" }}>
      {notice && (
        <div style={{ position: "sticky", top: 0, zIndex: 200, background: notice.kind === "err" ? C.err : C.ok, color: "#fff", padding: "9px 14px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>{notice.kind === "err" ? "⚠️ " : "✅ "}{notice.text}</span>
          <button onClick={() => setNotice(null)} style={{ background: "#ffffff33", border: "none", borderRadius: 6, color: "#fff", padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>닫기</button>
        </div>
      )}

      <header style={{ background: C.navy, padding: "12px 16px", position: "sticky", top: notice ? 38 : 0, zIndex: 100, borderBottom: `2px solid ${C.accent}44` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🏛</div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#fff", fontWeight: 900, fontSize: 15, lineHeight: 1.1 }}>신전스퀘어</div>
            <div style={{ color: C.accent, fontSize: 8, letterSpacing: 1.5 }}>STUDIO RESERVATION</div>
          </div>
          <Tag c={connOk ? C.ok : C.err}>{connOk ? "서버 연결됨" : cfgSync.state === "loading" ? "연결 중…" : "연결 끊김"}</Tag>
          {admin && <Tag c={C.accent}>관리자</Tag>}
          {admin && <button onClick={logoutAdmin} style={{ background: "transparent", border: "1px solid #344060", borderRadius: 7, color: "#a0b0cc", padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>로그아웃</button>}
        </div>
      </header>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, position: "sticky", top: (notice ? 38 : 0) + 54, zIndex: 99 }}>
        <div style={{ display: "flex" }}>
          {[["book", "📅 예약"], ["mine", "🗒 내 예약"], ...(admin || cfg.showRanking ? [["rank", "🏆 랭킹"]] : []), ["admin", admin ? "⚙️ 관리" : "🔒 관리"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ flex: 1, padding: "13px 4px", border: "none", background: "none", cursor: "pointer", fontWeight: tab === k ? 800 : 400, fontSize: 13, color: tab === k ? C.blue : C.light, borderBottom: `2.5px solid ${tab === k ? C.blue : "transparent"}` }}>{l}</button>
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
            <div style={{ fontSize: 10, color: C.light, marginTop: 6 }}>💡 매일 오전 9시에 3일치 예약 오픈</div>
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
            {day.ok === false && <ErrBox>예약 현황을 불러오지 못했어요. 새로고침을 눌러주세요.</ErrBox>}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              {[["#ECFDF5", C.ok, "여유"], ["#FEF3C7", C.warn, "잔여 적음"], ["#FEE2E2", C.err, "마감"], ["#F1F3F9", "#A8B4CC", "잠금"]].map(([bg, c, l]) => (
                <div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: bg, border: `1px solid ${c}44` }} /><span style={{ fontSize: 10, color: C.light }}>{l}</span></div>
              ))}
            </div>
            <TimeGrid studio={studio} studios={studios} date={date} res={dateRes} locks={dateLocks} isAdmin={admin} info={cfg.info} onBook={onBook} onAddLock={addLock} />
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
        {tab === "rank" && (admin || cfg.showRanking) && <RankingTab />}

        {/* ───── 관리 탭 ───── */}
        {tab === "admin" && (admin ? (
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: C.navy, marginBottom: 12 }}>관리자 모드</div>
            <RoomSettings cfg={cfg} onChange={changeCfg} sync={cfgSync} onRetry={flushCfg} />
            <WeeklyRules cfg={cfg} onChange={changeCfg} studios={studios} />
            <AdminDay date={date} setDate={setDate} dates={getAdminDates()} studios={studios} res={dateRes} locks={dateLocks} loading={dayLoading}
              onCancelRes={adminCancelRes} onDelLock={delLock} onAddLock={addLock} onSkipRule={skipRule} />
            <button onClick={() => setShowChgPw(true)} style={{ marginTop: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 16px", cursor: "pointer", fontSize: 12, color: C.mid, fontWeight: 600 }}>🔑 관리자 비밀번호 변경</button>
            <Diagnostics />
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
