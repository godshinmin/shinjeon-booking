-- 둘러보기: 오늘부터 3일 뒤까지 시간대별 '남은 좌석 수'만 공개 (예약자 이름·내용은 공개 안 함)
create or replace function public.sj_public_day(p_date text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb := sj_private.cfg_latest(); r jsonb := '{}'::jsonb; k text; x jsonb;
        v_kst timestamp := now() at time zone 'Asia/Seoul'; v_today date; v_d date; v_nowm int;
        v_seats int; v_open boolean; v_cnt int; v_lock boolean; arr jsonb; i int; sm int;
begin
  v_today := v_kst::date;
  begin v_d := p_date::date; exception when others then return jsonb_build_object('ok', false, 'error', 'bad_date'); end;
  if v_d < v_today or v_d > v_today + 3 then return jsonb_build_object('ok', false, 'error', 'range'); end if;
  v_nowm := extract(hour from v_kst)::int * 60 + extract(minute from v_kst)::int;
  foreach k in array array['A', 'B', 'C', 'D'] loop
    x := case when v is not null and jsonb_typeof(v->'rooms') = 'object' then v->'rooms'->k else null end;
    if x is null or jsonb_typeof(x) <> 'object' then continue; end if;
    v_open  := coalesce((x->>'open')::boolean, true);
    v_seats := coalesce(floor((x->>'seats')::numeric)::int, 15);
    arr := '[]'::jsonb;
    for i in 0..23 loop
      sm := 540 + i * 30;
      if not v_open or (v_d = v_today and sm + 30 <= v_nowm) then arr := arr || to_jsonb(-2); continue; end if;
      select count(*) into v_cnt from public.studio_reservations rr
       where rr.date = v_d::text and rr.studio_id = k
         and sj_private.tmin(rr.start_time) < sm + 30 and sj_private.tmin(rr.end_time) > sm;
      v_lock := exists (select 1 from public.studio_locks l
                         where l.date = v_d::text and l.studio_id in (k, 'ALL')
                           and sj_private.tmin(l.start_time) < sm + 30 and sj_private.tmin(l.end_time) > sm)
                or sj_private.rule_locked(v, v_d, k, sm, sm + 30);
      arr := arr || to_jsonb(case when v_lock then -1 else greatest(v_seats - v_cnt, 0) end);
    end loop;
    r := r || jsonb_build_object(k, jsonb_build_object('name', left(coalesce(x->>'name', ''), 20), 'open', v_open, 'seats', v_seats, 'slots', arr));
  end loop;
  return jsonb_build_object('ok', true, 'date', v_d::text, 'rooms', r);
end $$;

revoke all on function public.sj_public_day(text) from public;
grant execute on function public.sj_public_day(text) to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 둘러보기 3일치 남은 좌석 준비 완료' as result;
