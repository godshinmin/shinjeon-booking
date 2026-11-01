-- ═══════════════════════════════════════════════════════════════
-- 신전스퀘어 자습실 · 서버 보안 1단계 (추가만 합니다. 기존 데이터는 지우지 않아요)
-- 하는 일: 암호화 도구 켜기 → 비밀 저장소 만들기 → 서버 함수 만들기
-- 이 단계만으로는 기존 앱이 그대로 동작합니다.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;
create schema if not exists sj_private;
revoke all on schema sj_private from public, anon, authenticated;

-- 표 모양 정리 (글자 형식으로 통일, 비밀번호 암호화 칸 추가)
do $$
declare r record;
begin
  for r in
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and table_name in ('studio_reservations', 'studio_locks', 'settings')
      and column_name in ('id','date','studio_id','start_time','end_time','user_name','user_class','user_pw','reason','key','value')
      and data_type <> 'text'
  loop
    execute format('alter table public.%I alter column %I type text using %I::text', r.table_name, r.column_name, r.column_name);
  end loop;
end $$;

alter table public.studio_reservations add column if not exists pw_hash text;
alter table public.studio_reservations alter column user_pw drop not null;
do $$ begin
  begin create unique index if not exists sj_settings_key_uq on public.settings(key); exception when others then null; end;
end $$;

-- 비밀 저장소 (브라우저에서는 절대 못 읽는 별도 공간)
create table if not exists sj_private.admin    (id int primary key default 1 check (id = 1), pw_hash text not null, updated_at timestamptz not null default now());
create table if not exists sj_private.sessions (token_hash text primary key, expires_at timestamptz not null);
create table if not exists sj_private.secret   (k text primary key, v text not null);
create table if not exists sj_private.fail     (id bigserial primary key, kind text not null, k text, at timestamptz not null default now());
create index if not exists sj_fail_idx on sj_private.fail(kind, k, at);
alter table sj_private.admin    enable row level security;
alter table sj_private.sessions enable row level security;
alter table sj_private.secret   enable row level security;
alter table sj_private.fail     enable row level security;

-- 관리자 비밀번호: 지금 값을 그대로 암호화해서 옮겨요 (값은 바뀌지 않아요)
insert into sj_private.admin (id, pw_hash)
select 1, extensions.crypt(coalesce((select value from public.settings where key = 'booking_admin_pw' limit 1), '0000'), extensions.gen_salt('bf', 10))
on conflict (id) do nothing;

-- 입장 코드(0529): 값은 그대로, 서버가 확인하도록 옮겨요
insert into sj_private.secret (k, v)
values ('entry', encode(sha256(convert_to('sj:' || '0529', 'UTF8')), 'hex'))
on conflict (k) do nothing;

-- 예약 비밀번호: 암호화본을 만들어 둬요 (원래 값은 그대로 두고, 2단계 잠금 때 지워요)
update public.studio_reservations
   set pw_hash = extensions.crypt(user_pw, extensions.gen_salt('bf', 8))
 where pw_hash is null and coalesce(user_pw, '') <> '';

-- ───────── 내부 도우미 (브라우저에서 호출 불가) ─────────
create or replace function sj_private.err(p_code text, p_msg text) returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'code', p_code, 'msg', p_msg) $$;

create or replace function sj_private.tmin(t text) returns int
language sql immutable as $$ select split_part(left(t, 5), ':', 1)::int * 60 + split_part(left(t, 5), ':', 2)::int $$;

create or replace function sj_private.norm_name(s text) returns text
language sql immutable as $$ select btrim(regexp_replace(coalesce(s, ''), '\s+', ' ', 'g')) $$;

create or replace function sj_private.entry_ok(p text) returns boolean
language sql stable as $$
  select coalesce(p, '') <> '' and length(p) <= 40 and exists (
    select 1 from sj_private.secret where k = 'entry' and v = encode(sha256(convert_to('sj:' || p, 'UTF8')), 'hex'))
$$;

create or replace function sj_private.admin_ok(p_token text) returns boolean
language sql stable as $$
  select coalesce(length(p_token), 0) between 20 and 200 and exists (
    select 1 from sj_private.sessions
     where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and expires_at > now())
$$;

create or replace function sj_private.client_ip() returns text
language plpgsql stable as $$
declare h jsonb;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  return coalesce(nullif(btrim(split_part(coalesce(h->>'cf-connecting-ip', h->>'x-forwarded-for', h->>'x-real-ip', ''), ',', 1)), ''), 'noip');
end $$;

create or replace function sj_private.fail_count(p_kind text, p_k text, p_min int) returns int
language sql stable as $$
  select count(*)::int from sj_private.fail
   where kind = p_kind and (p_k is null or k = p_k) and at > now() - make_interval(mins => p_min)
$$;

create or replace function sj_private.fail_add(p_kind text, p_k text) returns void
language plpgsql as $$
begin
  insert into sj_private.fail (kind, k) values (p_kind, p_k);
  if random() < 0.05 then
    delete from sj_private.fail where at < now() - interval '3 hours';
    delete from sj_private.sessions where expires_at < now();
  end if;
end $$;

create or replace function sj_private.cfg_latest() returns jsonb
language plpgsql stable as $$
declare r record; v jsonb; best jsonb := null;
begin
  for r in select value from public.settings where key = 'room_config' loop
    begin v := r.value::jsonb; exception when others then v := null; end;
    if v is not null and jsonb_typeof(v) = 'object' and jsonb_typeof(v->'rooms') = 'object'
       and (best is null or coalesce((v->>'rev')::numeric, 0) > coalesce((best->>'rev')::numeric, 0)) then
      best := v;
    end if;
  end loop;
  return best;
end $$;

create or replace function sj_private.rule_locked(p_cfg jsonb, p_date date, p_studio text, p_sm int, p_em int) returns boolean
language sql stable as $$
  select exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg->'weekly') = 'array' then p_cfg->'weekly' else '[]'::jsonb end) r
     where (r->>'studio_id') in (p_studio, 'ALL')
       and exists (select 1 from jsonb_array_elements_text(coalesce(r->'days', '[]'::jsonb)) d where d::int = extract(dow from p_date)::int)
       and not exists (select 1 from jsonb_array_elements_text(coalesce(r->'skip', '[]'::jsonb)) s where s = p_date::text)
       and sj_private.tmin(r->>'start') < p_em and sj_private.tmin(r->>'end') > p_sm)
$$;

-- ───────── 학생용 서버 함수 ─────────
create or replace function public.sj_entry_check(p_entry text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare ip text := sj_private.client_ip();
begin
  if sj_private.fail_count('entry', ip, 10) >= 30 then return sj_private.err('locked', '잠시 후 다시 시도해주세요.'); end if;
  if sj_private.entry_ok(p_entry) then return jsonb_build_object('ok', true); end if;
  perform sj_private.fail_add('entry', ip);
  return sj_private.err('entry', '코드가 올바르지 않아요');
end $$;

create or replace function public.sj_config(p_entry text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  v := sj_private.cfg_latest();
  return jsonb_build_object('ok', true, 'value', case when v is null then null else v::text end);
end $$;

create or replace function public.sj_day(p_entry text, p_date text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_admin boolean; v_res jsonb; v_locks jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  if coalesce(p_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('date', '날짜 형식 오류'); end if;
  v_admin := sj_private.admin_ok(p_token);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'date', r.date, 'studio_id', r.studio_id,
           'start_time', left(r.start_time, 5), 'end_time', left(r.end_time, 5),
           'user_name', case when v_admin then coalesce(r.user_name, '') else '' end,
           'user_class', case when v_admin then coalesce(r.user_class, '') else '' end) order by r.start_time, r.id), '[]'::jsonb)
    into v_res from public.studio_reservations r where r.date = p_date;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'date', l.date, 'studio_id', l.studio_id,
           'start_time', left(l.start_time, 5), 'end_time', left(l.end_time, 5),
           'reason', coalesce(l.reason, '')) order by l.start_time, l.id), '[]'::jsonb)
    into v_locks from public.studio_locks l where l.date = p_date;
  return jsonb_build_object('ok', true, 'admin', v_admin, 'res', v_res, 'locks', v_locks);
end $$;

create or replace function public.sj_book(p_entry text, p jsonb, p_token text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_admin boolean; v_id text; v_date text; v_d date; v_studio text; v_s text; v_e text; v_sm int; v_em int;
  v_name text; v_tutor text; v_pw text; v_kst timestamp; v_today date; v_nowm int;
  v_cfg jsonb; v_room jsonb; v_seats int; v_ex record; m int; v_cnt int;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요. 새로고침 후 다시 시도해주세요.'); end if;
  if p is null or jsonb_typeof(p) <> 'object' then return sj_private.err('bad', '요청 형식이 올바르지 않아요.'); end if;
  v_admin  := sj_private.admin_ok(p_token);
  v_id     := p->>'id';
  v_date   := p->>'date';
  v_studio := p->>'studio_id';
  v_s      := p->>'start_time';
  v_e      := p->>'end_time';
  v_name   := sj_private.norm_name(p->>'user_name');
  v_tutor  := left(btrim(coalesce(p->>'user_class', '')), 10);
  v_pw     := p->>'user_pw';
  if coalesce(v_id, '') !~ '^[A-Za-z0-9_-]{6,40}$' then return sj_private.err('bad', '요청 번호가 올바르지 않아요.'); end if;
  if coalesce(v_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('date', '예약할 수 없는 날짜예요.'); end if;
  begin v_d := v_date::date; exception when others then return sj_private.err('date', '예약할 수 없는 날짜예요.'); end;
  if v_date <> v_d::text then return sj_private.err('date', '예약할 수 없는 날짜예요.'); end if;
  if coalesce(v_studio, '') not in ('A', 'B', 'C', 'D') then return sj_private.err('room', '존재하지 않는 자습실이에요.'); end if;
  if coalesce(v_s, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(v_e, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then return sj_private.err('time', '시간을 다시 선택해주세요.'); end if;
  v_sm := sj_private.tmin(v_s); v_em := sj_private.tmin(v_e);
  if v_sm % 30 <> 0 or v_em % 30 <> 0 or v_sm < 540 or v_em > 1320 or v_sm >= v_em then return sj_private.err('time', '시간을 다시 선택해주세요.'); end if;
  if length(v_name) < 1 or length(v_name) > 30 then return sj_private.err('name', '이름은 1~30자로 입력해주세요.'); end if;
  if coalesce(v_pw, '') !~ '^[0-9]{4}$' then return sj_private.err('pw', '비밀번호는 숫자 4자리로 입력해주세요.'); end if;

  v_kst   := now() at time zone 'Asia/Seoul';
  v_today := v_kst::date;
  v_nowm  := extract(hour from v_kst)::int * 60 + extract(minute from v_kst)::int;
  if v_d < v_today or v_d > v_today + (case when v_admin then 13 else 3 end) then return sj_private.err('date', '예약할 수 없는 날짜예요.'); end if;

  -- 같은 날짜의 예약은 한 번에 한 건씩만 처리 (동시에 눌러도 순서대로 정확히 판정)
  perform pg_advisory_xact_lock(hashtext('sjbook:' || v_date));

  select * into v_ex from public.studio_reservations where id = v_id;
  if found then
    if v_ex.date = v_date and v_ex.studio_id = v_studio and left(v_ex.start_time, 5) = v_s and left(v_ex.end_time, 5) = v_e
       and sj_private.norm_name(v_ex.user_name) = v_name then
      return jsonb_build_object('ok', true, 'already', true, 'id', v_id);
    end if;
    return sj_private.err('bad', '요청 번호가 겹쳐요. 새로고침 후 다시 시도해주세요.');
  end if;

  if v_d = v_today and v_sm + 30 <= v_nowm then return sj_private.err('past', '이미 지난 시간은 예약할 수 없어요. 다른 시간을 선택해주세요.'); end if;

  v_cfg := sj_private.cfg_latest();
  v_room := case when v_cfg is null then null else v_cfg->'rooms'->v_studio end;
  if v_room is null or jsonb_typeof(v_room) <> 'object' then v_room := jsonb_build_object('open', true, 'seats', 15); end if;
  v_seats := coalesce(floor((v_room->>'seats')::numeric)::int, 15);
  if coalesce((v_room->>'open')::boolean, true) = false or v_seats <= 0 then return sj_private.err('closed', '지금은 운영하지 않는 자습실이에요.'); end if;

  if exists (select 1 from public.studio_reservations r
              where r.date = v_date and sj_private.norm_name(r.user_name) = v_name
                and sj_private.tmin(r.start_time) < v_em and sj_private.tmin(r.end_time) > v_sm) then
    return sj_private.err('dup', '한 사람당 한 자리만 예약할 수 있어요. 같은 시간에 이미 예약이 있어요. ''내 예약''에서 확인해주세요.');
  end if;

  select count(*) into v_cnt from public.studio_reservations r where r.date >= v_today::text and sj_private.norm_name(r.user_name) = v_name;
  if v_cnt >= 40 then return sj_private.err('limit', '예약 가능한 건수를 넘었어요. 이용한 예약을 정리한 뒤 다시 시도해주세요.'); end if;

  if exists (select 1 from public.studio_locks l
              where l.date = v_date and l.studio_id in (v_studio, 'ALL')
                and sj_private.tmin(l.start_time) < v_em and sj_private.tmin(l.end_time) > v_sm)
     or sj_private.rule_locked(v_cfg, v_d, v_studio, v_sm, v_em) then
    return sj_private.err('lock', '선택한 시간에 잠금이 설정돼 있어요.');
  end if;

  m := v_sm;
  while m < v_em loop
    select count(*) into v_cnt from public.studio_reservations r
     where r.date = v_date and r.studio_id = v_studio
       and sj_private.tmin(r.start_time) < m + 30 and sj_private.tmin(r.end_time) > m;
    if v_cnt >= v_seats then return sj_private.err('full', '방금 마감된 시간이 있어요. 다른 시간을 선택해주세요.'); end if;
    m := m + 30;
  end loop;

  insert into public.studio_reservations (id, date, studio_id, start_time, end_time, user_name, user_class, user_pw, pw_hash)
  values (v_id, v_date, v_studio, v_s, v_e, v_name, v_tutor, null, extensions.crypt(v_pw, extensions.gen_salt('bf', 8)));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.sj_my(p_entry text, p_name text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_name text := sj_private.norm_name(p_name); v_today text := ((now() at time zone 'Asia/Seoul')::date)::text; v jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  if length(v_name) < 1 or length(v_name) > 30 then return jsonb_build_object('ok', true, 'rows', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'date', r.date, 'studio_id', r.studio_id,
           'start_time', left(r.start_time, 5), 'end_time', left(r.end_time, 5),
           'user_name', r.user_name, 'user_class', coalesce(r.user_class, '')) order by r.date, r.start_time, r.id), '[]'::jsonb)
    into v from public.studio_reservations r
   where r.date >= v_today and sj_private.norm_name(r.user_name) = v_name;
  return jsonb_build_object('ok', true, 'rows', v);
end $$;

create or replace function public.sj_cancel(p_entry text, p_id text, p_pw text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record; good boolean; n int;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select * into r from public.studio_reservations where id = p_id;
  if not found then return sj_private.err('not_found', '이미 취소됐거나 없는 예약이에요.'); end if;
  if sj_private.fail_count('cancel', p_id, 10) >= 5 then return sj_private.err('locked', '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.'); end if;
  if r.pw_hash is not null then
    good := extensions.crypt(coalesce(p_pw, ''), r.pw_hash) = r.pw_hash;
  else
    good := coalesce(r.user_pw, '') <> '' and r.user_pw = p_pw;
  end if;
  if not good then
    perform sj_private.fail_add('cancel', p_id);
    n := 5 - sj_private.fail_count('cancel', p_id, 10);
    return jsonb_build_object('ok', false, 'code', 'wrong_pw', 'msg', '비밀번호가 틀려요', 'left', greatest(n, 0));
  end if;
  delete from public.studio_reservations where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_rank_rows(p_entry text, p_from text, p_to text, p_off int default 0, p_lim int default 5000) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('date', '날짜 형식 오류'); end if;
  select coalesce(jsonb_agg(jsonb_build_array(t.user_name, coalesce(t.user_class, ''), t.date, left(t.start_time, 5), left(t.end_time, 5)) order by t.date, t.id), '[]'::jsonb)
    into v
    from (select r.* from public.studio_reservations r where r.date >= p_from and r.date <= p_to
           order by r.date, r.id offset greatest(coalesce(p_off, 0), 0) limit least(greatest(coalesce(p_lim, 5000), 1), 5000)) t;
  return jsonb_build_object('ok', true, 'rows', v);
end $$;

-- ───────── 관리자용 서버 함수 (로그인해서 받은 열쇠가 있어야만 동작) ─────────
create or replace function public.sj_admin_login(p_pw text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare ip text := sj_private.client_ip(); a record; tok text; n int;
begin
  if sj_private.fail_count('admin', ip, 10) >= 5 or sj_private.fail_count('admin', null, 60) >= 30 then
    return sj_private.err('locked', '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.');
  end if;
  select * into a from sj_private.admin where id = 1;
  if not found then return sj_private.err('not_ready', '서버 설정이 아직 끝나지 않았어요.'); end if;
  if extensions.crypt(coalesce(p_pw, ''), a.pw_hash) <> a.pw_hash then
    perform sj_private.fail_add('admin', ip);
    n := 5 - sj_private.fail_count('admin', ip, 10);
    return jsonb_build_object('ok', false, 'code', 'wrong', 'msg', '비밀번호가 틀렸어요', 'left', greatest(n, 0));
  end if;
  delete from sj_private.fail where kind = 'admin' and k = ip;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into sj_private.sessions (token_hash, expires_at) values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), now() + interval '12 hours');
  return jsonb_build_object('ok', true, 'token', tok);
end $$;

create or replace function public.sj_admin_check(p_token text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  return jsonb_build_object('ok', sj_private.admin_ok(p_token));
end $$;

create or replace function public.sj_admin_logout(p_token text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  delete from sj_private.sessions where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_change_pw(p_token text, p_cur text, p_new text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare ip text := sj_private.client_ip(); a record; n int;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if sj_private.fail_count('admin', ip, 10) >= 5 then return sj_private.err('locked', '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.'); end if;
  if length(coalesce(p_new, '')) < 4 or length(p_new) > 30 then return sj_private.err('bad', '새 비밀번호는 4~30자로 입력해주세요.'); end if;
  select * into a from sj_private.admin where id = 1;
  if not found or extensions.crypt(coalesce(p_cur, ''), a.pw_hash) <> a.pw_hash then
    perform sj_private.fail_add('admin', ip);
    return sj_private.err('wrong', '현재 비밀번호가 틀렸어요');
  end if;
  update sj_private.admin set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), updated_at = now() where id = 1;
  delete from sj_private.sessions where token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_save_config(p_token text, p_value text, p_expected_rev numeric default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb; cur jsonb; cur_rev numeric; new_rev numeric; n int;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if p_value is null or length(p_value) > 60000 then return sj_private.err('bad', '설정이 너무 커요.'); end if;
  begin v := p_value::jsonb; exception when others then return sj_private.err('bad', '설정 형식이 올바르지 않아요.'); end;
  if jsonb_typeof(v) <> 'object' or jsonb_typeof(v->'rooms') <> 'object' or jsonb_typeof(v->'rev') <> 'number' then
    return sj_private.err('bad', '설정 형식이 올바르지 않아요.');
  end if;
  new_rev := (v->>'rev')::numeric;
  perform pg_advisory_xact_lock(hashtext('sjcfg'));
  cur := sj_private.cfg_latest();
  cur_rev := coalesce((cur->>'rev')::numeric, 0);
  if (p_expected_rev is not null and cur_rev <> p_expected_rev) or new_rev <= cur_rev then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'msg', '다른 기기에서 먼저 저장했어요', 'value', case when cur is null then null else cur::text end);
  end if;
  update public.settings set value = p_value where key = 'room_config';
  get diagnostics n = row_count;
  if n = 0 then insert into public.settings (key, value) values ('room_config', p_value); end if;
  return jsonb_build_object('ok', true, 'rev', new_rev);
end $$;

create or replace function public.sj_admin_lock_add(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id text := p->>'id'; v_date text := p->>'date'; v_st text := p->>'studio_id'; v_s text := p->>'start_time'; v_e text := p->>'end_time'; v_reason text := left(btrim(coalesce(p->>'reason', '')), 20);
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if coalesce(v_id, '') !~ '^[A-Za-z0-9_-]{6,40}$' or coalesce(v_date, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(v_st, '') not in ('A', 'B', 'C', 'D', 'ALL')
     or coalesce(v_s, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(v_e, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or v_s >= v_e then
    return sj_private.err('bad', '잠금 정보가 올바르지 않아요.');
  end if;
  begin perform v_date::date; exception when others then return sj_private.err('bad', '잠금 정보가 올바르지 않아요.'); end;
  insert into public.studio_locks (id, date, studio_id, start_time, end_time, reason)
  values (v_id, v_date, v_st, v_s, v_e, case when v_reason = '' then '강의' else v_reason end)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_lock_del(p_token text, p_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  delete from public.studio_locks where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_cancel(p_token text, p_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  delete from public.studio_reservations where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_rows(p_token text, p_from text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('date', '날짜 형식 오류'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user_name', t.user_name, 'user_class', coalesce(t.user_class, ''), 'date', t.date,
           'studio_id', t.studio_id, 'start_time', left(t.start_time, 5), 'end_time', left(t.end_time, 5)) order by t.date, t.start_time, t.id), '[]'::jsonb)
    into v from (select * from public.studio_reservations r where r.date >= p_from order by r.date, r.start_time, r.id limit 3000) t;
  return jsonb_build_object('ok', true, 'rows', v);
end $$;

-- ───────── 호출 권한: 공개 함수만 열고, 내부 도우미는 닫기 ─────────
revoke all on all functions in schema sj_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'sj_entry_check(text)', 'sj_config(text)', 'sj_day(text,text,text)', 'sj_book(text,jsonb,text)', 'sj_my(text,text)',
    'sj_cancel(text,text,text)', 'sj_rank_rows(text,text,text,integer,integer)', 'sj_admin_login(text)', 'sj_admin_check(text)',
    'sj_admin_logout(text)', 'sj_admin_change_pw(text,text,text)', 'sj_admin_save_config(text,text,numeric)',
    'sj_admin_lock_add(text,jsonb)', 'sj_admin_lock_del(text,text)', 'sj_admin_cancel(text,text)', 'sj_admin_rows(text,text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
select 'OK 1단계 완료 · 예약 ' || (select count(*) from public.studio_reservations) || '건 / 암호화 ' || (select count(*) from public.studio_reservations where pw_hash is not null) || '건' as result;
