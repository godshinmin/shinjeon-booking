-- ═══════════════════════════════════════════════════════════════
-- 비상용: 2단계 잠금을 되돌려요 (옛 앱 v2로 돌아갈 때만 사용)
-- 주의: 되돌리면 다시 누구나 표를 직접 볼 수 있어요. 급할 때만 쓰세요.
-- ═══════════════════════════════════════════════════════════════
grant select, insert, update, delete on public.settings, public.studio_reservations, public.studio_locks to anon;
drop policy if exists sj_anon_all on public.settings;
drop policy if exists sj_anon_all on public.studio_reservations;
drop policy if exists sj_anon_all on public.studio_locks;
create policy sj_anon_all on public.settings            for all to anon using (true) with check (true);
create policy sj_anon_all on public.studio_reservations for all to anon using (true) with check (true);
create policy sj_anon_all on public.studio_locks        for all to anon using (true) with check (true);
-- 백업에서 예전 평문 비밀번호 복원 (백업 이후 새 예약은 복원 불가)
update public.studio_reservations r set user_pw = b.user_pw
  from public.bak_20261101_reservations b where r.id = b.id and r.user_pw is null;
-- 관리자 비밀번호: 백업 값으로 복원 (이후 바꾼 비밀번호는 복원 불가)
insert into public.settings (key, value)
select key, value from public.bak_20261101_settings where key = 'booking_admin_pw'
on conflict (key) do nothing;
notify pgrst, 'reload schema';
select '롤백 완료' as result;
