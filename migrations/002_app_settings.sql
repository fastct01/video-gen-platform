-- Runtime settings changed from the UI (e.g. the Gemini API key). Every process polls this table,
-- so a change applies to the API and all workers without a restart. Values here override .env.
CREATE TABLE app_settings (
  name        text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
