-- Run after 1-better-auth.sql (it needs the "user" table):  psql "$DATABASE_URL" -f 1-better-auth.sql -f 2-api.sql
DO $$ BEGIN  -- roles are cluster-wide: create them only once
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT anon, authenticated TO CURRENT_USER;  -- lets the connecting user SET ROLE to them

-- Who is calling: the Better Auth user id that server.ts puts in the claims (`sub`). NULL when anonymous.
-- It lives in its own schema, which pg-rest does not expose, so it is not reachable as /rpc/uid.
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE FUNCTION auth.uid() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims', true)::json ->> 'sub' $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, authenticated;

CREATE TABLE api.todos (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- the Better Auth user who owns the row (the session's user id, taken from the JWT claims by default)
  owner_id text DEFAULT auth.uid()
           REFERENCES public."user"(id) ON DELETE CASCADE,
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
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

GRANT SELECT ON api.todos, api.tags TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.todos, api.tags TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA api TO authenticated;

CREATE FUNCTION api.open_todos() RETURNS SETOF api.todos
  LANGUAGE sql STABLE AS $$ SELECT * FROM api.todos WHERE NOT done $$;
GRANT EXECUTE ON FUNCTION api.open_todos() TO anon, authenticated;

-- demo rows without an owner: nobody can change them (owner_id is NULL), everybody can read them
INSERT INTO api.todos (title) VALUES ('Try pg-rest'), ('Write docs');
INSERT INTO api.tags (todo_id, label) VALUES (1, 'demo'), (1, 'bun');
