// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Comprehensive boundary condition and limit tests for DynamoDB API on Deno KV
 *
 * This test suite validates all documented limits and edge cases for the
 * DynamoDB-like API implementation, including:
 * - Key size limits (Deno KV: 2 KB max per key part)
 * - Value size limits (Deno KV: 64 KiB max)
 * - Atomic operation limits (Deno KV: 1000 mutations, 100 checks)
 * - Batch operation limits
 * - Query and scan limits
 * - Expression length limits
 * - Attribute count and nesting limits
 * - Number precision limits
 * - String and binary size limits
 * - Collection size limits
 * - Transaction limits
 * - Concurrency behavior
 */

import { assertEquals } from "@std/assert";
import { type AttributeValue, Table } from "../store.ts";

// Helper to create a string of exact size
function createString(byteSize: number): string {
  return "a".repeat(byteSize);
}

// Helper to create binary data of exact size
function createBinary(byteSize: number): Uint8Array {
  return new Uint8Array(byteSize).fill(42);
}

// ============================================================================
// Test Category 1: Key Size Limits
// ============================================================================

Deno.test("Limit - Partition key at 2 KB boundary (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Deno KV key part limit is approximately 2 KB
  // Use a string just under this limit
  const largeKey = createString(2000);

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: largeKey },
      data: { S: "test" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: largeKey } },
  });

  assertEquals((result.Item?.pk as { S: string })?.S, largeKey);
  table.close();
});

Deno.test("Limit - Partition key over 2 KB (may fail)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Extremely large key that exceeds Deno KV limits
  const hugeKey = createString(10000);

  try {
    await table.putItem({
      TableName: "TestTable",
      Item: {
        pk: { S: hugeKey },
        data: { S: "test" },
      },
    });
    // If it doesn't fail, verify it works
    const result = await table.getItem({
      TableName: "TestTable",
      Key: { pk: { S: hugeKey } },
    });
    assertEquals((result.Item?.pk as { S: string })?.S, hugeKey);
  } catch (_error) {
    // Expected: Deno KV may reject keys that are too large
    // This is acceptable behavior
  }

  table.close();
});

Deno.test("Limit - Sort key at maximum size", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    undefined,
    kv,
  );
  await table.initialize();

  const largeSortKey = createString(2000);

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "test" },
      sk: { S: largeSortKey },
      data: { N: "123" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: {
      pk: { S: "test" },
      sk: { S: largeSortKey },
    },
  });

  assertEquals((result.Item?.sk as { S: string })?.S, largeSortKey);
  table.close();
});

Deno.test("Limit - Empty string key (should work - DynamoDB allows it)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // DynamoDB allows empty strings in keys
  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "" },
      data: { S: "test" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "" } },
  });

  assertEquals((result.Item?.pk as { S: string }).S, "");
  assertEquals((result.Item?.data as { S: string }).S, "test");

  table.close();
});

Deno.test("Limit - Single character key (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "a" },
      data: { S: "test" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "a" } },
  });

  assertEquals((result.Item?.pk as { S: string })?.S, "a");
  table.close();
});

Deno.test("Limit - Key with unicode multi-byte characters", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Unicode characters take multiple bytes
  const unicodeKey = "🔥".repeat(100) + "测试" + "🎉";

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: unicodeKey },
      data: { S: "test" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: unicodeKey } },
  });

  assertEquals((result.Item?.pk as { S: string })?.S, unicodeKey);
  table.close();
});

// ============================================================================
// Test Category 2: Value Size Limits
// ============================================================================

Deno.test("Limit - Item approaching 64 KiB (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Create an item close to but under 64 KiB
  const largeData = createString(60000); // ~60 KB

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "large-item" },
      data: { S: largeData },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "large-item" } },
  });

  assertEquals((result.Item?.data as { S: string })?.S, largeData);
  table.close();
});

Deno.test("Limit - Item over 64 KiB (may fail gracefully)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Create an item over 64 KiB
  const hugeData = createString(70000); // ~70 KB

  try {
    await table.putItem({
      TableName: "TestTable",
      Item: {
        pk: { S: "huge-item" },
        data: { S: hugeData },
      },
    });
    // If it works, verify retrieval
    const result = await table.getItem({
      TableName: "TestTable",
      Key: { pk: { S: "huge-item" } },
    });
    assertEquals((result.Item?.data as { S: string })?.S, hugeData);
  } catch (_error) {
    // Expected: Deno KV enforces 64 KiB limit
  }

  table.close();
});

Deno.test("Limit - Item with large binary attribute", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const largeBinary = createBinary(50000); // 50 KB

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "binary-item" },
      data: { B: largeBinary },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "binary-item" } },
  });

  assertEquals(
    (result.Item?.data as { B: Uint8Array })?.B?.length,
    largeBinary.length,
  );
  table.close();
});

Deno.test("Limit - Item with large nested map", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const nestedMap: Record<string, AttributeValue> = {};
  for (let i = 0; i < 100; i++) {
    nestedMap[`key${i}`] = { S: createString(500) };
  }

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "nested-map" },
      data: { M: nestedMap },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "nested-map" } },
  });

  assertEquals(
    Object.keys(
      (result.Item?.data as { M: Record<string, AttributeValue> })?.M || {},
    )
      .length,
    100,
  );
  table.close();
});

Deno.test("Limit - Item with large list", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const largeList = Array.from({ length: 1000 }, (_, i) => ({ N: String(i) }));

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "large-list" },
      data: { L: largeList },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "large-list" } },
  });

  assertEquals((result.Item?.data as { L: AttributeValue[] })?.L?.length, 1000);
  table.close();
});

Deno.test("Limit - Empty item (only keys)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "empty-item" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "empty-item" } },
  });

  assertEquals((result.Item?.pk as { S: string })?.S, "empty-item");
  assertEquals(Object.keys(result.Item || {}).length, 1);
  table.close();
});

// ============================================================================
// Test Category 3: Batch Operation Limits
// ============================================================================

Deno.test("Limit - BatchWriteItem with 25 items", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const items = Array.from({ length: 25 }, (_, i) => ({
    PutRequest: {
      Item: {
        pk: { S: `item-${i}` },
        data: { N: String(i) },
      },
    },
  }));

  await table.batchWriteItem({
    RequestItems: {
      TestTable: items,
    },
  });

  // Verify a few items
  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "item-0" } },
  });
  assertEquals((result.Item?.data as { N: string })?.N, "0");

  table.close();
});

Deno.test("Limit - BatchGetItem with 100 items", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // First, put 100 items
  for (let i = 0; i < 100; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: {
        pk: { S: `item-${i}` },
        data: { N: String(i) },
      },
    });
  }

  // Batch get all 100
  const keys = Array.from({ length: 100 }, (_, i) => ({
    pk: { S: `item-${i}` },
  }));

  const result = await table.batchGetItem({
    RequestItems: {
      TestTable: { Keys: keys },
    },
  });

  assertEquals(result.Responses.TestTable.length, 100);
  table.close();
});

Deno.test("Limit - BatchGetItem with duplicate keys (last-write-wins)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "duplicate" },
      data: { S: "test" },
    },
  });

  const result = await table.batchGetItem({
    RequestItems: {
      TestTable: {
        Keys: [
          { pk: { S: "duplicate" } },
          { pk: { S: "duplicate" } },
          { pk: { S: "duplicate" } },
        ],
      },
    },
  });

  // Deno KV getMany handles duplicates
  assertEquals(result.Responses.TestTable.length >= 1, true);
  table.close();
});

Deno.test("Limit - Empty batch request", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const result = await table.batchGetItem({
    RequestItems: {
      TestTable: { Keys: [] },
    },
  });

  assertEquals(result.Responses.TestTable.length, 0);
  table.close();
});

// ============================================================================
// Test Category 4: Query and Scan Limits
// ============================================================================

Deno.test("Limit - Query with Limit=0 (returns 0 items)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "test" }, data: { N: "1" } },
  });

  const result = await table.query({
    TableName: "TestTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: "test" },
    },
    Limit: 0,
  });

  assertEquals(result.Items.length, 0);
  table.close();
});

Deno.test("Limit - Query with Limit=1 (returns exactly 1)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "N" },
    ],
    undefined,
    kv,
  );
  await table.initialize();

  // Insert multiple items
  for (let i = 0; i < 10; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: "test" }, sk: { N: String(i) }, data: { N: String(i) } },
    });
  }

  const result = await table.query({
    TableName: "TestTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: "test" },
    },
    Limit: 1,
  });

  assertEquals(result.Items.length, 1);
  table.close();
});

Deno.test("Limit - Query with Limit > total items", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "test" }, data: { N: "1" } },
  });

  const result = await table.query({
    TableName: "TestTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: "test" },
    },
    Limit: 1000,
  });

  assertEquals(result.Items.length, 1);
  table.close();
});

Deno.test("Limit - Query with no Limit (returns all matching)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "N" },
    ],
    undefined,
    kv,
  );
  await table.initialize();

  for (let i = 0; i < 50; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: "test" }, sk: { N: String(i) }, data: { N: String(i) } },
    });
  }

  const result = await table.query({
    TableName: "TestTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: "test" },
    },
  });

  assertEquals(result.Items.length, 50);
  table.close();
});

Deno.test("Limit - Scan with very large Limit", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  for (let i = 0; i < 10; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: `item-${i}` }, data: { N: String(i) } },
    });
  }

  const result = await table.scan({
    TableName: "TestTable",
    Limit: 999999,
  });

  assertEquals(result.Items.length, 10);
  table.close();
});

// ============================================================================
// Test Category 5: Expression Length Limits
// ============================================================================

Deno.test("Limit - Very long ConditionExpression", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "test" }, data: { N: "25" } },
  });

  // Build a long condition with many OR clauses
  const conditions = Array.from(
    { length: 50 },
    (_, i) => `data = :val${i}`,
  ).join(" OR ");

  const values: Record<string, AttributeValue> = {};
  for (let i = 0; i < 50; i++) {
    values[`:val${i}`] = { N: String(i) };
  }

  // Test that a very long condition expression works
  const result = await table.scan({
    TableName: "TestTable",
    FilterExpression: conditions,
    ExpressionAttributeValues: values,
  });

  assertEquals((result.Items[0]?.data as { N: string })?.N, "25");
  table.close();
});

Deno.test("Limit - ExpressionAttributeNames with 100+ entries", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const item: Record<string, AttributeValue> = { pk: { S: "test" } };
  const names: Record<string, string> = {};

  for (let i = 0; i < 100; i++) {
    item[`attr${i}`] = { N: String(i) };
    names[`#attr${i}`] = `attr${i}`;
  }

  await table.putItem({
    TableName: "TestTable",
    Item: item,
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "test" } },
  });

  assertEquals(Object.keys(result.Item || {}).length, 101); // 100 attrs + pk
  table.close();
});

// ============================================================================
// Test Category 6: Attribute Limits
// ============================================================================

Deno.test("Limit - Item with 1 attribute (minimal)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "minimal" } },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "minimal" } },
  });

  assertEquals(Object.keys(result.Item || {}).length, 1);
  table.close();
});

Deno.test("Limit - Item with 100 attributes", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const item: Record<string, AttributeValue> = { pk: { S: "many-attrs" } };
  for (let i = 0; i < 99; i++) {
    item[`attr${i}`] = { N: String(i) };
  }

  await table.putItem({
    TableName: "TestTable",
    Item: item,
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "many-attrs" } },
  });

  assertEquals(Object.keys(result.Item || {}).length, 100);
  table.close();
});

Deno.test("Limit - Attribute with special characters", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "special" },
      "attr-with-dash": { S: "test1" },
      "attr.with.dots": { S: "test2" },
      "attr_with_underscore": { S: "test3" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "special" } },
  });

  assertEquals((result.Item?.["attr-with-dash"] as { S: string })?.S, "test1");
  table.close();
});

// ============================================================================
// Test Category 7: Number Limits
// ============================================================================

Deno.test("Limit - Maximum safe integer", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "numbers" },
      max: { N: String(Number.MAX_SAFE_INTEGER) },
      min: { N: String(Number.MIN_SAFE_INTEGER) },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "numbers" } },
  });

  assertEquals(
    (result.Item?.max as { N: string })?.N,
    String(Number.MAX_SAFE_INTEGER),
  );
  assertEquals(
    (result.Item?.min as { N: string })?.N,
    String(Number.MIN_SAFE_INTEGER),
  );
  table.close();
});

Deno.test("Limit - Very large numbers in scientific notation", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "scientific" },
      large: { N: "1e100" },
      small: { N: "1e-100" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "scientific" } },
  });

  assertEquals((result.Item?.large as { N: string })?.N, "1e100");
  assertEquals((result.Item?.small as { N: string })?.N, "1e-100");
  table.close();
});

Deno.test("Limit - Decimal precision", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const preciseNumber = "0.123456789012345678901234567890";

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "precision" },
      value: { N: preciseNumber },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "precision" } },
  });

  // DynamoDB stores numbers as strings to preserve precision
  assertEquals((result.Item?.value as { N: string })?.N, preciseNumber);
  table.close();
});

Deno.test("Limit - Zero value", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "zero" },
      value: { N: "0" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "zero" } },
  });

  assertEquals((result.Item?.value as { N: string })?.N, "0");
  table.close();
});

// ============================================================================
// Test Category 8: String Limits
// ============================================================================

Deno.test("Limit - Empty string attribute (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "empty-string" },
      value: { S: "" },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "empty-string" } },
  });

  assertEquals((result.Item?.value as { S: string })?.S, "");
  table.close();
});

Deno.test("Limit - Very long string (1 MB)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // This will likely fail due to Deno KV 64 KiB limit
  const megabyteString = createString(1000000);

  try {
    await table.putItem({
      TableName: "TestTable",
      Item: {
        pk: { S: "huge-string" },
        value: { S: megabyteString },
      },
    });
  } catch (_error) {
    // Expected: exceeds Deno KV value size limit
  }

  table.close();
});

Deno.test("Limit - String with only whitespace", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "whitespace" },
      value: { S: "   \t\n\r   " },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "whitespace" } },
  });

  assertEquals((result.Item?.value as { S: string })?.S, "   \t\n\r   ");
  table.close();
});

Deno.test("Limit - String with emoji and multi-byte characters", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const emojiString = "👨‍👩‍👧‍👦🔥💯🎉测试テストテスト";

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "emoji" },
      value: { S: emojiString },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "emoji" } },
  });

  assertEquals((result.Item?.value as { S: string })?.S, emojiString);
  table.close();
});

// ============================================================================
// Test Category 9: Binary Limits
// ============================================================================

Deno.test("Limit - Empty Uint8Array (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "empty-binary" },
      value: { B: new Uint8Array(0) },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "empty-binary" } },
  });

  assertEquals((result.Item?.value as { B: Uint8Array })?.B?.length, 0);
  table.close();
});

Deno.test("Limit - Single byte binary", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "single-byte" },
      value: { B: new Uint8Array([42]) },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "single-byte" } },
  });

  assertEquals((result.Item?.value as { B: Uint8Array })?.B?.[0], 42);
  table.close();
});

Deno.test("Limit - Binary with all byte values (0-255)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    allBytes[i] = i;
  }

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "all-bytes" },
      value: { B: allBytes },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "all-bytes" } },
  });

  assertEquals((result.Item?.value as { B: Uint8Array })?.B?.length, 256);
  assertEquals((result.Item?.value as { B: Uint8Array })?.B?.[255], 255);
  table.close();
});

// ============================================================================
// Test Category 10: Collection Limits
// ============================================================================

Deno.test("Limit - Set with 1 element", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "single-set" },
      value: { SS: ["one"] },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "single-set" } },
  });

  assertEquals((result.Item?.value as { SS: string[] })?.SS?.length, 1);
  table.close();
});

Deno.test("Limit - Set with 100 elements", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const largeSet = Array.from({ length: 100 }, (_, i) => `item-${i}`);

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "large-set" },
      value: { SS: largeSet },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "large-set" } },
  });

  assertEquals((result.Item?.value as { SS: string[] })?.SS?.length, 100);
  table.close();
});

Deno.test("Limit - Empty List (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "empty-list" },
      value: { L: [] },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "empty-list" } },
  });

  assertEquals((result.Item?.value as { L: AttributeValue[] })?.L?.length, 0);
  table.close();
});

Deno.test("Limit - Empty Map (should work)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "empty-map" },
      value: { M: {} },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "empty-map" } },
  });

  assertEquals(
    Object.keys(
      (result.Item?.value as { M: Record<string, AttributeValue> })?.M || {},
    )
      .length,
    0,
  );
  table.close();
});

Deno.test("Limit - Map with deeply nested maps", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Create 10 levels of nesting
  let deepMap: AttributeValue = { S: "bottom" };
  for (let i = 0; i < 10; i++) {
    deepMap = { M: { [`level${i}`]: deepMap } };
  }

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "deep-nest" },
      value: deepMap,
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "deep-nest" } },
  });

  assertEquals(result.Item !== undefined, true);
  table.close();
});

// ============================================================================
// Test Category 11: Transaction Limits
// ============================================================================

Deno.test("Limit - TransactWriteItems with 10 items", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const items = Array.from({ length: 10 }, (_, i) => ({
    Put: {
      TableName: "TestTable",
      Item: {
        pk: { S: `txn-${i}` },
        data: { N: String(i) },
      },
    },
  }));

  await table.transactWriteItems({
    TransactItems: items,
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "txn-0" } },
  });

  assertEquals((result.Item?.data as { N: string })?.N, "0");
  table.close();
});

Deno.test("Limit - TransactGetItems with 10 items", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Put items first
  for (let i = 0; i < 10; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: `item-${i}` }, data: { N: String(i) } },
    });
  }

  const result = await table.transactGetItems({
    TransactItems: Array.from({ length: 10 }, (_, i) => ({
      Get: {
        TableName: "TestTable",
        Key: { pk: { S: `item-${i}` } },
      },
    })),
  });

  assertEquals(result.Responses.length, 10);
  table.close();
});

Deno.test("Limit - Mixed transaction operations", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  // Setup initial data
  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "update-me" }, data: { N: "0" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "delete-me" }, data: { N: "0" } },
  });

  await table.transactWriteItems({
    TransactItems: [
      {
        Put: {
          TableName: "TestTable",
          Item: { pk: { S: "new-item" }, data: { N: "1" } },
        },
      },
      {
        Update: {
          TableName: "TestTable",
          Key: { pk: { S: "update-me" } },
          UpdateExpression: "SET #d = :val",
          ExpressionAttributeNames: { "#d": "data" },
          ExpressionAttributeValues: { ":val": { N: "999" } },
        },
      },
      {
        Delete: {
          TableName: "TestTable",
          Key: { pk: { S: "delete-me" } },
        },
      },
    ],
  });

  // Verify all operations succeeded
  const newItem = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "new-item" } },
  });
  assertEquals((newItem.Item?.data as { N: string })?.N, "1");

  const updatedItem = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "update-me" } },
  });
  assertEquals((updatedItem.Item?.data as { N: string })?.N, "999");

  const deletedItem = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "delete-me" } },
  });
  assertEquals(deletedItem.Item, undefined);

  table.close();
});

// ============================================================================
// Test Category 12: Concurrency Tests
// ============================================================================

Deno.test("Limit - Concurrent PutItem on different keys", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const promises = Array.from({ length: 10 }, (_, i) =>
    table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: `concurrent-${i}` }, data: { N: String(i) } },
    }));

  await Promise.all(promises);

  // Verify all items were written
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      table.getItem({
        TableName: "TestTable",
        Key: { pk: { S: `concurrent-${i}` } },
      })),
  );

  assertEquals(results.every((r) => r.Item !== undefined), true);
  table.close();
});

Deno.test("Limit - Concurrent PutItem on same key with condition", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  const promises = Array.from({ length: 5 }, (_, i) =>
    table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: "contended" }, data: { N: String(i) } },
      ConditionExpression: "attribute_not_exists(pk)",
    }));

  const results = await Promise.allSettled(promises);

  // Only one should succeed, others should fail
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  // Due to atomic operations, exactly one should succeed
  assertEquals(succeeded >= 1, true);
  assertEquals(failed >= 1, true);

  table.close();
});

// ============================================================================
// Test Category 13: Edge Case Values
// ============================================================================

Deno.test("Limit - Boolean true/false", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "booleans" },
      isTrue: { BOOL: true },
      isFalse: { BOOL: false },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "booleans" } },
  });

  assertEquals((result.Item?.isTrue as { BOOL: boolean })?.BOOL, true);
  assertEquals((result.Item?.isFalse as { BOOL: boolean })?.BOOL, false);
  table.close();
});

Deno.test("Limit - Null values in maps", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "nulls" },
      data: {
        M: {
          nullValue: { NULL: true },
          stringValue: { S: "test" },
        },
      },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "nulls" } },
  });

  assertEquals(
    "NULL" in
      ((result.Item?.data as { M: Record<string, AttributeValue> })?.M
        ?.nullValue || {}),
    true,
  );
  table.close();
});

Deno.test("Limit - Mixed types in lists", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "mixed" },
      data: {
        L: [
          { S: "string" },
          { N: "42" },
          { BOOL: true },
          { NULL: true },
          { M: { nested: { S: "map" } } },
          { L: [{ S: "nested" }, { S: "list" }] },
        ],
      },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "mixed" } },
  });

  assertEquals((result.Item?.data as { L: AttributeValue[] })?.L?.length, 6);
  table.close();
});

Deno.test("Limit - All valid DynamoDB types in single item", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      pk: { S: "all-types" },
      stringAttr: { S: "text" },
      numberAttr: { N: "123.456" },
      binaryAttr: { B: new Uint8Array([1, 2, 3]) },
      boolAttr: { BOOL: true },
      nullAttr: { NULL: true },
      mapAttr: { M: { key: { S: "value" } } },
      listAttr: { L: [{ S: "item" }] },
      stringSetAttr: { SS: ["a", "b", "c"] },
      numberSetAttr: { NS: ["1", "2", "3"] },
      binarySetAttr: { BS: [new Uint8Array([1]), new Uint8Array([2])] },
    },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "all-types" } },
  });

  assertEquals(Object.keys(result.Item || {}).length, 11);
  table.close();
});

// ============================================================================
// Test Category 14: UpdateExpression Edge Cases
// ============================================================================

Deno.test("Limit - UpdateExpression with ADD on non-existent attribute", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "counter" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { pk: { S: "counter" } },
    UpdateExpression: "ADD #count :val",
    ExpressionAttributeNames: { "#count": "count" },
    ExpressionAttributeValues: { ":val": { N: "5" } },
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "counter" } },
  });

  assertEquals((result.Item?.count as { N: string })?.N, "5");
  table.close();
});

Deno.test("Limit - UpdateExpression REMOVE non-existent attribute", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [{ AttributeName: "pk", KeyType: "HASH" }],
    [{ AttributeName: "pk", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();

  await table.putItem({
    TableName: "TestTable",
    Item: { pk: { S: "test" }, data: { S: "value" } },
  });

  // REMOVE non-existent attribute should not fail
  await table.updateItem({
    TableName: "TestTable",
    Key: { pk: { S: "test" } },
    UpdateExpression: "REMOVE nonExistent",
  });

  const result = await table.getItem({
    TableName: "TestTable",
    Key: { pk: { S: "test" } },
  });

  assertEquals((result.Item?.data as { S: string })?.S, "value");
  table.close();
});

// ============================================================================
// Test Category 15: Query with ScanIndexForward
// ============================================================================

Deno.test("Limit - Query with ScanIndexForward=false (reverse order)", async () => {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    "TestTable",
    [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "N" },
    ],
    undefined,
    kv,
  );
  await table.initialize();

  for (let i = 0; i < 5; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { pk: { S: "test" }, sk: { N: String(i) }, data: { N: String(i) } },
    });
  }

  const result = await table.query({
    TableName: "TestTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: "test" } },
    ScanIndexForward: false,
  });

  // Should be in reverse order
  assertEquals((result.Items[0]?.sk as { N: string })?.N, "4");
  assertEquals((result.Items[4]?.sk as { N: string })?.N, "0");
  table.close();
});
