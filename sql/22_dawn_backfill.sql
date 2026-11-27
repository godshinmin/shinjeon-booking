-- 새벽 5시 기준을 이미 올라온 인증에도 소급 적용 (0~5시에 올린 인증을 전날로 옮겨요. 챌린지 시작일 이전으로는 옮기지 않아요)
update sj_private.chal_posts p
   set day = ((p.created_at at time zone 'Asia/Seoul') - interval '5 hours')::date::text
 where day <> ((p.created_at at time zone 'Asia/Seoul') - interval '5 hours')::date::text
   and ((p.created_at at time zone 'Asia/Seoul') - interval '5 hours')::date::text >= (select start_date from sj_private.chal_cfg limit 1);
select 'OK 소급 적용 완료' as result, (select count(*) from sj_private.chal_posts) as posts;
