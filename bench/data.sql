-- Bulk data on top of tests/support/fixture.sql (loaded first). Sizes are scaled by the runner.
INSERT INTO api.clients (name, email, meta, tags)
SELECT 'Client ' || g || CASE WHEN g % 7 = 0 THEN ' Johnson' ELSE '' END,
       'client' || g || '@example.com',
       jsonb_build_object('tier', (ARRAY['gold','silver','bronze'])[1 + g % 3]),
       ARRAY['t' || (g % 10)]
FROM generate_series(4, :clients) g;

INSERT INTO api.products (name, price)
SELECT 'Product ' || g, (g % 500) + 0.99 FROM generate_series(4, :products) g;

INSERT INTO api.orders (client_id, status, total, placed_at)
SELECT 1 + (g * 7919) % :clients,
       (ARRAY['new','paid','shipped','cancelled'])[1 + g % 4],
       (g * 37) % 1000 + 0.5,
       date '2026-01-01' + (g % 300)
FROM generate_series(5, :orders) g;

INSERT INTO api.order_items (order_id, product_id, qty)
SELECT DISTINCT o, 1 + (o * k) % :products, 1 + (o + k) % 5
FROM generate_series(1, :orders) o, generate_series(1, 3) k
ON CONFLICT DO NOTHING;

CREATE INDEX ON api.orders (client_id);
CREATE INDEX ON api.orders (status, total);
CREATE INDEX ON api.order_items (product_id);
ANALYZE;
