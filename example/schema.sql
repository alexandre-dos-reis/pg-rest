-- Run once against an empty database:  psql "$DATABASE_URL" -f example/schema.sql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT anon, authenticated TO CURRENT_USER;  -- lets the connecting user SET ROLE to them

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, authenticated;

CREATE TABLE api.todos (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner    text NOT NULL DEFAULT (current_setting('request.jwt.claims', true)::json ->> 'sub'),
  title    text NOT NULL,
  done     boolean NOT NULL DEFAULT false,
  created  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api.tags (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id bigint NOT NULL REFERENCES api.todos(id) ON DELETE CASCADE,
  label   text NOT NULL
);

-- Row Level Security: everyone can read, only the owner can change their rows.
ALTER TABLE api.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY todos_read  ON api.todos FOR SELECT USING (true);
CREATE POLICY todos_write ON api.todos FOR ALL TO authenticated
  USING (owner = current_setting('request.jwt.claims', true)::json ->> 'sub')
  WITH CHECK (owner = current_setting('request.jwt.claims', true)::json ->> 'sub');

GRANT SELECT ON api.todos, api.tags TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.todos, api.tags TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA api TO authenticated;

CREATE FUNCTION api.open_todos() RETURNS SETOF api.todos
  LANGUAGE sql STABLE AS $$ SELECT * FROM api.todos WHERE NOT done $$;
GRANT EXECUTE ON FUNCTION api.open_todos() TO anon, authenticated;

INSERT INTO api.todos (owner, title) VALUES ('alice', 'Try pg-rest'), ('bob', 'Write docs');
INSERT INTO api.tags (todo_id, label) VALUES (1, 'demo'), (1, 'bun');
