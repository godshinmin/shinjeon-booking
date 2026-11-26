-- 작도 챌린지: 하루 한 번이라도 인증하면 OK(인증한 날 수 기준·동점 같은 등수) + 연속 인증(COMBO) 집계 (08, 14 이후 실행)
create or replace function sj_private.chal_streaks(p_start text, p_end text) returns jsonb
language sql stable as $$
  with d as (select distinct name, day::date as dd from sj_private.chal_posts where p_start is not null and day >= p_start and day <= p_end),
       g as (select name, dd, dd - (row_number() over (partition by name order by dd))::int as grp from d),
       i as (select name, count(*)::int as n, max(dd) as last from g group by name, grp),
       t as (select (now() at time zone 'Asia/Seoul')::date as today)
  select coalesce(jsonb_object_agg(x.name, jsonb_build_object('cur', x.cur, 'best', x.best)), '{}'::jsonb)
    from (select i.name, max(i.n) as best, coalesce(max(case when i.last >= t.today - 1 then i.n end), 0) as cur from i cross join t group by i.name) x
$$;

create or replace function public.sj_public_board() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today date := (now() at time zone 'Asia/Seoul')::date; v_ws date := date_trunc('week', now() at time zone 'Asia/Seoul')::date;
        v_study jsonb; v_chal jsonb; v_end text; v_tot int; v_cfg jsonb; v_show boolean; v_since text; v_from text; v_nowm int;
begin
  -- 🏆 공부왕 랭킹과 같은 기준: 이용을 마친 예약만, 겹친 시간은 한 번만, 랭킹 공개 설정·집계 시작일 반영
  v_cfg := sj_private.cfg_latest();
  v_show := coalesce((v_cfg->>'showRanking')::boolean, true);
  v_since := coalesce(nullif(v_cfg->>'rankingSince', ''), '2000-01-01');
  v_from := greatest(v_ws::text, v_since);
  v_nowm := extract(hour from (now() at time zone 'Asia/Seoul'))::int * 60 + extract(minute from (now() at time zone 'Asia/Seoul'))::int;
  if not v_show then
    v_study := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object('name', t.n, 'minutes', t.m) order by t.m desc, t.n), '[]'::jsonb) into v_study
      from (select n, sum(emax - smin)::int as m
              from (select n, d, grp, min(sm) as smin, max(em) as emax
                      from (select n, d, sm, em, sum(flag) over (partition by n, d order by sm, em) as grp
                              from (select n, d, sm, em,
                                           case when max(em) over (partition by n, d order by sm, em rows between unbounded preceding and 1 preceding) is null
                                                  or sm > max(em) over (partition by n, d order by sm, em rows between unbounded preceding and 1 preceding) then 1 else 0 end as flag
                                      from (select sj_private.norm_name(user_name) as n, date as d, sj_private.tmin(start_time) as sm, sj_private.tmin(end_time) as em
                                              from public.studio_reservations
                                             where date >= v_from and date <= v_today::text and coalesce(user_name, '') <> ''
                                               and (date < v_today::text or sj_private.tmin(end_time) <= v_nowm)) r
                                     where em > sm) f) g
                     group by n, d, grp) isl
             group by n having sum(emax - smin) > 0 order by 2 desc, 1 limit 5) t;
  end if;

  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    v_chal := jsonb_build_object('show', false);
  else
    v_end := c.end_date;
    select count(*)::int into v_tot from sj_private.chal_posts where day >= c.start_date and day <= v_end;
    select jsonb_build_object('show', true, 'name', c.name, 'start', c.start_date, 'end', c.end_date, 'started', v_today::text >= c.start_date, 'total_posts', v_tot,
             'top', coalesce(jsonb_agg(jsonb_build_object('name', sj_private.mask_name(t.n), 'posts', t.p, 'minutes', t.m, 'days', t.d) order by t.d desc, t.n), '[]'::jsonb))
      into v_chal
      from (select name as n, count(*)::int as p, sum(minutes)::int as m, count(distinct day)::int as d from sj_private.chal_posts
             where day >= c.start_date and day <= v_end group by name order by 4 desc, 1 limit 30) t;
  end if;
  return jsonb_build_object('ok', true, 'streaks', sj_private.chal_streaks(c.start_date, c.end_date), 'week_start', v_ws::text, 'week_end', (v_ws + 6)::text, 'study', v_study, 'study_show', v_show, 'chal', v_chal);
end $$;

create or replace function public.sj_public_chal(p_week int default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today text := (((now() at time zone 'Asia/Seoul')::date))::text; v_cur int; v_w int; v_ws text; v_we text; v_end text;
        v_rank jsonb; v_total jsonb; v_feed jsonb;
begin
  select * into c from sj_private.chal_cfg where id = 1;
  if c.start_date is null or not c.active then
    return jsonb_build_object('ok', true, 'configured', false, 'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active));
  end if;
  v_end := c.end_date;
  v_cur := least(greatest(sj_private.chal_week(c.start_date, v_today), 1), c.weeks);
  v_w   := least(greatest(coalesce(p_week, v_cur), 1), c.weeks);
  v_ws  := ((c.start_date::date + (v_w - 1) * 7))::text;
  v_we  := least((c.start_date::date + (v_w - 1) * 7 + 6)::text, c.end_date);

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'ds', t.ds)
           order by t.days desc, t.name), '[]'::jsonb) into v_rank
    from (select name, count(distinct day)::int as days, sum(minutes)::int as minutes, count(*)::int as posts, jsonb_agg(distinct day) as ds
            from sj_private.chal_posts where day >= v_ws and day <= v_we group by name order by 2 desc, 1 limit 40) t;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'weeks_ok', t.weeks_ok)
           order by t.days desc, t.name), '[]'::jsonb) into v_total
    from (select p.name, sum(w.dn)::int as days, max(p.minutes)::int as minutes, max(p.posts)::int as posts, count(*) filter (where w.dn >= c.goal)::int as weeks_ok
            from (select name, sum(minutes) as minutes, count(*) as posts from sj_private.chal_posts where day >= c.start_date and day <= v_end group by name) p
            join (select name, wk, count(distinct day) as dn from (select name, day, sj_private.chal_week(c.start_date, day) as wk from sj_private.chal_posts where day >= c.start_date and day <= v_end) z group by name, wk) w
              on w.name = p.name
           group by p.name order by max(p.posts) desc, sum(w.dn) desc, p.name limit 40) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes, 'thumb', t.thumb) order by t.created_at desc), '[]'::jsonb) into v_feed
    from (select id, day, sess, minutes, thumb, created_at from sj_private.chal_posts where day >= v_ws and day <= v_we order by created_at desc limit 24) t;

  return jsonb_build_object('ok', true, 'streaks', sj_private.chal_streaks(c.start_date, c.end_date), 'configured', true,
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed, 'feed_count', (select count(*)::int from sj_private.chal_posts where day >= v_ws and day <= v_we));
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

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'ds', t.ds)
           order by t.days desc, t.name), '[]'::jsonb) into v_rank
    from (select name, count(distinct day)::int as days, sum(minutes)::int as minutes, count(*)::int as posts, jsonb_agg(distinct day) as ds
            from sj_private.chal_posts where day >= v_ws and day <= v_we group by name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'weeks_ok', t.weeks_ok)
           order by t.days desc, t.name), '[]'::jsonb) into v_total
    from (select p.name, sum(w.dn)::int as days, max(p.minutes)::int as minutes, max(p.posts)::int as posts, count(*) filter (where w.dn >= c.goal)::int as weeks_ok
            from (select name, sum(minutes) as minutes, count(*) as posts from sj_private.chal_posts where day >= c.start_date and day <= v_end group by name) p
            join (select name, wk, count(distinct day) as dn from (select name, day, sj_private.chal_week(c.start_date, day) as wk from sj_private.chal_posts where day >= c.start_date and day <= v_end) z group by name, wk) w
              on w.name = p.name
           group by p.name limit 200) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes,
           'at', to_char(t.created_at at time zone 'Asia/Seoul', 'HH24:MI'), 'arch', t.arch) order by t.created_at desc), '[]'::jsonb) into v_feed
    from (select * from sj_private.chal_posts where day >= v_ws and day <= v_we order by created_at desc limit 300) t;

  return jsonb_build_object('ok', true, 'streaks', sj_private.chal_streaks(c.start_date, c.end_date), 'configured', true,
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed);
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
revoke all on function public.sj_public_board() from public;
revoke all on function public.sj_public_chal(integer) from public;
revoke all on function public.sj_chal_board(text, integer) from public;
grant execute on function public.sj_public_board() to anon, authenticated;
grant execute on function public.sj_public_chal(integer) to anon, authenticated;
grant execute on function public.sj_chal_board(text, integer) to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 인증한 날 기준 랭킹 + 연속 COMBO 준비 완료' as result;
