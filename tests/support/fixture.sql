-- Roles are cluster-wide, so create them idempotently.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE SCHEMA api;
CREATE SCHEMA v2;
GRANT USAGE ON SCHEMA api, v2 TO anon, authenticated;

CREATE TABLE api.clients (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  meta jsonb,
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE api.clients IS 'Our customers';
COMMENT ON COLUMN api.clients.email IS 'Contact email';

CREATE TABLE api.profiles (
  client_id int PRIMARY KEY REFERENCES api.clients(id) ON DELETE CASCADE,
  bio text
);

CREATE TABLE api.orders (
  id serial PRIMARY KEY,
  client_id int NOT NULL REFERENCES api.clients(id),
  status text NOT NULL DEFAULT 'new',
  total numeric(10,2) NOT NULL DEFAULT 0,
  placed_at date DEFAULT current_date
);

CREATE TABLE api.products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  price numeric(10,2) NOT NULL
);

CREATE TABLE api.order_items (
  order_id int NOT NULL REFERENCES api.orders(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES api.products(id),
  qty int NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE api.employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  manager_id int REFERENCES api.employees(id)
);

-- Row level security: a user only sees and writes their own notes.
CREATE TABLE api.notes (
  id serial PRIMARY KEY,
  owner text NOT NULL DEFAULT (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'),
  body text NOT NULL
);
ALTER TABLE api.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY notes_owner ON api.notes
  USING (owner = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'))
  WITH CHECK (owner = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'));

CREATE VIEW api.big_orders AS SELECT * FROM api.orders WHERE total > 100;
-- An aggregate view is not auto-updatable.
CREATE VIEW api.client_totals AS SELECT client_id, sum(total) AS revenue FROM api.orders GROUP BY client_id;

CREATE TABLE v2.things (id serial PRIMARY KEY, label text NOT NULL);

-- Functions
CREATE FUNCTION api.add(a int, b int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$;
CREATE FUNCTION api.hello() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'hello'::text $$;
CREATE FUNCTION api.greet(name text DEFAULT 'world') RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'hello ' || name $$;
CREATE FUNCTION api.orders_by_status(s text) RETURNS SETOF api.orders LANGUAGE sql STABLE AS $$ SELECT * FROM api.orders WHERE status = s $$;
CREATE FUNCTION api.client_summary(cid int) RETURNS TABLE(client_id int, order_count bigint, revenue numeric)
  LANGUAGE sql STABLE AS $$ SELECT cid, count(*), coalesce(sum(total), 0) FROM api.orders WHERE client_id = cid $$;
CREATE FUNCTION api.nothing() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION api.whoami() RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'role', current_user,
    'claims', nullif(current_setting('request.jwt.claims', true), '')::json,
    'tenant', nullif(current_setting('app.tenant', true), ''));
$$;
CREATE FUNCTION api.echo_json(body json) RETURNS json LANGUAGE sql IMMUTABLE AS $$ SELECT body $$;
CREATE FUNCTION api.boom() RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'teapot' USING ERRCODE = 'PT418', HINT = 'short and stout', DETAIL = 'tip me over'; END $$;
CREATE FUNCTION api.with_headers() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('response.headers', '[{"X-Custom": "yes"}]', true);
  PERFORM set_config('response.status', '202', true);
  RETURN 'accepted';
END $$;

CREATE FUNCTION api.add_note(txt text) RETURNS int LANGUAGE sql AS $$
  INSERT INTO api.notes(body) VALUES (txt) RETURNING id $$;
CREATE FUNCTION api.echo_unnamed(json) RETURNS json LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
CREATE FUNCTION api.ovl(a int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'int' $$;
CREATE FUNCTION api.ovl(a text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'text' $$;
CREATE FUNCTION api.nums() RETURNS SETOF int LANGUAGE sql IMMUTABLE AS $$ SELECT generate_series(1, 3) $$;
CREATE FUNCTION api.first_client() RETURNS api.clients LANGUAGE sql STABLE AS $$ SELECT * FROM api.clients ORDER BY id LIMIT 1 $$;
CREATE FUNCTION api.req_info() RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'method', current_setting('request.method', true),
    'path', current_setting('request.path', true),
    'header', nullif(current_setting('request.headers', true), '')::json ->> 'x-test',
    'cookie', nullif(current_setting('request.cookies', true), '')::json ->> 'sid',
    'search_path', current_setting('search_path'),
    'tz', current_setting('TimeZone'));
$$;
CREATE FUNCTION api.pre_check() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(current_setting('request.headers', true), '')::json ->> 'x-block' IS NOT NULL THEN
    RAISE EXCEPTION 'blocked by pre-request' USING ERRCODE = 'PT403';
  END IF;
END $$;

CREATE FUNCTION api.sum_all(VARIADIC nums int[]) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(sum(n), 0)::int FROM unnest(nums) n $$;
CREATE FUNCTION api.join_all(sep text, VARIADIC parts text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT array_to_string(parts, sep) $$;
CREATE FUNCTION api.blob() RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT '\x68656c6c6f'::bytea $$;

-- Computed relationships: functions taking a table row and returning related rows.
CREATE FUNCTION api.order_client(api.orders) RETURNS SETOF api.clients ROWS 1 LANGUAGE sql STABLE AS $$
  SELECT * FROM api.clients WHERE id = $1.client_id $$;
CREATE FUNCTION api.recent_orders(api.clients) RETURNS SETOF api.orders LANGUAGE sql STABLE AS $$
  SELECT * FROM api.orders WHERE client_id = $1.id ORDER BY id DESC $$;
CREATE FUNCTION api.client_profile(api.clients) RETURNS api.profiles LANGUAGE sql STABLE AS $$
  SELECT * FROM api.profiles WHERE client_id = $1.id $$;

-- Data
INSERT INTO api.clients (name, email, meta, tags) VALUES
  ('Ada',   'ada@example.com',   '{"tier":"gold","address":{"city":"London"}}', '{vip,early}'),
  ('Linus', 'linus@example.com', '{"tier":"silver"}',                          '{oss}'),
  ('Grace', 'grace@example.com', NULL,                                          '{navy,vip}');
INSERT INTO api.profiles VALUES (1, 'First programmer'), (3, 'Compiler pioneer');
INSERT INTO api.orders (client_id, status, total, placed_at) VALUES
  (1, 'paid',    250.00, '2026-01-10'),
  (1, 'new',      40.50, '2026-02-01'),
  (2, 'paid',     99.99, '2026-02-15'),
  (3, 'shipped', 500.00, '2026-03-03');
INSERT INTO api.products (name, price) VALUES ('Keyboard', 120), ('Mouse', 30), ('Monitor', 380);
INSERT INTO api.order_items VALUES (1,1,1),(1,2,2),(2,2,1),(4,3,1),(4,1,1);
INSERT INTO api.employees (name, manager_id) VALUES ('Boss', NULL), ('Alice', 1), ('Bob', 1), ('Carol', 2);
INSERT INTO v2.things (label) VALUES ('one'), ('two');

-- Privileges
GRANT SELECT ON ALL TABLES IN SCHEMA api, v2 TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA api, v2 TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA api, v2 TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION api.nothing() FROM anon;
