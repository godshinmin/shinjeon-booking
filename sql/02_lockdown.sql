-- ═══════════════════════════════════════════════════════════════
-- 신전스퀘어 자습실 · 서버 보안 2단계 (잠금)
-- 새 앱(v3)이 정상 동작하는 걸 확인한 뒤에만 실행하세요.
-- 하는 일: 예약표·잠금표·설정표를 브라우저에서 직접 못 보게 닫기, 평문 비밀번호 지우기
-- 이 SQL은 예약 데이터를 지우지 않아요. (비밀번호 평문과 옛 관리자 비밀번호 행만 지워요)
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  -- 1단계가 안 끝났으면 중단
  if to_regprocedure('public.sj_book(text,jsonb,text)') is null or to_regclass('sj_private.admin') is null then
    raise exception '1단계 SQL이 아직 실행되지 않았어요. 중단합니다.';
  end if;
  if (select count(*) from sj_private.admin) = 0 or (select count(*) from sj_private.secret where k = 'entry') = 0 then
    raise exception '관리자/입장 코드 설정이 비어 있어요. 중단합니다.';
  end if;
  -- 설정표에 이 앱 외의 값이 있으면 중단 (다른 서비스가 같은 표를 쓰고 있을 수 있어서)
  if exists (select 1 from public.settings where key not in ('room_config', 'booking_admin_pw')) then
    raise exception '설정표에 자습실 앱 외의 값이 있어요. 중단합니다. (Claude에게 알려주세요)';
  end if;
end $$;

-- 아직 암호화되지 않은 예약 비밀번호를 마저 암호화
update public.studio_reservations
   set pw_hash = extensions.crypt(user_pw, extensions.gen_salt('bf', 8))
 where pw_hash is null and coalesce(user_pw, '') <> '';

-- 이 3개 표의 공개 권한(정책)을 모두 제거
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
            where schemaname = 'public' and tablename in ('settings', 'studio_reservations', 'studio_locks')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.settings            enable row level security;
alter table public.studio_reservations enable row level security;
alter table public.studio_locks        enable row level security;
revoke all on public.settings, public.studio_reservations, public.studio_locks from public, anon, authenticated;

-- 평문 비밀번호 삭제 (암호화본만 남김) + 옛 관리자 비밀번호 행 삭제
update public.studio_reservations set user_pw = null where user_pw is not null;
delete from public.settings where key = 'booking_admin_pw';

notify pgrst, 'reload schema';
select '잠금 완료 · 예약 ' || (select count(*) from public.studio_reservations) || '건 유지, 평문 비밀번호 ' || (select count(*) from public.studio_reservations where coalesce(user_pw, '') <> '') || '건 남음' as result;
