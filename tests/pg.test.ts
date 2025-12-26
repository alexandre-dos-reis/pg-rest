import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { expect, test } from "vitest";
import { fn } from "../src";

test("pg", async () => {
  await using container = await new PostgreSqlContainer(
    "postgres:18-alpine",
  ).start();

  const client = new Client({
    connectionString: container.getConnectionUri(),
  });
  await client.connect();

  const result = await client.query("SELECT 1 as res");
  expect(result.rows.at(0)).toStrictEqual({ res: 1 });

  await client.end();
  expect(fn()).toBe("Hello, tsdown!");
});
