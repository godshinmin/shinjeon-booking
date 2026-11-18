-- 둘러보기(입장 코드 없이 구경만): 자습실 안내(예약 현황 없음) + 작도 챌린지 순위·그림(이름 없는 작은 사진)
-- 예약자 이름·예약 현황·큰 사진은 내려주지 않아요. (06 이후 실행)
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
           order by t.days desc, t.minutes desc, t.posts desc, t.name), '[]'::jsonb) into v_rank
    from (select name, count(distinct day)::int as days, sum(minutes)::int as minutes, count(*)::int as posts, jsonb_agg(distinct day) as ds
            from sj_private.chal_posts where day >= v_ws and day <= v_we group by name order by 2 desc, 3 desc limit 10) t;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'days', t.days, 'minutes', t.minutes, 'posts', t.posts, 'weeks_ok', t.weeks_ok)
           order by t.posts desc, t.minutes desc, t.name), '[]'::jsonb) into v_total
    from (select p.name, sum(w.dn)::int as days, max(p.minutes)::int as minutes, max(p.posts)::int as posts, count(*) filter (where w.dn >= c.goal)::int as weeks_ok
            from (select name, sum(minutes) as minutes, count(*) as posts from sj_private.chal_posts where day >= c.start_date and day <= v_end group by name) p
            join (select name, wk, count(distinct day) as dn from (select name, day, sj_private.chal_week(c.start_date, day) as wk from sj_private.chal_posts where day >= c.start_date and day <= v_end) z group by name, wk) w
              on w.name = p.name
           group by p.name order by max(p.posts) desc, max(p.minutes) desc limit 10) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes, 'thumb', t.thumb) order by t.created_at desc), '[]'::jsonb) into v_feed
    from (select id, day, sess, minutes, thumb, created_at from sj_private.chal_posts where day >= v_ws and day <= v_we order by created_at desc limit 24) t;

  return jsonb_build_object('ok', true, 'configured', true,
    'cfg', jsonb_build_object('name', c.name, 'start', c.start_date, 'weeks', c.weeks, 'end', c.end_date, 'goal', c.goal, 'active', c.active),
    'today', v_today, 'cur_week', v_cur, 'week', v_w, 'week_start', v_ws, 'week_end', v_we, 'started', v_today >= c.start_date, 'ended', v_today > v_end,
    'ranking', v_rank, 'total', v_total, 'feed', v_feed, 'feed_count', (select count(*)::int from sj_private.chal_posts where day >= v_ws and day <= v_we));
end $$;

create or replace function public.sj_public_info() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb := sj_private.cfg_latest(); r jsonb := '{}'::jsonb; k text; x jsonb;
begin
  if v is not null and jsonb_typeof(v->'rooms') = 'object' then
    foreach k in array array['A', 'B', 'C', 'D'] loop
      x := v->'rooms'->k;
      if x is not null and jsonb_typeof(x) = 'object' then
        r := r || jsonb_build_object(k, jsonb_build_object('name', left(coalesce(x->>'name', ''), 20), 'open', coalesce((x->>'open')::boolean, true), 'seats', coalesce((x->>'seats')::int, 15)));
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'rooms', r, 'info', left(coalesce(v->>'info', ''), 600), 'dday', coalesce(v->'dday', '{}'::jsonb),
    'notice', coalesce(v->'notice', '{}'::jsonb), 'message', coalesce(v->'message', '{}'::jsonb));
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
revoke all on function public.sj_public_chal(integer) from public;
revoke all on function public.sj_public_info() from public;
grant execute on function public.sj_public_chal(integer) to anon, authenticated;
grant execute on function public.sj_public_info() to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 둘러보기 준비 완료' as result;
