-- 신전스퀘어 · 작도 챌린지: 시작일 ~ 종료일(기본: 시험일) 방식으로 변경 (03, 04 실행 후)
alter table sj_private.chal_cfg add column if not exists end_date text;
-- 기본 종료일 = 시험일(2027-03-06). 이미 설정된 값이 있으면 건드리지 않아요.
update sj_private.chal_cfg set end_date = '2027-03-06' where end_date is null;
update sj_private.chal_cfg set weeks = ceil(((end_date::date - start_date::date) + 1) / 7.0)::int where start_date is not null and end_date is not null and end_date::date >= start_date::date;

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
  if v_today > c.end_date then return sj_private.err('closed', '챌린지가 끝났어요.'); end if;
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

create or replace function public.sj_chal_board(p_entry text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today text := (((now() at time zone 'Asia/Seoul')::date))::text; v_cur int; v_w int; v_ws text; v_we text; v_end text;
        v_rank jsonb; v_total jsonb; v_feed jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    return jsonb_build_object('ok', true, 'configured', false, 'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active));
  end if;
  v_end := c.end_date;
  v_cur := least(greatest(sj_private.chal_week(c.start_date, v_today), 1), c.weeks);
  v_w   := least(greatest(coalesce(p_week, v_cur), 1), c.weeks);
  v_ws  := ((c.start_date::date + (v_w - 1) * 7))::text;
  v_we  := least((c.start_date::date + (v_w - 1) * 7 + 6)::text, c.end_date);

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts)
           order by t.days desc, t.minutes desc, t.posts desc, t.name), '[]'::jsonb) into v_rank
    from (select name, count(distinct day)::int as days, sum(minutes)::int as minutes, count(*)::int as posts
            from sj_private.chal_posts where day >= v_ws and day <= v_we group by name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'weeks_ok', t.weeks_ok)
           order by t.posts desc, t.minutes desc, t.name), '[]'::jsonb) into v_total
    from (select p.name, sum(w.dn)::int as days, max(p.minutes)::int as minutes, max(p.posts)::int as posts, count(*) filter (where w.dn >= c.goal)::int as weeks_ok
            from (select name, sum(minutes) as minutes, count(*) as posts from sj_private.chal_posts where day >= c.start_date and day <= v_end group by name) p
            join (select name, wk, count(distinct day) as dn from (select name, day, sj_private.chal_week(c.start_date, day) as wk from sj_private.chal_posts where day >= c.start_date and day <= v_end) z group by name, wk) w
              on w.name = p.name
           group by p.name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes,
           'at', to_char(t.created_at at time zone 'Asia/Seoul', 'HH24:MI')) order by t.created_at desc), '[]'::jsonb) into v_feed
    from (select * from sj_private.chal_posts where day >= v_ws and day <= v_we order by created_at desc limit 300) t;

  return jsonb_build_object('ok', true, 'configured', true,
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed);
end $$;

create or replace function public.sj_public_board() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today date := (now() at time zone 'Asia/Seoul')::date; v_ws date := date_trunc('week', now() at time zone 'Asia/Seoul')::date;
        v_study jsonb; v_chal jsonb; v_end text; v_tot int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('name', sj_private.mask_name(t.n), 'minutes', t.m) order by t.m desc, t.n), '[]'::jsonb) into v_study
    from (select sj_private.norm_name(user_name) as n,
                 sum(sj_private.tmin(end_time) - sj_private.tmin(start_time))::int as m
            from public.studio_reservations
           where date >= v_ws::text and date <= (v_ws + 6)::text and coalesce(user_name, '') <> ''
           group by 1 order by 2 desc, 1 limit 5) t;

  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    v_chal := jsonb_build_object('show', false);
  else
    v_end := c.end_date;
    select count(*)::int into v_tot from sj_private.chal_posts where day >= c.start_date and day <= v_end;
    select jsonb_build_object('show', true, 'name', c.name, 'start', c.start_date, 'started', v_today::text >= c.start_date, 'total_posts', v_tot,
             'top', coalesce(jsonb_agg(jsonb_build_object('name', sj_private.mask_name(t.n), 'posts', t.p, 'minutes', t.m) order by t.p desc, t.m desc, t.n), '[]'::jsonb))
      into v_chal
      from (select name as n, count(*)::int as p, sum(minutes)::int as m from sj_private.chal_posts
             where day >= c.start_date and day <= v_end group by name order by 2 desc, 3 desc, 1 limit 5) t;
  end if;
  return jsonb_build_object('ok', true, 'week_start', v_ws::text, 'week_end', (v_ws + 6)::text, 'study', v_study, 'chal', v_chal);
end $$;

create or replace function public.sj_admin_chal_cfg(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_name text := left(btrim(coalesce(p->>'name', '')), 30); v_start text := p->>'start'; v_end text := p->>'end'; v_goal int; v_active boolean; v_weeks int;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  if v_name = '' then v_name := '작도 챌린지'; end if;
  begin v_goal := coalesce((p->>'goal')::int, 5); v_active := coalesce((p->>'active')::boolean, false); exception when others then return sj_private.err('bad', '설정 값을 확인해주세요.'); end;
  if v_goal not between 1 and 7 then return sj_private.err('bad', '주 목표는 1~7일로 입력해주세요.'); end if;
  if coalesce(v_start, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(v_end, '') !~ '^\d{4}-\d{2}-\d{2}$' then return sj_private.err('bad', '시작일과 종료일을 입력해주세요.'); end if;
  begin
    if v_start::date::text <> v_start or v_end::date::text <> v_end then return sj_private.err('bad', '날짜 형식이 올바르지 않아요.'); end if;
    if v_end::date < v_start::date + 6 then return sj_private.err('bad', '종료일은 시작일로부터 최소 7일 뒤여야 해요.'); end if;
    v_weeks := ceil(((v_end::date - v_start::date) + 1) / 7.0)::int;
  exception when others then return sj_private.err('bad', '날짜 형식이 올바르지 않아요.'); end;
  if v_weeks > 60 then return sj_private.err('bad', '기간이 너무 길어요. (최대 60주)'); end if;
  update sj_private.chal_cfg set name = v_name, start_date = v_start, end_date = v_end, weeks = v_weeks, goal = v_goal, active = v_active where id = 1;
  return jsonb_build_object('ok', true, 'weeks', v_weeks);
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['sj_chal_post(text,jsonb)', 'sj_chal_board(text,integer)', 'sj_public_board()', 'sj_admin_chal_cfg(text,jsonb)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
notify pgrst, 'reload schema';
select 'OK 작도 챌린지 기간 설정 준비 완료' as result;
