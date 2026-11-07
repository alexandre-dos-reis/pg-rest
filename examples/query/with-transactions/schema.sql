-- Two accounts and a ledger: the smallest schema where "both writes, or neither" is not a detail.
-- Loaded into PGlite by db.ts; against a real server:  psql "$DATABASE_URL" -f schema.sql
DO $$ BEGIN  -- roles are cluster-wide: create them only once
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'member') THEN CREATE ROLE member NOLOGIN; END IF;
END $$;
GRANT anon, member TO CURRENT_USER;  -- lets the connecting user SET ROLE to them

CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, member;

CREATE TABLE api.accounts (
  id      text PRIMARY KEY,
  owner   text NOT NULL,
  -- the database's own last word: no transfer may leave an account overdrawn
  balance int NOT NULL CHECK (balance >= 0)
);

CREATE TABLE api.ledger (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payer   text NOT NULL REFERENCES api.accounts(id),
  payee   text NOT NULL REFERENCES api.accounts(id),
  amount  int NOT NULL CHECK (amount > 0),
  memo    text,
  at      timestamptz NOT NULL DEFAULT now()
);

-- Row Level Security: anyone may read, a member may only record a transfer *out of their own
-- account*. The claims this reads are set once, at the head of the transaction.
ALTER TABLE api.ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_read ON api.ledger FOR SELECT USING (true);
CREATE POLICY ledger_own ON api.ledger FOR INSERT TO member
  WITH CHECK (EXISTS (
    SELECT 1 FROM api.accounts a
    WHERE a.id = payer AND a.owner = current_setting('request.jwt.claims', true)::json ->> 'sub'
  ));

GRANT SELECT ON api.accounts, api.ledger TO anon, member;
GRANT UPDATE ON api.accounts TO member;
GRANT INSERT ON api.ledger TO member;

INSERT INTO api.accounts (id, owner, balance) VALUES
  ('alice-main', 'alice', 100),
  ('bob-main', 'bob', 100);
