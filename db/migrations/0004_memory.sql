-- HARU 0004: what Haru has learned about each person.
-- Facts the user taught it ("BioARO pays on the 15th and 30th", "sends 2,000 CAD to India each month",
-- "prefers short answers"). Per user, never shared, shown to the model on every turn.
create table if not exists user_memory (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  fact text not null check (length(fact) between 3 and 300),
  source text not null default 'ai' check (source in ('ai', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_memory_user_idx on user_memory(user_id, updated_at desc);
alter table user_memory enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on user_memory from anon, authenticated';
    execute 'revoke all on sequence user_memory_id_seq from anon, authenticated';
  end if;
end $$;
