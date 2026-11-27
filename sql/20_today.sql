-- 오늘 작도 인증한 사람 수 (이름 없이 숫자만 공개)
create or replace function public.sj_chal_today() returns jsonb language sql security definer set search_path = public, sj_private as $$
  select jsonb_build_object('ok', true,
    'people', (select count(distinct name) from sj_private.chal_posts where day = (now() at time zone 'Asia/Seoul')::date::text),
    'posts',  (select count(*) from sj_private.chal_posts where day = (now() at time zone 'Asia/Seoul')::date::text),
    'members', (select count(distinct name) from sj_private.chal_posts));
$$;
grant execute on function public.sj_chal_today() to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 오늘 인증 인원 준비 완료' as result;
