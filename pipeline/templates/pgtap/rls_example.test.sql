-- RLS proof template: the right role is ALLOWED, the wrong role is DENIED, executed as real
-- session roles (never a privileged connection). Synthetic fixtures only.
begin;
select plan(4);

-- Synthetic fixture rows (replace table/columns).
insert into public.example_items (id, owner_id, title)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'mine'),
       ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', 'theirs');

-- Act as user A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select results_eq(
  $$ select title from public.example_items order by title $$,
  $$ values ('mine'::text) $$,
  'user A sees only their own row'
);
select throws_ok(
  $$ update public.example_items set title = 'x' where id = '00000000-0000-0000-0000-000000000002' returning 1 $$,
  null, null,
  'user A cannot update user B''s row'
) ; -- if your policy silently filters instead of erroring, assert zero rows updated instead

-- Act as anonymous.
reset role;
set local role anon;
select is_empty($$ select 1 from public.example_items $$, 'anon sees nothing');
select lives_ok($$ select 1 $$, 'session still usable');

select * from finish();
rollback;
