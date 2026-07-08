import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ─────────────────────────────────────────────
//  Supabase (백그라운드 동기화용)
// ─────────────────────────────────────────────
const SB = "https://yigtucvlikxeddqghtqw.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpZ3R1Y3ZsaWt4ZWRkcWdodHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTcwNjgsImV4cCI6MjA5Nzg3MzA2OH0.MoTdu9sYMOLIaLhCNY9Ivs3hg32MbiHoqlOMcbRpIwY";
const H  = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const DEFAULT_ADMIN_PW = "0000";

// Supabase 요청 (실패해도 조용히)
const sbFetch = async (path) => {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H });
    return r.ok ? r.json() : null;
  } catch { return null; }
};
const sbInsert = async (table, body) => {
  try {
    const r = await fetch(`${SB}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      console.error(`[Supabase] ${table} 저장 실패 (${r.status}):`, t);
      return false;
    }
    return true;
  } catch (e) { console.error(`[Supabase] ${table} 저장 중 네트워크 오류:`, e); return false; }
};
const sbDelete = async (table, filter) => {
  try {
    const r = await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: H });
    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      console.error(`[Supabase] ${table} 삭제 실패 (${r.status}):`, t);
      return false;
    }
    return true;
  } catch (e) { console.error(`[Supabase] ${table} 삭제 중 네트워크 오류:`, e); return false; }
};

// ─────────────────────────────────────────────
//  디자인
// ─────────────────────────────────────────────
const C = {
  navy:"#1A2A45", blue:"#2B58B8", accent:"#C8A655",
  bg:"#F0F4FB", card:"#fff", border:"#DAE0EF",
  tx:"#1A2A45", mid:"#475070", light:"#8290B0",
  ok:"#059669", warn:"#D97706", err:"#DC2626",
};

// ─────────────────────────────────────────────
//  상수
// ─────────────────────────────────────────────
const STUDIOS = [
  { id:"A", name:"스튜디오 A", seats:10, color:"#2B58B8", bg:"#EBF0FB" },
  { id:"B", name:"스튜디오 B", seats:10, color:"#7C3AED", bg:"#F3EFFE" },
  { id:"C", name:"스튜디오 C", seats:8,  color:"#059669", bg:"#ECFDF5" },
  { id:"D", name:"스튜디오 D", seats:4,  color:"#D97706", bg:"#FFFBEB" },
];

// 09:00 ~ 21:30 (30분 단위)
const SLOTS = [];
for (let h = 9; h < 22; h++) {
  SLOTS.push(`${String(h).padStart(2,"0")}:00`);
  if (h < 21) SLOTS.push(`${String(h).padStart(2,"0")}:30`);
}
SLOTS.push("21:30");

// 공지 기준 고정 잠금 (0=일 1=월 2=화 3=수 4=목 5=금 6=토)
const FIXED = [
  { s:"A", d:[0,1,2,3,4,5,6], t1:"09:00", t2:"22:00", r:"재오픈 준비중" },
  { s:"C", d:[0,1,2,3,4,5,6], t1:"09:00", t2:"22:00", r:"재오픈 준비중" },
  { s:"B", d:[6],             t1:"09:00", t2:"22:00", r:"강의" },
  { s:"B", d:[0],             t1:"09:00", t2:"18:00", r:"강의" },
  { s:"B", d:[3,4],           t1:"18:00", t2:"22:00", r:"강의" },
];
const DAY = ["일","월","화","수","목","금","토"];

// ─────────────────────────────────────────────
//  반 목록
// ─────────────────────────────────────────────
const CLASSES = [
  ...Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+"반"),
  "온라인","무한모의고사반","기타"
];

// ─────────────────────────────────────────────
//  유틸
// ─────────────────────────────────────────────
const uid    = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const add30  = t => { const [h,m]=t.split(":").map(Number),tot=h*60+m+30; return `${String(Math.floor(tot/60)).padStart(2,"0")}:${String(tot%60).padStart(2,"0")}`; };
const toStr  = d => { const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),dd=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${dd}`; };
const dow    = s => new Date(s+"T12:00:00").getDay();
const fmt    = s => { const [,m,d]=s.split("-"); return `${parseInt(m)}.${parseInt(d)}`; };
const today  = () => toStr(new Date());

// 오전 9시 이후면 오늘~3일 뒤 전부 예약 가능 (오늘은 항상 가능)
const isOpen = ds => {
  const now = new Date();
  const todayStr = toStr(now);
  if (ds === todayStr) return true; // 오늘은 항상 열림
  const today9 = new Date(); today9.setHours(9,0,0,0);
  return now >= today9; // 9시 이후면 3일치 전부 열림
};

// 일반 사용자용 날짜 목록 (오늘 포함 4일치)
const getDates = () => Array.from({length:4},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()+i); return toStr(d); });

// 관리자용 날짜 목록 (오늘 포함 2주 = 14일치)
const getAdminDates = () => Array.from({length:14},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()+i); return toStr(d); });

// 고정 잠금 확인
const fixedLock = (sid,ds,slot) => {
  const day=dow(ds), end=add30(slot);
  return FIXED.find(f=>f.s===sid&&f.d.includes(day)&&f.t1<end&&f.t2>slot);
};

// 수동 잠금 확인
const manualLock = (locks,sid,slot) => {
  const end=add30(slot);
  return locks.find(l=>(l.studio_id===sid||l.studio_id==="ALL")&&l.start_time<end&&l.end_time>slot);
};

// 슬롯 잠금 여부 + 이유
const slotLock = (locks,sid,ds,slot) => {
  const fix=fixedLock(sid,ds,slot);
  if(fix) return fix.r;
  const man=manualLock(locks,sid,slot);
  if(man) return man.reason||"강의";
  return null;
};

// 슬롯 예약 인원
const slotBooked = (res,sid,slot) => {
  const end=add30(slot);
  return res.filter(r=>r.studio_id===sid&&r.start_time<end&&r.end_time>slot).length;
};

// 슬롯 색상
const slotStyle = (booked,total,locked) => {
  if(locked) return { bg:"#F1F3F9", tc:"#A8B4CC", label:"🔒" };
  const rem=total-booked;
  if(rem<=0) return { bg:"#FEE2E2", tc:C.err,  label:"마감" };
  if(rem<=2) return { bg:"#FEF3C7", tc:C.warn, label:`${rem}석` };
  return       { bg:"#ECFDF5", tc:C.ok,   label:`${rem}석` };
};

// ─────────────────────────────────────────────
//  소형 UI
// ─────────────────────────────────────────────
const Tag = ({c,bg,children}) => (
  <span style={{background:bg||c+"1A",color:c,borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700,display:"inline-flex",alignItems:"center"}}>{children}</span>
);

const Sheet = ({onClose,children}) => (
  <div onClick={onClose} style={{position:"fixed",inset:0,background:"#00000099",zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
    <div onClick={e=>e.stopPropagation()}
      style={{background:C.card,borderRadius:"20px 20px 0 0",padding:"28px 24px 36px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto"}}>
      <div style={{width:40,height:4,borderRadius:99,background:C.border,margin:"-8px auto 20px"}}/>
      {children}
    </div>
  </div>
);

// ─────────────────────────────────────────────
//  예약 시트
// ─────────────────────────────────────────────
function BookSheet({ studio, date, s1, s2, onClose, onConfirm }) {
  const [name,  setName]  = useState("");
  const [cls,   setCls]   = useState("A반");
  const [pw,    setPw]    = useState("");
  const [err,   setErr]   = useState("");

  const endTime = add30(s2);
  const dur = (s => { const [h,m]=s.split(":").map(Number); return h*60+m; })(endTime) -
              (s => { const [h,m]=s.split(":").map(Number); return h*60+m; })(s1);

  const confirm = () => {
    if (!name.trim())        { setErr("이름을 입력해주세요"); return; }
    if (pw.length !== 4 || !/^[0-9]{4}$/.test(pw)) { setErr("비밀번호는 숫자 4자리로 입력해주세요"); return; }
    const payload = { id:uid(), date, studio_id:studio.id, start_time:s1, end_time:endTime,
      user_name:name.trim(), user_class:cls, user_pw:pw };
    onConfirm(payload);
    onClose();
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:4}}>예약하기</div>
      <div style={{fontSize:13,color:C.mid,marginBottom:18}}>
        <b style={{color:studio.color}}>{studio.name}</b> · {fmt(date)}({DAY[dow(date)]}) · <b>{s1} ~ {endTime}</b> ({dur}분)
      </div>
      {err && <div style={{background:"#FEF2F2",border:`1px solid #FECACA`,borderRadius:10,padding:"9px 14px",fontSize:12,color:C.err,marginBottom:12}}>{err}</div>}
      <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
        <div>
          <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>이름 *</label>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="홍길동" autoFocus
            onKeyDown={e=>e.key==="Enter"&&confirm()}
            style={{width:"100%",padding:"13px 14px",borderRadius:11,
              border:`1.5px solid ${err.includes("이름")&&!name.trim()?C.err:C.border}`,
              fontSize:15,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>반 *</label>
          <select value={cls} onChange={e=>setCls(e.target.value)}
            style={{width:"100%",padding:"13px 14px",borderRadius:11,border:`1.5px solid ${C.border}`,
              fontSize:15,outline:"none",background:C.card,cursor:"pointer"}}>
            {CLASSES.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>예약 비밀번호 (숫자 4자리) *</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pw} onChange={e=>setPw(e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="예약 취소 시 필요해요"
            style={{width:"100%",padding:"13px 14px",borderRadius:11,
              border:`1.5px solid ${err.includes("비밀번호")&&pw.length!==4?C.err:C.border}`,
              fontSize:15,outline:"none",boxSizing:"border-box",letterSpacing:8}}/>
          <div style={{fontSize:10,color:C.light,marginTop:5}}>⚠️ 예약 취소 시 이 비밀번호가 필요합니다. 기억해주세요!</div>
        </div>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={confirm}
          style={{flex:1,background:C.blue,color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:800,cursor:"pointer",fontSize:15}}>
          예약 확정
        </button>
        <button onClick={onClose}
          style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 18px",cursor:"pointer",color:C.mid,fontSize:13}}>
          취소
        </button>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────
//  완료 시트
// ─────────────────────────────────────────────
function DoneSheet({ booking, studio, onClose }) {
  return (
    <Sheet onClose={onClose}>
      <div style={{textAlign:"center",padding:"8px 0"}}>
        <div style={{fontSize:52,marginBottom:8}}>✅</div>
        <div style={{fontSize:20,fontWeight:900,color:C.navy,marginBottom:16}}>예약 완료!</div>
        <div style={{background:studio.bg,borderRadius:14,padding:18,marginBottom:18,textAlign:"left",lineHeight:2}}>
          <b style={{color:studio.color}}>{studio.name}</b><br/>
          📅 {fmt(booking.date)} ({DAY[dow(booking.date)]})<br/>
          🕐 {booking.start_time} ~ {booking.end_time}<br/>
          👤 {booking.user_name} ({booking.user_class})
        </div>
        <div style={{background:"#FFF8E8",borderRadius:12,padding:14,fontSize:11,color:C.mid,textAlign:"left",lineHeight:1.9,marginBottom:20}}>
          🏢 서울 송파구 석촌동 288-19 신공간빌딩 · 🔑 5555*<br/>
          🚗 차량불가 · 🍱 취식자제 · 🧹 퇴실후 정리<br/>
          💡 마지막 퇴실자: 소등 + 에어컨OFF + 문잠금
        </div>
        <button onClick={onClose}
          style={{width:"100%",background:C.navy,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:15}}>
          확인
        </button>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────
//  관리자 비밀번호 변경 시트
// ─────────────────────────────────────────────
function ChangePwSheet({ currentPw, onClose, onChanged }) {
  const [cur,  setCur]  = useState("");
  const [next, setNext] = useState("");
  const [con,  setCon]  = useState("");
  const [err,  setErr]  = useState("");
  const [done, setDone] = useState(false);

  const save = async () => {
    if (cur !== currentPw)   { setErr("현재 비밀번호가 틀렸어요"); return; }
    if (next.length < 4)     { setErr("새 비밀번호는 4자 이상이어야 해요"); return; }
    if (next !== con)        { setErr("새 비밀번호가 일치하지 않아요"); return; }
    // Supabase settings 테이블에 저장
    try {
      await fetch(`${SB}/rest/v1/settings`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: "booking_admin_pw", value: next }),
      });
    } catch {}
    try { localStorage.setItem("sj_booking_admin_pw", next); } catch {}
    onChanged(next);
    setDone(true);
    setTimeout(onClose, 1500);
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:20}}>🔑 관리자 비밀번호 변경</div>
      {done ? (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:40,marginBottom:8}}>✅</div>
          <div style={{fontSize:15,fontWeight:700,color:C.ok}}>비밀번호가 변경됐어요!</div>
        </div>
      ) : (
        <>
          {err && <div style={{background:"#FEF2F2",borderRadius:10,padding:"9px 14px",fontSize:12,color:C.err,marginBottom:12}}>{err}</div>}
          <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
            {[["현재 비밀번호",cur,setCur],["새 비밀번호",next,setNext],["새 비밀번호 확인",con,setCon]].map(([lbl,val,set])=>(
              <div key={lbl}>
                <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>{lbl}</label>
                <input type="password" value={val} onChange={e=>set(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&save()} autoFocus={lbl==="현재 비밀번호"}
                  style={{width:"100%",padding:"13px 14px",borderRadius:11,border:`1.5px solid ${C.border}`,
                    fontSize:15,outline:"none",boxSizing:"border-box"}}/>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={save}
              style={{flex:1,background:C.navy,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:14}}>
              변경하기
            </button>
            <button onClick={onClose}
              style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",color:C.mid,fontSize:13}}>
              취소
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ─────────────────────────────────────────────
//  스튜디오 이름 편집 시트
// ─────────────────────────────────────────────
function StudioEditSheet({ studios, onClose, onSave }) {
  const [names, setNames] = useState(studios.map(s=>s.name));
  const [seats, setSeats] = useState(studios.map(s=>s.seats));
  const [saving, setSaving] = useState(false);
  const [done,   setDone]   = useState(false);

  const save = async () => {
    setSaving(true);
    const payload = studios.map((s,i)=>({ id:s.id, name:names[i], seats:parseInt(seats[i])||s.seats }));
    // 1) localStorage에 즉시 저장 (새로고침해도 유지)
    try { localStorage.setItem("sj_studio_settings", JSON.stringify(payload)); } catch {}
    // 2) Supabase에 저장 (다른 기기와 동기화)
    try {
      await fetch(`${SB}/rest/v1/settings`, {
        method:"POST",
        headers:{...H,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates"},
        body:JSON.stringify({key:"studio_settings",value:JSON.stringify(payload)}),
      });
    } catch {}
    onSave(payload);
    setDone(true);
    setTimeout(onClose, 1200);
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:20}}>🏛 스튜디오 설정</div>
      {done ? (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:40,marginBottom:8}}>✅</div>
          <div style={{fontSize:15,fontWeight:700,color:C.ok}}>저장됐어요!</div>
        </div>
      ) : (
        <>
          <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
            {studios.map((s,i)=>(
              <div key={s.id} style={{background:s.bg,borderRadius:12,padding:14,border:`1.5px solid ${s.color}44`}}>
                <div style={{fontSize:11,fontWeight:700,color:s.color,marginBottom:8}}>{s.id}호 설정</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
                  <div>
                    <label style={{fontSize:11,color:C.mid,display:"block",marginBottom:4}}>스튜디오 이름</label>
                    <input value={names[i]} onChange={e=>{const n=[...names];n[i]=e.target.value;setNames(n);}}
                      style={{width:"100%",padding:"9px 12px",borderRadius:9,border:`1.5px solid ${C.border}`,
                        fontSize:14,fontWeight:700,color:s.color,outline:"none",boxSizing:"border-box"}}/>
                  </div>
                  <div style={{minWidth:56}}>
                    <label style={{fontSize:11,color:C.mid,display:"block",marginBottom:4}}>좌석수</label>
                    <input type="number" min="1" max="50" value={seats[i]}
                      onChange={e=>{const n=[...seats];n[i]=e.target.value;setSeats(n);}}
                      style={{width:"100%",padding:"9px 10px",borderRadius:9,border:`1.5px solid ${C.border}`,
                        fontSize:14,fontWeight:700,textAlign:"center",outline:"none"}}/>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={save} disabled={saving}
              style={{flex:1,background:saving?C.light:C.blue,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:14}}>
              {saving?"저장 중…":"저장하기"}
            </button>
            <button onClick={onClose}
              style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",color:C.mid,fontSize:13}}>
              취소
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ─────────────────────────────────────────────
//  잠금 시트 (관리자)
// ─────────────────────────────────────────────
function LockSheet({ date, studio, onClose, onConfirm }) {
  const [sid,setSid]     = useState(studio?.id || "B"); // 현재 보고 있던 스튜디오를 기본 선택
  const [t1,setT1]       = useState("09:00");
  const [t2,setT2]       = useState("22:00");
  const [reason,setReason] = useState("강의");
  const [err,setErr]     = useState("");

  const save = () => {
    if(t1>=t2){ setErr("종료시간이 시작보다 늦어야 해요"); return; }
    onConfirm({ id:uid(), date, studio_id:sid, start_time:t1, end_time:t2, reason });
    onClose();
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:20}}>🔒 강의 시간 잠금</div>
      {err && <div style={{background:"#FEF2F2",borderRadius:10,padding:"9px 14px",fontSize:12,color:C.err,marginBottom:12}}>{err}</div>}
      <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
        <div>
          <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>스튜디오</label>
          <select value={sid} onChange={e=>setSid(e.target.value)}
            style={{width:"100%",padding:"11px 12px",borderRadius:10,border:`1.5px solid ${C.border}`,fontSize:14,outline:"none"}}>
            <option value="ALL">전체 스튜디오</option>
            {STUDIOS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[["시작",t1,setT1],[" 종료",t2,setT2]].map(([lbl,val,set])=>(
            <div key={lbl}>
              <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>{lbl}</label>
              <select value={val} onChange={e=>set(e.target.value)}
                style={{width:"100%",padding:"11px 12px",borderRadius:10,border:`1.5px solid ${C.border}`,fontSize:14,outline:"none"}}>
                {[...SLOTS,"22:00"].map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>사유</label>
          <input value={reason} onChange={e=>setReason(e.target.value)}
            style={{width:"100%",padding:"11px 12px",borderRadius:10,border:`1.5px solid ${C.border}`,fontSize:14,outline:"none",boxSizing:"border-box"}}/>
        </div>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={save}
          style={{flex:1,background:C.err,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:14}}>
          잠금 설정
        </button>
        <button onClick={onClose}
          style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",color:C.mid,fontSize:13}}>
          취소
        </button>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────
//  타임 그리드
// ─────────────────────────────────────────────
function TimeGrid({ studio, date, res, locks, isAdmin, onBook, onAddLock, onDelRes, onDelLock }) {
  const [sel1, setSel1] = useState(null);
  const [sel2, setSel2] = useState(null);
  const [sheet, setSheet] = useState(null); // null | "book" | "lock"
  const [done,  setDone]  = useState(null); // completed booking

  const clearSel = () => { setSel1(null); setSel2(null); };

  const handleClick = useCallback((slot) => {
    const locked = slotLock(locks, studio.id, date, slot);
    const cnt    = slotBooked(res, studio.id, slot);
    if (locked && !isAdmin) return;
    if (cnt >= studio.seats && !isAdmin) return;

    if (!sel1)         { setSel1(slot); setSel2(slot); }
    else if (slot < sel1) { setSel1(slot); setSel2(slot); }
    else                { setSel2(slot); }
  }, [sel1, locks, res, studio, date, isAdmin]);

  const inRange = s => sel1 && sel2 && s >= sel1 && s <= sel2;

  return (
    <div>
      {/* 선택 표시 바 */}
      {sel1 && (
        <div style={{background:studio.bg,border:`1.5px solid ${studio.color}44`,borderRadius:12,padding:"11px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:700,color:studio.color}}>{sel1} ~ {add30(sel2)} 선택</span>
          <button onClick={()=>setSheet("book")}
            style={{background:studio.color,color:"#fff",border:"none",borderRadius:9,padding:"7px 18px",fontWeight:800,cursor:"pointer",fontSize:13}}>
            예약하기
          </button>
          <button onClick={clearSel}
            style={{background:"none",border:`1px solid ${studio.color}66`,borderRadius:9,padding:"7px 12px",cursor:"pointer",color:studio.color,fontSize:12}}>
            취소
          </button>
        </div>
      )}

      {!sel1 && (
        <div style={{fontSize:11,color:C.light,marginBottom:10,padding:"4px 0"}}>
          ☝️ 원하는 시간 슬롯을 터치해 선택하세요
        </div>
      )}

      {isAdmin && (
        <button onClick={()=>setSheet("lock")}
          style={{width:"100%",background:"#FEF2F2",border:`1px solid ${C.err}44`,borderRadius:10,padding:"9px",color:C.err,fontWeight:700,cursor:"pointer",fontSize:12,marginBottom:12}}>
          🔒 강의 잠금 추가
        </button>
      )}

      {/* 슬롯 목록 */}
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {SLOTS.map(slot => {
          const lockReason = slotLock(locks, studio.id, date, slot);
          const cnt  = slotBooked(res, studio.id, slot);
          const ss   = slotStyle(cnt, studio.seats, lockReason);
          const sel  = inRange(slot);
          const slotRes   = isAdmin ? res.filter(r=>r.studio_id===studio.id&&r.start_time<=slot&&r.end_time>slot) : [];
          const slotLocks = isAdmin ? locks.filter(l=>(l.studio_id===studio.id||l.studio_id==="ALL")&&l.start_time<=slot&&l.end_time>slot) : [];

          return (
            <div key={slot}>
              <div onClick={()=>handleClick(slot)} style={{
                display:"flex",alignItems:"center",gap:8,padding:"9px 12px",borderRadius:9,
                background: sel ? studio.color : ss.bg,
                border: `1.5px solid ${sel ? studio.color : lockReason ? "#E2E8F0" : ss.tc+"44"}`,
                cursor: (lockReason && !isAdmin) ? "not-allowed" : "pointer",
                transition:"all .1s",
                userSelect:"none",
              }}>
                <span style={{fontSize:12,fontWeight:600,color:sel?"#fff9":C.light,width:40,flexShrink:0}}>{slot}</span>
                <div style={{flex:1,height:5,background:sel?"#fff4":C.border,borderRadius:99,overflow:"hidden"}}>
                  <div style={{height:"100%",
                    width: lockReason ? "100%" : `${Math.min((cnt/studio.seats)*100,100)}%`,
                    background: sel?"#fff":lockReason?"#C8D0E0":ss.tc,
                    borderRadius:99,transition:"width .3s"}}/>
                </div>
                <span style={{fontSize:11,fontWeight:700,color:sel?"#fff":ss.tc,width:32,textAlign:"right",flexShrink:0}}>
                  {ss.label}
                </span>
              </div>

              {/* 관리자: 예약자 */}
              {isAdmin && slotRes.length>0 && (
                <div style={{paddingLeft:52,display:"flex",gap:4,flexWrap:"wrap",marginTop:2,marginBottom:2}}>
                  {slotRes.filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i).map(r=>(
                    <span key={r.id} style={{display:"inline-flex",alignItems:"center",gap:4,background:studio.bg,borderRadius:6,padding:"2px 8px",fontSize:11,color:studio.color}}>
                      {r.user_name}({r.user_class})
                      <button onClick={e=>{e.stopPropagation();onDelRes(r.id);}}
                        style={{background:"none",border:"none",cursor:"pointer",color:C.err,fontSize:14,padding:0,lineHeight:1,marginLeft:2}}>×</button>
                    </span>
                  ))}
                </div>
              )}

              {/* 관리자: 수동 잠금 */}
              {isAdmin && slotLocks.length>0 && !fixedLock(studio.id,date,slot) && (
                <div style={{paddingLeft:52,display:"flex",gap:4,flexWrap:"wrap",marginTop:2,marginBottom:2}}>
                  {slotLocks.filter((l,i,a)=>a.findIndex(x=>x.id===l.id)===i).map(l=>(
                    <span key={l.id} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#FEE2E2",borderRadius:6,padding:"2px 8px",fontSize:11,color:C.err}}>
                      🔒{l.reason}
                      <button onClick={e=>{e.stopPropagation();onDelLock(l.id);}}
                        style={{background:"none",border:"none",cursor:"pointer",color:C.err,fontSize:14,padding:0,lineHeight:1,marginLeft:2}}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 시트 모달들 */}
      {sheet==="book" && sel1 && sel2 && (
        <BookSheet studio={studio} date={date} s1={sel1} s2={sel2}
          onClose={()=>{setSheet(null);clearSel();}}
          onConfirm={p=>{ onBook(p); setDone(p); setSheet(null); clearSel(); }}/>
      )}
      {sheet==="lock" && (
        <LockSheet date={date} studio={studio}
          onClose={()=>setSheet(null)}
          onConfirm={p=>{ onAddLock(p); setSheet(null); }}/>
      )}
      {done && (
        <DoneSheet booking={done} studio={studio}
          onClose={()=>setDone(null)}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  일괄 취소 확인 시트
// ─────────────────────────────────────────────
function BulkCancelSheet({ bookings, studioSettings, onClose, onConfirm }) {
  const [pws,  setPws]  = useState({}); // {id: pw}
  const [errs, setErrs] = useState({});
  const [done, setDone] = useState(false);

  const tryAll = () => {
    const newErrs = {};
    const toCancel = [];
    bookings.forEach(b => {
      const pw = pws[b.id] || "";
      if (pw === b.user_pw) toCancel.push(b.id);
      else newErrs[b.id] = "❌ 틀림";
    });
    if (Object.keys(newErrs).length > 0) { setErrs(newErrs); return; }
    onConfirm(toCancel);
    setDone(true);
    setTimeout(onClose, 1200);
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:4}}>일괄 취소</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:16}}>{bookings.length}건 예약을 취소해요. 각 예약의 비밀번호를 입력하세요.</div>
      {done ? (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:40,marginBottom:8}}>✅</div>
          <div style={{fontSize:15,fontWeight:700,color:C.ok}}>취소 완료!</div>
        </div>
      ) : (
        <>
          <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20,maxHeight:320,overflowY:"auto"}}>
            {bookings.map(b=>{
              const st=studioSettings.find(s=>s.id===b.studio_id)||studioSettings[0];
              return (
                <div key={b.id} style={{background:st.bg,borderRadius:11,padding:12,border:`1px solid ${st.color}33`}}>
                  <div style={{fontSize:12,fontWeight:700,color:st.color,marginBottom:6}}>
                    {st.name} · {fmt(b.date)}({DAY[dow(b.date)]}) {b.start_time}~{b.end_time}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input type="password" inputMode="numeric" maxLength={4}
                      value={pws[b.id]||""}
                      onChange={e=>{setPws(p=>({...p,[b.id]:e.target.value.replace(/\D/g,"").slice(0,4)}));setErrs(p=>({...p,[b.id]:""}));}}
                      placeholder="비밀번호 4자리"
                      style={{flex:1,padding:"9px 12px",borderRadius:9,
                        border:`1.5px solid ${errs[b.id]?C.err:C.border}`,
                        fontSize:14,outline:"none",letterSpacing:6}}/>
                    {errs[b.id]&&<span style={{fontSize:11,color:C.err}}>{errs[b.id]}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={tryAll}
              style={{flex:1,background:C.err,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:14}}>
              {bookings.length}건 모두 취소
            </button>
            <button onClick={onClose}
              style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",color:C.mid,fontSize:13}}>
              돌아가기
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function CancelSheet({ booking, studio, onClose, onConfirm }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const tryCancel = () => {
    if (pw === booking.user_pw) { onConfirm(booking.id); onClose(); }
    else { setErr("비밀번호가 틀렸어요"); setPw(""); }
  };
  return (
    <Sheet onClose={onClose}>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:4}}>예약 취소</div>
      <div style={{background:studio.bg,borderRadius:12,padding:14,marginBottom:18,fontSize:13,color:C.mid,lineHeight:1.9}}>
        <b style={{color:studio.color}}>{studio.name}</b><br/>
        {fmt(booking.date)} ({DAY[dow(booking.date)]}) &nbsp; <b>{booking.start_time} ~ {booking.end_time}</b><br/>
        {booking.user_name} ({booking.user_class})
      </div>
      {err && <div style={{background:"#FEF2F2",borderRadius:10,padding:"9px 14px",fontSize:12,color:C.err,marginBottom:12}}>{err}</div>}
      <div style={{marginBottom:20}}>
        <label style={{fontSize:12,fontWeight:700,color:C.mid,display:"block",marginBottom:5}}>예약 비밀번호 (4자리)</label>
        <input type="password" inputMode="numeric" maxLength={4} value={pw}
          onChange={e=>setPw(e.target.value.replace(/\D/g,"").slice(0,4))}
          onKeyDown={e=>e.key==="Enter"&&tryCancel()}
          placeholder="예약 시 입력한 비밀번호" autoFocus
          style={{width:"100%",padding:"13px 14px",borderRadius:11,
            border:`1.5px solid ${err?C.err:C.border}`,fontSize:16,
            outline:"none",boxSizing:"border-box",letterSpacing:8}}/>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={tryCancel}
          style={{flex:1,background:C.err,color:"#fff",border:"none",borderRadius:12,padding:13,fontWeight:800,cursor:"pointer",fontSize:15}}>
          예약 취소 확인
        </button>
        <button onClick={onClose}
          style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:12,padding:"13px 16px",cursor:"pointer",color:C.mid,fontSize:13}}>
          돌아가기
        </button>
      </div>
    </Sheet>
  );
}

function MyTab({ allRes, onCancel, studioSettings }) {
  const [name,       setName]       = useState("");
  const [searched,   setSearched]   = useState(false);
  const [selected,   setSelected]   = useState(new Set());
  const [cancelTarget, setCancelTarget] = useState(null);
  const [bulkCancel,   setBulkCancel]   = useState(false);

  const todayStr = today();
  const myList = useMemo(()=>{
    if (!searched || !name.trim()) return [];
    return allRes.filter(r=>r.user_name===name.trim()&&r.date>=todayStr)
                 .sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:a.start_time.localeCompare(b.start_time));
  }, [allRes, name, searched, todayStr]);

  const search  = () => { if(name.trim()){ setSearched(true); setSelected(new Set()); } };
  const toggleSel = id => setSelected(prev=>{ const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const toggleAll = () => setSelected(prev => prev.size===myList.length&&myList.length>0 ? new Set() : new Set(myList.map(r=>r.id)));
  const selList = myList.filter(r=>selected.has(r.id));

  return (
    <div>
      <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:4}}>내 예약 조회</div>
      <div style={{fontSize:12,color:C.mid,marginBottom:18}}>이름으로 예약 내역을 확인하고 취소할 수 있어요</div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input value={name} onChange={e=>{setName(e.target.value);setSearched(false);setSelected(new Set());}}
          onKeyDown={e=>e.key==="Enter"&&search()}
          placeholder="예약자 이름 입력"
          style={{flex:1,padding:"12px 14px",borderRadius:10,border:`1.5px solid ${C.border}`,fontSize:15,outline:"none"}}/>
        <button onClick={search}
          style={{background:C.blue,color:"#fff",border:"none",borderRadius:10,padding:"12px 20px",fontWeight:700,cursor:"pointer",fontSize:14}}>
          조회
        </button>
      </div>

      {searched && (
        myList.length===0 ? (
          <div style={{textAlign:"center",padding:"40px 0",color:C.light}}>
            <div style={{fontSize:36,marginBottom:8}}>📭</div>
            <div style={{fontSize:14}}>"{name}" 이름으로 예약된 내역이 없어요</div>
          </div>
        ) : (
          <>
            {/* 전체선택 + 일괄취소 바 */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"10px 14px",
              background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
              <input type="checkbox"
                checked={selected.size===myList.length&&myList.length>0}
                onChange={toggleAll}
                style={{width:16,height:16,cursor:"pointer",accentColor:C.blue}}/>
              <span style={{fontSize:13,color:C.mid,flex:1}}>전체 선택 ({myList.length}건)</span>
              {selected.size>0&&(
                <button onClick={()=>setBulkCancel(true)}
                  style={{background:C.err,color:"#fff",border:"none",borderRadius:8,
                    padding:"7px 14px",fontWeight:700,cursor:"pointer",fontSize:12}}>
                  선택 {selected.size}건 취소
                </button>
              )}
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {myList.map(r=>{
                const st=studioSettings.find(s=>s.id===r.studio_id)||studioSettings[0];
                const isSel=selected.has(r.id);
                return (
                  <div key={r.id}
                    style={{background:isSel?st.color+"18":st.bg,borderRadius:13,padding:14,
                      border:`1.5px solid ${isSel?st.color:st.color+"33"}`,
                      display:"flex",alignItems:"center",gap:12,transition:"all .1s",cursor:"pointer"}}
                    onClick={()=>toggleSel(r.id)}>
                    <input type="checkbox" checked={isSel} onChange={()=>toggleSel(r.id)}
                      onClick={e=>e.stopPropagation()}
                      style={{width:16,height:16,cursor:"pointer",accentColor:st.color,flexShrink:0}}/>
                    <div style={{flex:1}} onClick={e=>e.stopPropagation()}>
                      <div style={{fontWeight:800,fontSize:14,color:st.color}}>{st.name}</div>
                      <div style={{fontSize:13,color:C.mid,marginTop:2}}>
                        {fmt(r.date)} ({DAY[dow(r.date)]}) · <b>{r.start_time} ~ {r.end_time}</b>
                      </div>
                      <div style={{fontSize:11,color:C.light,marginTop:2}}>{r.user_class}</div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();setCancelTarget(r);}}
                      style={{background:"#FEE2E2",color:C.err,border:"none",borderRadius:8,
                        padding:"7px 10px",cursor:"pointer",fontWeight:700,fontSize:11,flexShrink:0}}>
                      취소
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )
      )}

      {cancelTarget && (
        <CancelSheet
          booking={cancelTarget}
          studio={studioSettings.find(s=>s.id===cancelTarget.studio_id)||studioSettings[0]}
          onClose={()=>setCancelTarget(null)}
          onConfirm={id=>{ onCancel(id); setCancelTarget(null); setSearched(false); setSelected(new Set()); }}
        />
      )}
      {bulkCancel && selList.length>0 && (
        <BulkCancelSheet
          bookings={selList}
          studioSettings={studioSettings}
          onClose={()=>setBulkCancel(false)}
          onConfirm={ids=>{ ids.forEach(id=>onCancel(id)); setBulkCancel(false); setSelected(new Set()); }}
        />
      )}
    </div>
  );
}


// ─────────────────────────────────────────────
//  메인 앱
// ─────────────────────────────────────────────
export default function App() {
  // ── 핵심 상태 (단일 진실 소스) ───────────────
  const [res,   setRes]   = useState([]);   // 전체 예약 배열
  const [locks, setLocks] = useState([]);   // 전체 잠금 배열

  // ── UI 상태 ───────────────────────────────
  const [tab,   setTab]   = useState("book");
  const [admin, setAdmin] = useState(false);
  const [pw,       setPw]     = useState("");
  const [pwErr,    setPwErr]  = useState(false);
  const [adminPw,  setAdminPw] = useState(DEFAULT_ADMIN_PW);
  const [showChgPw,    setShowChgPw]     = useState(false);
  const [showStudioEdit,setShowStudioEdit] = useState(false);
  const [studioSettings,setStudioSettings] = useState(STUDIOS); // 커스텀 이름/좌석
  const [date,  setDate]  = useState(today());
  const [sid,   setSid]   = useState("B");
  const [loading,setLoading] = useState(false);
  const [online, setOnline]  = useState(false); // Supabase 연결 여부

  // 마지막으로 받아온 studio_settings 원본 문자열 (불필요한 리렌더 방지용)
  const lastStudioRaw = useRef(null);

  // 스튜디오 설정 로드 + 주기적 동기화
  // (관리자가 이름/좌석을 바꾸면, 이미 켜져 있는 다른 사람 화면에도 자동 반영되도록
  //  일정 주기로 Supabase 최신값을 다시 확인합니다)
  useEffect(()=>{
    const applySettings = (saved) => {
      if (!saved?.length) return;
      setStudioSettings(STUDIOS.map(s=>{
        const found = saved.find(x=>x.id===s.id);
        return found ? {...s, name:found.name, seats:Number(found.seats)||s.seats} : s;
      }));
    };

    const fetchLatest = async () => {
      try {
        const r = await fetch(`${SB}/rest/v1/settings?key=eq.studio_settings&select=value`, { headers: H });
        if (r.ok) {
          const d = await r.json();
          if (d?.length && d[0].value && d[0].value !== lastStudioRaw.current) {
            lastStudioRaw.current = d[0].value;
            const saved = JSON.parse(d[0].value);
            applySettings(saved);
            localStorage.setItem("sj_studio_settings", JSON.stringify(saved));
          }
        }
      } catch {}
    };

    // 1) localStorage 먼저 (빠름)
    try {
      const local = localStorage.getItem("sj_studio_settings");
      if (local) { applySettings(JSON.parse(local)); lastStudioRaw.current = local; }
    } catch {}

    // 2) Supabase에서 최신값 로드
    fetchLatest();

    // 3) 5초마다 최신값 재확인 (다른 사람이 바꾼 내용을 실시간에 가깝게 반영)
    const poll = setInterval(fetchLatest, 5000);

    // 4) 앱으로 다시 돌아왔을 때(탭 전환 복귀 등) 즉시 재확인
    const onFocus = () => fetchLatest();
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(poll);
      window.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  },[]);

  // 관리자 비밀번호 로드: localStorage → Supabase
  useEffect(()=>{
    try {
      const local = localStorage.getItem("sj_booking_admin_pw");
      if (local) setAdminPw(local);
    } catch {}
    (async()=>{
      try {
        const r = await fetch(`${SB}/rest/v1/settings?key=eq.booking_admin_pw&select=value`, { headers: H });
        if (r.ok) {
          const d = await r.json();
          if (d?.length && d[0].value) {
            setAdminPw(d[0].value);
            localStorage.setItem("sj_booking_admin_pw", d[0].value);
          }
        }
      } catch {}
    })();
  },[]);

  // 일반 사용자: 오늘+3일 / 관리자: 오늘+14일
  const week = useMemo(()=> admin ? getAdminDates() : getDates(), [admin]);
  const studio  = studioSettings.find(s=>s.id===sid)||studioSettings[1];

  // ── Supabase에서 해당 날짜 데이터 로드 ──────
  const loadDate = useCallback(async (d) => {
    setLoading(true);
    const [rData, lData] = await Promise.all([
      sbFetch(`studio_reservations?date=eq.${d}&order=start_time.asc`),
      sbFetch(`studio_locks?date=eq.${d}`),
    ]);
    if (rData !== null) {
      // Supabase 성공: 해당 날짜 데이터 교체
      setRes(prev => [...prev.filter(r=>r.date!==d), ...rData]);
      setLocks(prev => [...prev.filter(l=>l.date!==d), ...(lData||[])]);
      setOnline(true);
    }
    setLoading(false);
  }, []);

  useEffect(()=>{ loadDate(date); }, [date]);

  // 백그라운드 저장 실패 시 화면에 보여줄 경고 메시지
  const [syncError, setSyncError] = useState("");
  const flagIfFailed = useCallback((ok, label) => {
    if (!ok) setSyncError(`⚠️ ${label} 서버 저장에 실패했어요. 새로고침하면 사라질 수 있어요. (네트워크 또는 권한 문제)`);
  }, []);

  // ── 예약 추가 (즉시 state 반영 + 백그라운드 저장) ─
  const onBook = useCallback(payload => {
    setRes(prev => [...prev, payload]);        // 즉시 UI 반영
    sbInsert("studio_reservations", payload).then(ok=>flagIfFailed(ok,"예약"));  // 백그라운드 저장
  }, [flagIfFailed]);

  // ── 예약 취소 ─────────────────────────────
  const onCancel = useCallback(id => {
    setRes(prev => prev.filter(r=>r.id!==id));
    sbDelete("studio_reservations", `id=eq.${id}`).then(ok=>flagIfFailed(ok,"예약 취소"));
  }, [flagIfFailed]);

  // ── 잠금 추가 ─────────────────────────────
  const onAddLock = useCallback(payload => {
    setLocks(prev => [...prev, payload]);
    sbInsert("studio_locks", payload).then(ok=>flagIfFailed(ok,"잠금"));
  }, [flagIfFailed]);

  // ── 잠금 해제 ─────────────────────────────
  const onDelLock = useCallback(id => {
    setLocks(prev => prev.filter(l=>l.id!==id));
    sbDelete("studio_locks", `id=eq.${id}`).then(ok=>flagIfFailed(ok,"잠금 해제"));
  }, [flagIfFailed]);

  // ── 날짜별 res/locks 필터 ─────────────────
  const dateRes   = useMemo(()=>res.filter(r=>r.date===date),   [res,   date]);
  const dateLocks = useMemo(()=>locks.filter(l=>l.date===date), [locks, date]);

  // ── 스튜디오 카드 상태 ─────────────────────
  const studioStat = s => {
    const stInfo = studioSettings.find(x=>x.id===s.id)||s;
    const allLocked = SLOTS.every(slot=>slotLock(dateLocks,s.id,date,slot));
    if(allLocked) return "locked";
    const minRem = SLOTS.reduce((mn,slot)=>{
      if(slotLock(dateLocks,s.id,date,slot)) return mn;
      return Math.min(mn, s.seats-slotBooked(dateRes,s.id,slot));
    }, s.seats);
    return minRem<=0?"full":minRem<=2?"low":"ok";
  };

  const loginAdmin = () => {
    if(pw===adminPw){ setAdmin(true); setPwErr(false); setPw(""); }
    else setPwErr(true);
  };

  return (
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"'Noto Sans KR',sans-serif",maxWidth:520,margin:"0 auto"}}>

      {/* 저장 실패 경고 배너 */}
      {syncError && (
        <div style={{position:"sticky",top:0,zIndex:200,background:C.err,color:"#fff",padding:"9px 14px",
          fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:10}}>
          <span style={{flex:1}}>{syncError}</span>
          <button onClick={()=>setSyncError("")}
            style={{background:"#ffffff33",border:"none",borderRadius:6,color:"#fff",padding:"4px 9px",cursor:"pointer",fontSize:11}}>
            닫기
          </button>
        </div>
      )}

      {/* 헤더 */}
      <header style={{background:C.navy,padding:"12px 16px",position:"sticky",top:0,zIndex:100,borderBottom:`2px solid ${C.accent}44`}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:30,height:30,borderRadius:8,background:C.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>🏛</div>
          <div style={{flex:1}}>
            <div style={{color:"#fff",fontWeight:900,fontSize:15,lineHeight:1.1}}>신전스퀘어</div>
            <div style={{color:C.accent,fontSize:8,letterSpacing:1.5}}>STUDIO RESERVATION</div>
          </div>
          {online && <Tag c={C.ok}>DB 연결됨</Tag>}
          {admin  && <Tag c={C.accent}>관리자</Tag>}
          {admin  && <button onClick={()=>setAdmin(false)}
            style={{background:"transparent",border:`1px solid #344060`,borderRadius:7,color:"#a0b0cc",padding:"4px 9px",cursor:"pointer",fontSize:11}}>
            로그아웃
          </button>}
        </div>
      </header>

      {/* 탭 */}
      <div style={{background:C.card,borderBottom:`1px solid ${C.border}`,position:"sticky",top:54,zIndex:99}}>
        <div style={{display:"flex"}}>
          {[["book","📅 예약"],["mine","🗒 내 예약"],["admin",admin?"⚙️ 관리":"🔒 관리"]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} style={{
              flex:1,padding:"13px 4px",border:"none",background:"none",cursor:"pointer",
              fontWeight:tab===k?800:400,fontSize:13,
              color:tab===k?C.blue:C.light,
              borderBottom:`2.5px solid ${tab===k?C.blue:"transparent"}`,transition:"all .15s"}}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <main style={{padding:"16px 14px"}}>

        {/* ─── 예약 탭 ─── */}
        {tab==="book" && (<>

          {/* 날짜 선택 */}
          <div style={{marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,color:C.mid,marginBottom:8,letterSpacing:.5}}>날짜{admin&&" (관리자: 2주치 표시)"}</div>
            <div style={{display:"flex",gap:7,overflowX:"auto",paddingBottom:4}}>
              {week.map(d=>{
                const open = admin ? true : isOpen(d); // 관리자는 오픈 제한 없이 전부 선택 가능
                const isToday=d===today(), sel=d===date;
                return (
                  <button key={d} onClick={()=>open&&setDate(d)} disabled={!open} style={{
                    flexShrink:0,padding:"9px 12px",borderRadius:11,textAlign:"center",
                    border:`2px solid ${sel?C.blue:open?C.border:"#E8ECF4"}`,
                    background:sel?C.blue:open?C.card:"#F6F8FC",
                    cursor:open?"pointer":"not-allowed",minWidth:52}}>
                    <div style={{fontSize:10,color:sel?"#fff":isToday?C.blue:C.light,fontWeight:700}}>{isToday?"오늘":DAY[dow(d)]}</div>
                    <div style={{fontSize:18,fontWeight:900,color:sel?"#fff":open?C.tx:"#C0CAD8",marginTop:1}}>{parseInt(d.split("-")[2])}</div>
                    {!open&&<div style={{fontSize:8,color:C.light}}>미오픈</div>}
                  </button>
                );
              })}
            </div>
            <div style={{fontSize:10,color:C.light,marginTop:6}}>💡 매일 오전 9시에 3일치 예약 오픈{admin&&" · 관리자는 2주 뒤까지 관리 가능"}</div>
          </div>

          {/* 스튜디오 카드 */}
          <div style={{marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,color:C.mid,marginBottom:8,letterSpacing:.5}}>스튜디오 선택</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
              {studioSettings.map(s=>{
                const st=studioStat(s), sel=s.id===sid;
                const stC=st==="locked"?"#B0BAD0":st==="full"?C.err:st==="low"?C.warn:C.ok;
                const booked_pct = SLOTS.reduce((mx,slot)=>Math.max(mx,slotBooked(dateRes,s.id,slot)/s.seats),0);
                return (
                  <button key={s.id} onClick={()=>setSid(s.id)} style={{
                    background:sel?s.color:s.bg,borderRadius:13,padding:"13px 14px",
                    border:`2px solid ${sel?s.color:s.color+"33"}`,cursor:"pointer",textAlign:"left"}}>
                    <div style={{fontWeight:900,fontSize:14,color:sel?"#fff":s.color}}>{s.name}</div>
                    <div style={{fontSize:10,color:sel?"#fff8":C.light,marginTop:2}}>{s.seats}석</div>
                    <div style={{marginTop:8,background:sel?"#fff4":C.border,borderRadius:99,height:4}}>
                      <div style={{width:st==="locked"?"100%":`${booked_pct*100}%`,
                        height:"100%",background:sel?"#fff":stC,borderRadius:99}}/>
                    </div>
                    <div style={{marginTop:4,fontSize:10,fontWeight:700,color:sel?"#fff":stC}}>
                      {st==="locked"?"🔒 이용불가":st==="full"?"마감":st==="low"?"잔여 적음":"이용 가능"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 타임 그리드 */}
          <div style={{background:C.card,borderRadius:16,padding:16,border:`1px solid ${C.border}`}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <div style={{width:9,height:9,borderRadius:"50%",background:studio.color,flexShrink:0}}/>
              <b style={{fontSize:14,color:C.tx}}>{studio.name}</b>
              <span style={{fontSize:11,color:C.light}}>{studio.seats}석</span>
              {loading && <span style={{fontSize:10,color:C.light,marginLeft:"auto"}}>로딩 중…</span>}
              <button onClick={()=>loadDate(date)} style={{marginLeft:"auto",background:"none",border:`1px solid ${C.border}`,borderRadius:7,padding:"3px 9px",cursor:"pointer",fontSize:10,color:C.mid}}>새로고침</button>
            </div>
            <div style={{display:"flex",gap:12,marginBottom:12,flexWrap:"wrap"}}>
              {[["#ECFDF5",C.ok,"여유"],["#FEF3C7",C.warn,"잔여 적음"],["#FEE2E2",C.err,"마감"],["#F1F3F9","#A8B4CC","강의/잠금"]].map(([bg,c,l])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                  <div style={{width:8,height:8,borderRadius:2,background:bg,border:`1px solid ${c}44`}}/>
                  <span style={{fontSize:10,color:C.light}}>{l}</span>
                </div>
              ))}
            </div>
            <TimeGrid
              studio={studio} date={date}
              res={dateRes} locks={dateLocks}
              isAdmin={admin}
              onBook={onBook}
              onAddLock={onAddLock}
              onDelRes={onCancel}
              onDelLock={onDelLock}
            />
          </div>

          {/* 공지 */}
          <div style={{background:"#FFF8E8",borderRadius:13,padding:14,border:`1px solid ${C.accent}44`,marginTop:14}}>
            <div style={{fontSize:12,fontWeight:800,color:C.navy,marginBottom:6}}>📋 이용 안내</div>
            <div style={{fontSize:11,color:C.mid,lineHeight:2}}>
              🏢 서울시 송파구 석촌동 288-19 신공간빌딩 · 🔑 5555*<br/>
              🚗 차량불가 · 🍱 취식자제 · 🧹 이용 후 자리 정리<br/>
              ⚠️ 노쇼 3회 시 패널티<br/>
              💡 마지막 퇴실자: 소등 + 에어컨OFF + 문잠금
            </div>
          </div>
        </>)}

        {/* ─── 내 예약 탭 ─── */}
        {tab==="mine" && <MyTab allRes={res} onCancel={onCancel} studioSettings={studioSettings}/>}

        {showStudioEdit && (
        <StudioEditSheet
          studios={studioSettings}
          onClose={()=>setShowStudioEdit(false)}
          onSave={updated=>{
            setStudioSettings(STUDIOS.map(s=>{
              const u=updated.find(x=>x.id===s.id);
              return u?{...s,name:u.name,seats:u.seats}:s;
            }));
            lastStudioRaw.current = JSON.stringify(updated); // 내 저장 직후엔 폴링이 곧바로 덮어쓰지 않도록 기준값 갱신
          }}
        />
      )}
      {showChgPw && (
        <ChangePwSheet currentPw={adminPw} onClose={()=>setShowChgPw(false)} onChanged={pw=>setAdminPw(pw)}/>
      )}
      {/* ─── 관리자 탭 ─── */}
        {tab==="admin" && (admin ? (
          <div>
            <div style={{fontSize:17,fontWeight:900,color:C.navy,marginBottom:12}}>관리자 모드</div>

            {/* 관리자 버튼 모음 */}
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:20}}>
              <button onClick={()=>setShowStudioEdit(true)}
                style={{background:C.navy,color:"#fff",border:"none",borderRadius:9,padding:"9px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>
                🏛 스튜디오 설정
              </button>
              <button onClick={()=>setShowChgPw(true)}
                style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:9,padding:"9px 14px",cursor:"pointer",fontSize:12,color:C.mid,fontWeight:600}}>
                🔑 비밀번호 변경
              </button>
            </div>

            {/* 잠금 추가 */}
            <div style={{background:"#FEF2F2",borderRadius:13,padding:16,marginBottom:20,border:`1px solid ${C.err}22`}}>
              <div style={{fontSize:13,fontWeight:800,color:C.err,marginBottom:12}}>🔒 강의 잠금 관리</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
                {studioSettings.map(s=>(
                  <button key={s.id} onClick={()=>{setSid(s.id);setTab("book");}}
                    style={{background:s.bg,border:`1.5px solid ${s.color}44`,borderRadius:8,padding:"7px 14px",
                      cursor:"pointer",fontSize:12,fontWeight:700,color:s.color}}>
                    {s.name} 잠금 추가 →
                  </button>
                ))}
              </div>
              <div style={{fontSize:11,color:C.light}}>
                💡 스튜디오 버튼 클릭 → 예약 탭으로 이동 → "🔒 강의 잠금 추가" 버튼 사용 (2주 뒤까지 날짜 선택 가능)
              </div>
            </div>

            <div style={{fontSize:12,color:C.mid,marginBottom:16}}>날짜별 예약 현황 (오늘부터 2주치)</div>

            {/* 날짜 선택 */}
            <div style={{display:"flex",gap:7,overflowX:"auto",marginBottom:18,paddingBottom:4}}>
              {getAdminDates().map(d=>(
                <button key={d} onClick={()=>setDate(d)} style={{
                  flexShrink:0,padding:"8px 13px",borderRadius:9,
                  border:`2px solid ${d===date?C.blue:C.border}`,
                  background:d===date?C.blue:C.card,cursor:"pointer",
                  color:d===date?"#fff":C.mid,fontWeight:700,fontSize:12}}>
                  {fmt(d)} ({DAY[dow(d)]})
                </button>
              ))}
            </div>

            {/* 스튜디오별 현황 */}
            {studioSettings.map(s=>{
              const sRes   = dateRes.filter(r=>r.studio_id===s.id);
              const sLocks = dateLocks.filter(l=>l.studio_id===s.id||l.studio_id==="ALL");
              const fixCount = SLOTS.filter(slot=>fixedLock(s.id,date,slot)).length;
              return (
                <div key={s.id} style={{background:C.card,borderRadius:14,padding:16,marginBottom:12,border:`1.5px solid ${s.color}33`}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <div style={{width:9,height:9,borderRadius:"50%",background:s.color}}/>
                    <b style={{color:s.color,fontSize:13}}>{s.name}</b>
                    {sRes.length>0   && <Tag c={s.color}>{sRes.length}건 예약</Tag>}
                    {sLocks.length>0 && <Tag c={C.err}>수동 {sLocks.length}건 잠금</Tag>}
                    {fixCount===SLOTS.length && <Tag c="#B0BAD0">🔒 전일 잠금</Tag>}
                  </div>
                  {sRes.length===0 && sLocks.length===0 && fixCount<SLOTS.length && (
                    <div style={{fontSize:12,color:C.light}}>예약 없음</div>
                  )}
                  {sRes.map(r=>(
                    <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,background:s.bg,borderRadius:8,padding:"8px 12px",marginBottom:5}}>
                      <span style={{fontSize:11,fontWeight:700,color:s.color,width:88}}>{r.start_time}~{r.end_time}</span>
                      <span style={{flex:1,fontSize:13,color:C.tx,fontWeight:600}}>{r.user_name} <span style={{fontSize:11,color:C.light}}>({r.user_class})</span></span>
                      <button onClick={()=>onCancel(r.id)}
                        style={{background:"#FEE2E2",color:C.err,border:"none",borderRadius:7,padding:"5px 10px",cursor:"pointer",fontWeight:700,fontSize:11}}>취소</button>
                    </div>
                  ))}
                  {sLocks.map(l=>(
                    <div key={l.id} style={{display:"flex",alignItems:"center",gap:10,background:"#FEE2E2",borderRadius:8,padding:"8px 12px",marginBottom:5}}>
                      <span style={{fontSize:11,fontWeight:700,color:C.err,width:88}}>{l.start_time}~{l.end_time}</span>
                      <span style={{flex:1,fontSize:12,color:C.err}}>🔒 {l.reason}</span>
                      <button onClick={()=>onDelLock(l.id)}
                        style={{background:C.err,color:"#fff",border:"none",borderRadius:7,padding:"5px 10px",cursor:"pointer",fontWeight:700,fontSize:11}}>해제</button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{maxWidth:360,margin:"0 auto",paddingTop:20}}>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{fontSize:44,marginBottom:10}}>🔒</div>
              <div style={{fontSize:18,fontWeight:900,color:C.navy}}>관리자 로그인</div>
            </div>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loginAdmin()}
              placeholder="비밀번호" autoFocus
              style={{width:"100%",padding:"13px 16px",borderRadius:12,
                border:`2px solid ${pwErr?C.err:C.border}`,fontSize:15,outline:"none",
                boxSizing:"border-box",marginBottom:8,background:pwErr?"#FEF2F2":"#fff"}}/>
            {pwErr && <div style={{fontSize:12,color:C.err,marginBottom:10}}>❌ 틀렸습니다</div>}
            <button onClick={loginAdmin}
              style={{width:"100%",background:C.navy,color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:800,cursor:"pointer",fontSize:15}}>
              로그인
            </button>
          </div>
        ))}

      </main>
    </div>
  );
}
