-- Run once against an empty database:  psql "$DATABASE_URL" -f schema.sql
DO $$ BEGIN  -- roles are cluster-wide: create them only once
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT anon, authenticated TO CURRENT_USER;  -- lets the connecting user SET ROLE to them

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, authenticated;

CREATE TABLE api.todos (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- the Better Auth user (public."user".id); the foreign key is added by server.ts once Better Auth has created its tables
  owner_id text DEFAULT (current_setting('request.jwt.claims', true)::json ->> 'sub'),
  title    text NOT NULL,
  done     boolean NOT NULL DEFAULT false,
  created  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api.tags (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id bigint NOT NULL REFERENCES api.todos(id) ON DELETE CASCADE,
  label   text NOT NULL
);

-- Row Level Security: everyone can read, only the owner (owner_id) can change their rows.
ALTER TABLE api.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY todos_read  ON api.todos FOR SELECT USING (true);
CREATE POLICY todos_write ON api.todos FOR ALL TO authenticated
  USING (owner_id = current_setting('request.jwt.claims', true)::json ->> 'sub')
  WITH CHECK (owner_id = current_setting('request.jwt.claims', true)::json ->> 'sub');

GRANT SELECT ON api.todos, api.tags TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.todos, api.tags TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA api TO authenticated;

CREATE FUNCTION api.open_todos() RETURNS SETOF api.todos
  LANGUAGE sql STABLE AS $$ SELECT * FROM api.todos WHERE NOT done $$;
GRANT EXECUTE ON FUNCTION api.open_todos() TO anon, authenticated;

-- demo rows without an owner: nobody can change them (owner_id is NULL), everybody can read them
INSERT INTO api.todos (title) VALUES ('Try pg-rest'), ('Write docs');
INSERT INTO api.tags (todo_id, label) VALUES (1, 'demo'), (1, 'bun');
