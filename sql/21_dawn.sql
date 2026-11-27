-- 작도 챌린지의 '하루' 기준: 새벽 5시 (0~5시에 올린 인증은 전날로 계산)
create or replace function sj_private.chal_now() returns timestamp language sql stable as $f$
  select (now() at time zone 'Asia/Seoul') - interval '5 hours';
$f$;

-- 새벽 5시 기준 적용: 작도 인증 관련 함수들의 '오늘' 계산을 chal_now() 로 바꿔요 (자습실 예약 시간은 그대로)
do $$
declare r record; d text; n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where (s.nspname = 'public' and p.proname in ('sj_chal_post','sj_chal_board','sj_public_chal'))
               or (s.nspname = 'sj_private' and p.proname = 'chal_streaks')
  loop
    d := pg_get_functiondef(r.oid);
    if position('now() at time zone ''Asia/Seoul''' in d) > 0 then
      d := replace(d, 'now() at time zone ''Asia/Seoul''', 'sj_private.chal_now()');
      execute d; n := n + 1;
    end if;
  end loop;
  raise notice '새벽 5시 기준 적용: % 개 함수', n;
end $$;
notify pgrst, 'reload schema';
select 'OK 작도 하루 기준 새벽 5시 적용 완료' as result;
