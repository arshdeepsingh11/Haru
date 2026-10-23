-- HARU 0006: investing — countries, interests, watchlist, behaviour signals, market cache, news.

-- What each person follows: countries (IN, CA, WORLD) and their interests per country.
create table if not exists invest_profiles (
  user_id uuid primary key references app_users(id) on delete cascade,
  countries text[] not null default '{IN,CA,WORLD}',
  interests jsonb not null default '{}'::jsonb, -- {"IN": ["stocks","gold"], "CA": [...]}
  updated_at timestamptz not null default now(),
  constraint invest_profiles_countries check (countries <@ array['IN','CA','WORLD']::text[]),
  constraint invest_profiles_interests check (jsonb_typeof(interests) = 'object')
);

-- Assets a person saved (from the catalog or search).
create table if not exists invest_watchlist (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  country text not null check (country in ('IN','CA','WORLD')),
  asset_key text not null check (length(asset_key) between 2 and 120),
  name text not null check (length(name) between 1 and 160),
  kind text not null,
  symbols jsonb not null default '{}'::jsonb,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  unique (user_id, asset_key)
);

-- Behaviour signals that shape the feed (what they open, save, read).
create table if not exists invest_events (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  kind text not null check (kind in ('view_asset','open_news','save','unsave','search','select_interest','ask')),
  ref text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists invest_events_user_idx on invest_events(user_id, created_at desc);

-- Shared cache of market data from providers (quotes, candles, rates). No personal data except
-- AI insight entries, whose keys include the user id.
create table if not exists market_cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists market_cache_expiry_idx on market_cache(expires_at);

-- Headlines from publishers' official feeds: title, short summary and link only.
create table if not exists news_items (
  id bigserial primary key,
  url text not null unique check (url ~ '^https?://'),
  source text not null,
  feed text not null,
  title text not null,
  summary text,
  image text,
  lang text not null default 'en',
  published_at timestamptz not null,
  countries text[] not null default '{}',
  interests text[] not null default '{}',
  tags text[] not null default '{}',
  fetched_at timestamptz not null default now()
);
create index if not exists news_items_published_idx on news_items(published_at desc);
create index if not exists news_items_countries_idx on news_items using gin(countries);

alter table invest_profiles enable row level security;
alter table invest_watchlist enable row level security;
alter table invest_events enable row level security;
alter table market_cache enable row level security;
alter table news_items enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on invest_profiles, invest_watchlist, invest_events, market_cache, news_items from anon, authenticated';
    execute 'revoke all on sequence invest_watchlist_id_seq, invest_events_id_seq, news_items_id_seq from anon, authenticated';
  end if;
end $$;
