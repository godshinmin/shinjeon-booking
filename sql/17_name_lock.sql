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
select 'OK 이름+비밀번호 본인 확인 준비 완료' as result;
