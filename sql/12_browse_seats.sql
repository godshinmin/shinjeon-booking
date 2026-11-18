-- 둘러보기: 「N석 운영」 대신 「지금 예약 가능한 좌석 수」를 보여줘요. (11 이후 실행)
-- 지금 시간대(30분 단위) 기준 남은 좌석 숫자만 내려주고, 예약자 이름·시간표는 내려주지 않아요.
create or replace function public.sj_public_info() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb := sj_private.cfg_latest(); r jsonb := '{}'::jsonb; k text; x jsonb;
        v_kst timestamp := now() at time zone 'Asia/Seoul'; v_today date; v_nowm int; v_sm int; v_in boolean;
        v_seats int; v_open boolean; v_cnt int; v_lock boolean;
begin
  v_today := v_kst::date;
  v_nowm  := extract(hour from v_kst)::int * 60 + extract(minute from v_kst)::int;
  v_sm    := (v_nowm / 30) * 30;
  v_in    := v_sm >= 540 and v_sm < 1320;
  foreach k in array array['A', 'B', 'C', 'D'] loop
    x := case when v is not null and jsonb_typeof(v->'rooms') = 'object' then v->'rooms'->k else null end;
    if x is null or jsonb_typeof(x) <> 'object' then continue; end if;
    v_open  := coalesce((x->>'open')::boolean, true);
    v_seats := coalesce(floor((x->>'seats')::numeric)::int, 15);
    v_cnt := 0; v_lock := false;
    if v_in and v_open then
      select count(*) into v_cnt from public.studio_reservations rr
       where rr.date = v_today::text and rr.studio_id = k
         and sj_private.tmin(rr.start_time) < v_sm + 30 and sj_private.tmin(rr.end_time) > v_sm;
      v_lock := exists (select 1 from public.studio_locks l
                         where l.date = v_today::text and l.studio_id in (k, 'ALL')
                           and sj_private.tmin(l.start_time) < v_sm + 30 and sj_private.tmin(l.end_time) > v_sm)
                or sj_private.rule_locked(v, v_today, k, v_sm, v_sm + 30);
    end if;
    r := r || jsonb_build_object(k, jsonb_build_object('name', left(coalesce(x->>'name', ''), 20), 'open', v_open, 'seats', v_seats,
           'avail', greatest(v_seats - v_cnt, 0), 'locked', v_lock));
  end loop;
  return jsonb_build_object('ok', true, 'rooms', r, 'info', left(coalesce(v->>'info', ''), 600), 'dday', coalesce(v->'dday', '{}'::jsonb),
    'notice', coalesce(v->'notice', '{}'::jsonb), 'message', coalesce(v->'message', '{}'::jsonb),
    'in_hours', v_in, 'slot', lpad((v_sm / 60)::text, 2, '0') || ':' || lpad((v_sm % 60)::text, 2, '0'));
end $$;

revoke all on function public.sj_public_info() from public;
grant execute on function public.sj_public_info() to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 둘러보기 예약 가능 좌석 표시 준비 완료' as result;
