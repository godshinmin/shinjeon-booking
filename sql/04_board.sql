-- 신전스퀘어 · 입장 화면 순위판 + 작도 갤러리 + 누적 순위(인증 장수 기준)
-- 추가/교체만 합니다. 기존 데이터는 건드리지 않아요. (01, 03 실행 후)

-- 이름 가리기: 김○수 / 김○ (입장 코드 입력 전 화면용)
create or replace function sj_private.mask_name(s text) returns text
language sql immutable as $$
  select case when length(s) <= 1 then s
              when length(s) = 2 then left(s, 1) || '○'
              else left(s, 1) || repeat('○', length(s) - 2) || right(s, 1) end
$$;

-- 입장 화면: 이번 주 자습실 이용 TOP 5 + 작도 챌린지 전체 TOP 5 (이름은 가려서)
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
    v_end := (c.start_date::date + c.weeks * 7 - 1)::text;
    select count(*)::int into v_tot from sj_private.chal_posts where day >= c.start_date and day <= v_end;
    select jsonb_build_object('show', true, 'name', c.name, 'start', c.start_date, 'started', v_today::text >= c.start_date, 'total_posts', v_tot,
             'top', coalesce(jsonb_agg(jsonb_build_object('name', sj_private.mask_name(t.n), 'posts', t.p, 'minutes', t.m) order by t.p desc, t.m desc, t.n), '[]'::jsonb))
      into v_chal
      from (select name as n, count(*)::int as p, sum(minutes)::int as m from sj_private.chal_posts
             where day >= c.start_date and day <= v_end group by name order by 2 desc, 3 desc, 1 limit 5) t;
  end if;
  return jsonb_build_object('ok', true, 'week_start', v_ws::text, 'week_end', (v_ws + 6)::text, 'study', v_study, 'chal', v_chal);
end $$;

-- 작도 갤러리: 모든 주·모든 사람의 인증 목록 (사진은 작은 그림만 따로 불러가요). 이름으로 걸러보기 가능
create or replace function public.sj_chal_gallery(p_entry text, p_name text default null, p_off int default 0) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb; v_n text := sj_private.norm_name(p_name); v_total int;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select count(*)::int into v_total from sj_private.chal_posts where (v_n = '' or name = v_n);
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes,
           'at', to_char(t.created_at at time zone 'Asia/Seoul', 'HH24:MI')) order by t.created_at desc), '[]'::jsonb) into v
    from (select * from sj_private.chal_posts where (v_n = '' or name = v_n)
           order by created_at desc offset greatest(coalesce(p_off, 0), 0) limit 45) t;
  return jsonb_build_object('ok', true, 'total', v_total, 'items', v);
end $$;

-- 게시판: 누적 순위를 "인증 장수 많은 순 → 작도시간 순"으로 (주간 순위는 그대로: 인증일 순)
create or replace function public.sj_chal_board(p_entry text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today text := (((now() at time zone 'Asia/Seoul')::date))::text; v_cur int; v_w int; v_ws text; v_we text; v_end text;
        v_rank jsonb; v_total jsonb; v_feed jsonb;
begin
  if not sj_private.entry_ok(p_entry) then return sj_private.err('entry', '입장 코드 확인이 필요해요'); end if;
  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    return jsonb_build_object('ok', true, 'configured', false, 'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'goal', c.goal, 'active', c.active));
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
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'goal', c.goal, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed);
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['sj_public_board()', 'sj_chal_gallery(text,text,integer)', 'sj_chal_board(text,integer)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
notify pgrst, 'reload schema';
select 'OK 순위판·갤러리 준비 완료' as result;
