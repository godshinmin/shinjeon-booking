-- 삭제된 인증을 3일간 관리자가 볼 수 있게 보관 (누가·언제 올렸는지 함께). 사고(부적절한 사진) 대비.
alter table sj_private.chal_posts add column if not exists up_ip text;

create table if not exists sj_private.chal_trash (
  id text primary key, name text not null, day text not null, sess int not null, minutes int not null,
  photo text not null, thumb text not null, up_ip text, created_at timestamptz not null,
  deleted_at timestamptz not null default now());
alter table sj_private.chal_trash enable row level security;

create or replace function sj_private.chal_trash_keep() returns trigger
language plpgsql as $$
begin
  insert into sj_private.chal_trash (id, name, day, sess, minutes, photo, thumb, up_ip, created_at)
  values (old.id, old.name, old.day, old.sess, old.minutes, old.photo, old.thumb, old.up_ip, old.created_at)
  on conflict (id) do nothing;
  delete from sj_private.chal_trash where deleted_at < now() - interval '3 days';
  return old;
end $$;
drop trigger if exists chal_posts_trash on sj_private.chal_posts;
create trigger chal_posts_trash before delete on sj_private.chal_posts
  for each row execute function sj_private.chal_trash_keep();

-- 올릴 때 올린 사람의 접속 주소도 함께 기록 (sj_chal_post 에 한 줄만 추가)
do $$
declare d text; a text; b text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'sj_chal_post' limit 1;
  if d is null then raise exception 'sj_chal_post 를 찾지 못했어요'; end if;
  if position('up_ip' in d) > 0 then raise notice '이미 적용돼 있어요'; return; end if;
  a := 'pw_hash, bytes)'; b := 'length(v_photo) + length(v_thumb));';
  if position(a in d) = 0 or position(b in d) = 0 then raise exception '삽입 위치를 찾지 못했어요'; end if;
  execute replace(replace(d, a, 'pw_hash, bytes, up_ip)'), b, 'length(v_photo) + length(v_thumb), sj_private.client_ip());');
end $$;

create or replace function public.sj_admin_chal_trash(p_token text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  delete from sj_private.chal_trash where deleted_at < now() - interval '3 days';
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'day', t.day, 'sess', t.sess, 'minutes', t.minutes, 'thumb', t.thumb,
           'up_at', to_char(t.created_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'), 'del_at', to_char(t.deleted_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'),
           'ip', coalesce(t.up_ip, '')) order by t.deleted_at desc), '[]'::jsonb) into v
    from (select * from sj_private.chal_trash order by deleted_at desc limit 100) t;
  return jsonb_build_object('ok', true, 'items', v);
end $$;

create or replace function public.sj_admin_chal_trash_photo(p_token text, p_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record;
begin
  if not sj_private.admin_ok(p_token) then return sj_private.err('auth', '관리자 로그인이 만료됐어요. 다시 로그인해주세요.'); end if;
  select * into r from sj_private.chal_trash where id = p_id;
  if not found then return sj_private.err('not_found', '보관 기간(3일)이 지났거나 없는 인증이에요.'); end if;
  return jsonb_build_object('ok', true, 'photo', case when r.photo = '' then r.thumb else r.photo end);
end $$;

revoke all on function public.sj_admin_chal_trash(text) from public;
revoke all on function public.sj_admin_chal_trash_photo(text, text) from public;
grant execute on function public.sj_admin_chal_trash(text) to anon, authenticated;
grant execute on function public.sj_admin_chal_trash_photo(text, text) to anon, authenticated;
revoke all on all functions in schema sj_private from public, anon, authenticated;
notify pgrst, 'reload schema';
select 'OK 삭제된 인증 3일 보관 준비 완료' as result;
