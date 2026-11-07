-- Two tables, one enum, one function. No auth and no Row Level Security: this example is about the
-- types (see examples/rest/with-pglite or with-better-auth for the rest).
DO $$ BEGIN  -- roles are cluster-wide: create it only once
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
GRANT anon TO CURRENT_USER;  -- lets the connecting user SET ROLE to it

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon;

CREATE TYPE api.priority AS ENUM ('low', 'normal', 'high');

-- A composite type (https://www.postgresql.org/docs/current/rowtypes.html): one value made of
-- several fields, used below as a column. The generator describes its fields instead of `unknown`.
CREATE TYPE api.place AS (room text, floor int);

CREATE TABLE api.todos (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title    text NOT NULL,
  done     boolean NOT NULL DEFAULT false,
  priority api.priority NOT NULL DEFAULT 'normal',
  due      date,
  at       api.place
);

CREATE TABLE api.tags (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id bigint NOT NULL REFERENCES api.todos(id) ON DELETE CASCADE,
  label   text NOT NULL
);

CREATE FUNCTION api.open_todos() RETURNS SETOF api.todos
  LANGUAGE sql STABLE AS $$ SELECT * FROM api.todos WHERE NOT done $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON api.todos, api.tags TO anon;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA api TO anon;
GRANT EXECUTE ON FUNCTION api.open_todos() TO anon;

INSERT INTO api.todos (title, done, priority, due, at) VALUES
  ('Try pg-rest', false, 'high',   '2026-12-01', ROW('Lab', 2)::api.place),
  ('Write docs',  true,  'normal', NULL,         ROW('Library', -1)::api.place);
INSERT INTO api.tags (todo_id, label) VALUES (1, 'demo'), (1, 'types');
