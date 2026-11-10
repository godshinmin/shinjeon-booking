-- ═══════════════════════════════════════════════════════════════
-- 신전스퀘어 · 작도 챌린지 (1단계 SQL이 먼저 실행돼 있어야 해요)
-- 추가만 합니다. 기존 예약·설정 데이터는 건드리지 않아요.
-- ═══════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('sj_private.admin') is null then raise exception '먼저 01_setup.sql(1단계)을 실행해주세요.'; end if;
end $$;

create table if not exists sj_private.chal_cfg (
  id int primary key default 1 check (id = 1),
  name text not null default '8주 작도 챌린지',
  start_date text, weeks int not null default 8, active boolean not null default false);
insert into sj_private.chal_cfg (id) values (1) on conflict (id) do nothing;

create table if not exists sj_private.chal_posts (
  id text primary key, name text not null, day text not null, sess int not null, minutes int not null,
  photo text not null, thumb text not null, pw_hash text not null, bytes int not null default 0,
  created_at timestamptz not null default now());
create index if not exists sj_chal_day_idx  on sj_private.chal_posts (day);
create index if not exists sj_chal_name_idx on sj_private.chal_posts (name, day);
alter table sj_private.chal_cfg   enable row level security;
alter table sj_private.chal_posts enable row level security;

create or replace function sj_private.chal_week(p_start text, p_day text) returns int
language sql immutable as $$ select floor((p_day::date - p_start::date) / 7.0)::int + 1 $$;

-- 게시판 한 번에: 설정 + 주간 순위 + 누적 순위 + 이번 주 인증 목록(사진 제외)
create or replace function public.sj_chal_board(p_entry text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today text := (((now() at time zone 'Asia/Seoul')::date))::text; v_cur int; v_w int; v_ws text; v_we text; v_end text;
        v_rank jsonb; v_total jsonb; v_feed jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    return jsonb_build_object('ok', true, 'configured', false, 'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'active', c.active));
  end if;
  v_end := ((c.start_date::date + c.weeks * 7 - 1))::text;
  v_cur := least(greatest(sj_private.chal_week(c.start_date, v_today), 1), c.weeks);
  v_w   := least(greatest(coalesce(p_week, v_cur), 1), c.weeks);
  v_ws  := ((c.start_date::date + (v_w - 1) * 7))::text;
  v_we  := ((c.start_date::date + (v_w - 1) * 7 + 6))::text;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts)
           order by t.days desc, t.minutes desc, t.posts desc, t.name), '[]'::jsonb) into v_rank
    from (select name, count(distinct day)::int as days, sum(minutes)::int as minutes, count(*)::int as posts
            from sj_private.chal_posts where day >= v_ws and day <= v_we group by name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'weeks_ok', t.weeks_ok)
           order by t.weeks_ok desc, t.days desc, t.minutes desc, t.name), '[]'::jsonb) into v_total
    from (select p.name, sum(w.dn)::int as days, max(p.minutes)::int as minutes, max(p.posts)::int as posts, count(*) filter (where w.dn >= 5)::int as weeks_ok
            from (select name, sum(minutes) as minutes, count(*) as posts from sj_private.chal_posts where day >= c.start_date and day <= v_end group by name) p
            join (select name, wk, count(distinct day) as dn from (select name, day, sj_private.chal_week(c.start_date, day) as wk from sj_private.chal_posts where day >= c.start_date and day <= v_end) z group by name, wk) w
              on w.name = p.name
           group by p.name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes,
           'at', to_char(t.created_at at time zone 'Asia/Seoul', 'HH24:MI')) order by t.created_at desc), '[]'::jsonb) into v_feed
    from (select * from sj_private.chal_posts where day >= v_ws and day <= v_we order by created_at desc limit 300) t;

  return jsonb_build_object('ok', true, 'configured', true,
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed);
end $$;

create or replace function public.sj_chal_post(p_entry text, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today text := (((now() at time zone 'Asia/Seoul')::date))::text; v_id text := p->>'id'; v_name text := sj_private.norm_name(p->>'name');
        v_sess int; v_min int; v_photo text := p->>'photo'; v_thumb text := p->>'thumb'; v_pw text := p->>'pw'; v_n int;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  if p is null or jsonb_typeof(p) <> 'object' then return sj_private.err('bad', '요청 형식이 올바르지 않아요.'); end if;
  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then return sj_private.err('closed', '지금은 챌린지 기간이 아니에요.'); end if;
  if v_today < c.start_date then return sj_private.err('closed', format('챌린지는 %s부터 시작해요.', c.start_date)); end if;
  if v_today > (c.start_date::date + c.weeks * 7 - 1)::text then return sj_private.err('closed', '챌린지가 끝났어요.'); end if;
  if coalesce(v_id, '') !~ '^[A-Za-z0-9_-]{6,40}$' then return sj_private.err('bad', '요청 번호가 올바르지 않아요.'); end if;
  if length(v_name) < 1 or length(v_name) > 30 then return sj_private.err('name', '이름은 1~30자로 입력해주세요.'); end if;
  begin v_sess := (p->>'sess')::int; v_min := (p->>'minutes')::int; exception when others then return sj_private.err('bad', '교시와 작도시간을 확인해주세요.'); end;
  if v_sess is null or v_sess not between 1 and 3 then return sj_private.err('sess', '교시를 선택해주세요.'); end if;
  if v_min is null or v_min not between 5 and 600 then return sj_private.err('minutes', '작도시간은 5~600분으로 입력해주세요.'); end if;
  if coalesce(v_pw, '') !~ '^[0-9]{4}$' then return sj_private.err('pw', '비밀번호는 숫자 4자리로 입력해주세요.'); end if;
  if coalesce(v_photo, '') !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(v_photo) > 400000 then return sj_private.err('photo', '사진을 다시 선택해주세요. (너무 크거나 형식이 달라요)'); end if;
  if coalesce(v_thumb, '') !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(v_thumb) > 60000 then return sj_private.err('photo', '사진을 다시 선택해주세요.'); end if;
  if exists (select 1 from sj_private.chal_posts where id = v_id) then return jsonb_build_object('ok', true, 'already', true, 'id', v_id); end if;
  select count(*) into v_n from sj_private.chal_posts where name = v_name and day = v_today;
  if v_n >= 6 then return sj_private.err('limit', '하루에 올릴 수 있는 인증은 6장까지예요.'); end if;
  insert into sj_private.chal_posts (id, name, day, sess, minutes, photo, thumb, pw_hash, bytes)
  values (v_id, v_name, v_today, v_sess, v_min, v_photo, v_thumb, extensions.crypt(v_pw, extensions.gen_salt('bf', 8)), length(v_photo) + length(v_thumb));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.sj_chal_thumbs(p_entry text, p_ids jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  if jsonb_typeof(p_ids) <> 'array' then return sj_private.err('bad', '요청 형식 오류'); end if;
  select coalesce(jsonb_object_agg(t.id, t.thumb), '{}'::jsonb) into v
    from (select id, thumb from sj_private.chal_posts where id in (select jsonb_array_elements_text(p_ids) limit 30)) t;
  return jsonb_build_object('ok', true, 'thumbs', v);
end $$;

create or replace function public.sj_chal_photo(p_entry text, p_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select photo into r from sj_private.chal_posts where id = p_id;
  if not found then return sj_private.err('not_found', '삭제됐거나 없는 인증이에요.'); end if;
  return jsonb_build_object('ok', true, 'photo', r.photo);
end $$;

create or replace function public.sj_chal_del(p_entry text, p_id text, p_pw text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record; n int;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select id, pw_hash into r from sj_private.chal_posts where id = p_id;
  if not found then return sj_private.err('not_found', '이미 삭제됐어요.'); end if;
  if sj_private.fail_count('chal', p_id, 10) >= 5 then return sj_private.err('locked', '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.'); end if;
  if extensions.crypt(coalesce(p_pw, ''), r.pw_hash) <> r.pw_hash then
    perform sj_private.fail_add('chal', p_id);
    n := 5 - sj_private.fail_count('chal', p_id, 10);
    return jsonb_build_object('ok', false, 'code', 'wrong_pw', 'msg', '비밀번호가 틀려요', 'left', greatest(n, 0));
  end if;
  delete from sj_private.chal_posts where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_chal_del(p_token text, p_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  delete from sj_private.chal_posts where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_chal_cfg(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_name text := left(btrim(coalesce(p->>'name', '')), 30); v_start text := p->>'start'; v_weeks int; v_active boolean;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if v_name = '' then v_name := '작도 챌린지'; end if;
  begin v_weeks := (p->>'weeks')::int; v_active := coalesce((p->>'active')::boolean, false); exception when others then return sj_private.err('bad', '설정 값을 확인해주세요.'); end;
  if v_weeks is null or v_weeks not between 1 and 30 then return sj_private.err('bad', '기간은 1~30주로 입력해주세요.'); end if;
  if coalesce(v_start, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('bad', '시작일을 입력해주세요.'); end if;
  begin if extract(isodow from v_start::date) <> 1 then return sj_private.err('bad', '시작일은 월요일로 해주세요. (주 단위가 월~일이에요)'); end if;
  exception when others then return sj_private.err('bad', '시작일 형식이 올바르지 않아요.'); end;
  update sj_private.chal_cfg set name = v_name, start_date = v_start, weeks = v_weeks, active = v_active where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.sj_admin_chal_usage(p_token text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  select count(*)::int n, coalesce(sum(bytes), 0)::bigint b into r from sj_private.chal_posts;
  return jsonb_build_object('ok', true, 'count', r.n, 'bytes', r.b);
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['sj_chal_board(text,integer)', 'sj_chal_post(text,jsonb)', 'sj_chal_thumbs(text,jsonb)', 'sj_chal_photo(text,text)',
    'sj_chal_del(text,text,text)', 'sj_admin_chal_del(text,text)', 'sj_admin_chal_cfg(text,jsonb)', 'sj_admin_chal_usage(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
notify pgrst, 'reload schema';
select 'OK 작도 챌린지 서버 준비 완료' as result;
