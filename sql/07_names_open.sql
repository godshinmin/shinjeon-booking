-- 입장 화면 순위판: 이름을 가리지 않고 그대로 표시 (04에서 만든 가림 함수를 '그대로 반환'으로 교체)
create or replace function sj_private.mask_name(s text) returns text
language sql immutable as $$ select s $$;
select 'OK 이름 그대로 표시' as result;
