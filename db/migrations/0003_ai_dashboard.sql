-- HARU 0003: the dashboard is built by the AI, card by card.
-- cards = {"show": ["next_shift", ...], "removed": ["spending", ...]}
--   show    = cards on the dashboard, in order
--   removed = cards the user took away (HARU won't add them back on its own)
-- NULL means "never built": existing users get cards derived from their data.
alter table dashboard_preferences add column if not exists cards jsonb;
alter table dashboard_preferences add column if not exists previous_cards jsonb;

do $$ begin
  alter table dashboard_preferences drop constraint if exists dashboard_preferences_cards_shape;
  alter table dashboard_preferences add constraint dashboard_preferences_cards_shape
    check (cards is null or (jsonb_typeof(cards) = 'object' and jsonb_typeof(coalesce(cards -> 'show', '[]'::jsonb)) = 'array'));
end $$;
