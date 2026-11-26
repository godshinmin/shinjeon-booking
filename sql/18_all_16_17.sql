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

-- 작도 챌린지: 이름 + 비밀번호 4자리로 본인 확인 (동명이인 구분, 남의 이름으로 올리기 방지) (16 이후 실행)
-- 이미 그 이름으로 올린 기록이 있으면, 처음 쓴 비밀번호와 같아야 올릴 수 있어요. 다르면 동명이인으로 보고 이름을 다르게 쓰도록 안내해요.
do $$
declare d text; marker text; blk text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'sj_chal_post' limit 1;
  if d is null then raise exception 'sj_chal_post 를 찾지 못했어요'; end if;
  marker := E'  if exists (select 1 from sj_private.chal_posts where id = v_id) then return jsonb_build_object(''ok'', true, ''already'', true, ''id'', v_id); end if;\n';
  if position(marker in d) = 0 then raise exception '삽입 위치를 찾지 못했어요'; end if;
  if position('name_taken' in d) > 0 then raise notice '이미 적용돼 있어요'; return; end if;
  blk := E'  declare v_owner text;\n  begin\n    select pw_hash into v_owner from sj_private.chal_posts where name = v_name order by created_at limit 1;\n    if v_owner is not null and extensions.crypt(v_pw, v_owner) <> v_owner then\n      if sj_private.fail_count(''chalname'', v_name, 10) >= 8 then return sj_private.err(''locked'', ''비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.''); end if;\n      perform sj_private.fail_add(''chalname'', v_name);\n      return sj_private.err(''name_taken'', ''이미 같은 이름으로 인증한 분이 있어요. 비밀번호가 다르면 동명이인으로 보고, 이름 뒤에 구분(예: 김민수B)을 붙여서 올려주세요.'');\n    end if;\n  end;\n';
  execute replace(d, marker, marker || blk);
end $$;
notify pgrst, 'reload schema';
select 'OK 외부 코드 + 이름·비밀번호 확인 준비 완료' as result;
