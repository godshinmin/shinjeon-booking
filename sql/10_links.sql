-- 입장 화면(코드 입력 전)에서도 홈페이지·카페·블로그·카카오톡 상담 링크를 보여주는 함수.
-- 관리 화면에서 저장한 링크 중 http(s) 주소만 내려줘요. (기존 데이터는 건드리지 않아요)
create or replace function public.sj_public_links() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb := sj_private.cfg_latest(); l jsonb := '{}'::jsonb; k text; u text;
begin
  if v is not null and jsonb_typeof(v->'links') = 'object' then
    foreach k in array array['home', 'cafe', 'blog', 'kakao'] loop
      u := btrim(coalesce(v->'links'->>k, ''));
      if u ~* '^https?://[^[:space:]<>"'']+$' and length(u) <= 300 then l := l || jsonb_build_object(k, u); end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'links', l);
end $$;

revoke all on function public.sj_public_links() from public;
grant execute on function public.sj_public_links() to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 바로가기 링크 준비 완료' as result;
