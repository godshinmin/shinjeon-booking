-- 입장 화면 '이번 주 자습실 이용 TOP 5'를 🏆 공부왕 랭킹과 같은 기준으로 맞춤 (06 이후 실행)
-- 이용을 마친 시간만 · 겹친 시간은 한 번만 · 랭킹 공개 설정 / 집계 시작일 반영
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
             'top', coalesce(jsonb_agg(jsonb_build_object('name', sj_private.mask_name(t.n), 'posts', t.p, 'minutes', t.m) order by t.p desc, t.m desc, t.n), '[]'::jsonb))
      into v_chal
      from (select name as n, count(*)::int as p, sum(minutes)::int as m from sj_private.chal_posts
             where day >= c.start_date and day <= v_end group by name order by 2 desc, 3 desc, 1 limit 5) t;
  end if;
  return jsonb_build_object('ok', true, 'week_start', v_ws::text, 'week_end', (v_ws + 6)::text, 'study', v_study, 'study_show', v_show, 'chal', v_chal);
end $$;

revoke all on function public.sj_public_board() from public;
grant execute on function public.sj_public_board() to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 입장 화면 랭킹 기준 통일' as result;
