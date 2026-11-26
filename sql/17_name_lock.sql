-- 작도 챌린지: 이름 + 비밀번호 4자리로 본인 확인 (동명이인 구분, 남의 이름으로 올리기 방지) (16 이후 실행)
-- 이미 그 이름으로 올린 기록이 있으면, 처음 쓴 비밀번호와 같아야 올릴 수 있어요. 다르면 동명이인으로 보고 이름을 다르게 쓰도록 안내해요.
do $$
declare d text; marker text; blk text; m2 text; blk2 text; changed boolean := false;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'sj_chal_post' limit 1;
  if d is null then raise exception 'sj_chal_post 를 찾지 못했어요'; end if;

  -- (1) 이름 형식 검사: 한글 2~5자(+구분 알파벳 1자) 또는 영문 2~20자. 장난 이름 차단
  m2 := E'  if length(v_name) < 1 or length(v_name) > 30 then return sj_private.err(''name'', ''이름은 1~30자로 입력해주세요.''); end if;\n';
  if position('name_bad' in d) = 0 then
    if position(m2 in d) = 0 then raise exception '이름 검사 삽입 위치를 찾지 못했어요'; end if;
    blk2 := E'  if v_name !~ ''^[가-힣]{2,5}[A-Za-z]?$'' and v_name !~ ''^[A-Za-z][A-Za-z ]{1,19}$'' then return sj_private.err(''name_bad'', ''이름은 본명(한글 2~5자)으로 입력해주세요. 같은 이름이 있으면 뒤에 알파벳을 붙여주세요 (예: 김민수B)''); end if;\n  if lower(v_name) ~ ''(바보|멍청|똥|씨발|시발|병신|개새|좆|지랄|섹스|관리자|운영자|익명|테스트|test|admin)'' then return sj_private.err(''name_bad'', ''장난 이름은 쓸 수 없어요. 본명으로 올려주세요.''); end if;\n';
    d := replace(d, m2, m2 || blk2); changed := true;
  end if;

  -- (2) 같은 이름 + 다른 비밀번호 차단
  marker := E'  if exists (select 1 from sj_private.chal_posts where id = v_id) then return jsonb_build_object(''ok'', true, ''already'', true, ''id'', v_id); end if;\n';
  if position('name_taken' in d) = 0 then
    if position(marker in d) = 0 then raise exception '삽입 위치를 찾지 못했어요'; end if;
    blk := E'  declare v_owner text;\n  begin\n    select pw_hash into v_owner from sj_private.chal_posts where name = v_name order by created_at limit 1;\n    if v_owner is not null and extensions.crypt(v_pw, v_owner) <> v_owner then\n      if sj_private.fail_count(''chalname'', v_name, 10) >= 8 then return sj_private.err(''locked'', ''비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.''); end if;\n      perform sj_private.fail_add(''chalname'', v_name);\n      return sj_private.err(''name_taken'', ''이미 같은 이름으로 인증한 분이 있어요. 비밀번호가 다르면 동명이인으로 보고, 이름 뒤에 알파벳을 붙여서 올려주세요 (예: 김민수B).'');\n    end if;\n  end;\n';
    d := replace(d, marker, marker || blk); changed := true;
  end if;

  if changed then execute d; else raise notice '이미 적용돼 있어요'; end if;
end $$;
-- 관리자: 비밀번호를 잊은 참가자의 번호를 새로 정해줘요 (그 이름의 모든 인증 비밀번호를 새 번호로 바꿔요)
create or replace function public.sj_admin_chal_reset_pw(p_token text, p_name text, p_new text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_name text := sj_private.norm_name(p_name); n int;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 필요해요'); end if;
  if coalesce(p_new, '') !~ '^[0-9]{4}$' then return sj_private.err('pw', '새 비밀번호는 숫자 4자리로 입력해주세요.'); end if;
  update sj_private.chal_posts set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 8)) where name = v_name;
  get diagnostics n = row_count;
  if n = 0 then return sj_private.err('not_found', '그 이름으로 올린 인증이 없어요.'); end if;
  delete from sj_private.fail where kind = 'chalname' and k = v_name;
  return jsonb_build_object('ok', true, 'count', n);
end $$;
revoke all on function public.sj_admin_chal_reset_pw(text, text, text) from public;
grant execute on function public.sj_admin_chal_reset_pw(text, text, text) to anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 이름+비밀번호 본인 확인 준비 완료' as result;
