-- 작도 챌린지 전용 입장 코드(0000) 추가: 이 코드로는 작도 챌린지만 쓸 수 있고, 자습실 예약 기능은 쓸 수 없어요.
-- 자습실 입장 코드(0529)는 그대로예요. (15 이후 실행)
insert into sj_private.secret (k, v)
values ('chal_entry', encode(sha256(convert_to('sj:' || '0000', 'UTF8')), 'hex'))
on conflict (k) do nothing;

create or replace function sj_private.chal_code_ok(p text) returns boolean
language sql stable as $$
  select coalesce(p, '') <> '' and length(p) <= 40 and exists (
    select 1 from sj_private.secret where k = 'chal_entry' and v = encode(sha256(convert_to('sj:' || p, 'UTF8')), 'hex'))
$$;

-- 작도 챌린지 기능은 두 코드 모두 허용 (자습실 예약·내 예약·랭킹·설정은 기존 코드만)
create or replace function sj_private.chal_ok(p text) returns boolean
language sql stable as $$ select sj_private.entry_ok(p) or sj_private.chal_code_ok(p) $$;

create or replace function public.sj_entry_check(p_entry text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare ip text := sj_private.client_ip();
begin
  if sj_private.fail_count('entry', ip, 10) >= 30 then return sj_private.err('locked', '잠시 후 다시 시도해주세요.'); end if;
  if sj_private.entry_ok(p_entry) then return jsonb_build_object('ok', true, 'role', 'full'); end if;
  if sj_private.chal_code_ok(p_entry) then return jsonb_build_object('ok', true, 'role', 'chal'); end if;
  perform sj_private.fail_add('entry', ip);
  return sj_private.err('entry', '코드가 올바르지 않아요');
end $$;

-- 작도 챌린지 함수들의 코드 확인을 chal_ok 로 교체 (현재 서버에 있는 정의를 그대로 가져와 한 줄만 바꿔요)
do $$
declare f text; d text; n int;
begin
  foreach f in array array['sj_chal_post', 'sj_chal_photo', 'sj_chal_board', 'sj_chal_gallery', 'sj_chal_thumbs', 'sj_chal_del']
  loop
    select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = f limit 1;
    if d is null then raise exception '함수를 찾지 못했어요: %', f; end if;
    n := (length(d) - length(replace(d, 'sj_private.entry_ok(p_entry)', ''))) / length('sj_private.entry_ok(p_entry)');
    if n < 1 then raise exception '교체할 곳이 없어요: %', f; end if;
    execute replace(d, 'sj_private.entry_ok(p_entry)', 'sj_private.chal_ok(p_entry)');
  end loop;
end $$;

revoke all on all functions in schema sj_private from public, anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 작도 챌린지 전용 코드(0000) 준비 완료' as result;
