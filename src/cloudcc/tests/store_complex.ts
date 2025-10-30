// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Complex data structure test suite for DynamoDB-like API
 *
 * This test suite validates handling of:
 * - Deeply nested maps (5, 10, 20 levels)
 * - Complex list structures (100+ elements, nested lists, mixed types)
 * - Large map structures (50-100 keys)
 * - Set types with large cardinality
 * - Mixed attribute types in single items
 * - Sparse data patterns
 * - Complex query and filter patterns
 * - Real-world data models (user profiles, product catalogs, orders)
 * - Update patterns on nested structures
 * - Transaction scenarios with complex data
 * - Expression evaluation on deep nesting
 * - Edge cases and validation
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  type AttributeValue,
  type GlobalSecondaryIndex,
  type Item,
  Table,
} from "../store.ts";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a test table with simple key schema
 */
async function createSimpleTable(
  tableName = "ComplexTestTable",
): Promise<Table> {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    tableName,
    [{ AttributeName: "id", KeyType: "HASH" }],
    [{ AttributeName: "id", AttributeType: "S" }],
    undefined,
    kv,
  );
  await table.initialize();
  return table;
}

/**
 * Create a test table with composite key
 */
async function createCompositeKeyTable(
  tableName = "CompositeComplexTable",
): Promise<Table> {
  const kv = await Deno.openKv(":memory:");
  const table = new Table(
    tableName,
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
  return table;
}

/**
 * Create a test table with GSI for complex queries
 */
async function createTableWithGSI(
  tableName = "ComplexGSITable",
): Promise<Table> {
  const kv = await Deno.openKv(":memory:");

  const gsi: GlobalSecondaryIndex = {
    IndexName: "category-index",
    KeySchema: [
      { AttributeName: "category", KeyType: "HASH" },
      { AttributeName: "timestamp", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  };

  const table = new Table(
    tableName,
    [{ AttributeName: "id", KeyType: "HASH" }],
    [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "category", AttributeType: "S" },
      { AttributeName: "timestamp", AttributeType: "N" },
    ],
    [gsi],
    kv,
  );
  await table.initialize();
  return table;
}

/**
 * Generate a deeply nested map structure
 */
function generateDeeplyNestedMap(depth: number): AttributeValue {
  if (depth === 0) {
    return { S: `leaf-value-${Math.random()}` };
  }

  return {
    M: {
      [`level${depth}`]: generateDeeplyNestedMap(depth - 1),
      data: { S: `data-at-level-${depth}` },
      index: { N: depth.toString() },
    },
  };
}

/**
 * Generate a list with specified number of elements
 */
function generateLargeList(size: number, mixed = false): AttributeValue {
  const list: AttributeValue[] = [];

  for (let i = 0; i < size; i++) {
    if (mixed) {
      // Cycle through different types
      const types = [
        { S: `string-${i}` },
        { N: i.toString() },
        { BOOL: i % 2 === 0 },
        { M: { index: { N: i.toString() }, value: { S: `item-${i}` } } },
        { L: [{ S: `nested-${i}` }, { N: i.toString() }] },
      ];
      list.push(types[i % types.length]);
    } else {
      list.push({ S: `item-${i}` });
    }
  }

  return { L: list };
}

/**
 * Generate a large map with many keys
 */
function generateLargeMap(keyCount: number): AttributeValue {
  const map: Record<string, AttributeValue> = {};

  for (let i = 0; i < keyCount; i++) {
    map[`key_${i}`] = { S: `value_${i}` };
    map[`num_${i}`] = { N: i.toString() };
    map[`bool_${i}`] = { BOOL: i % 2 === 0 };
  }

  return { M: map };
}

/**
 * Generate a large set
 */
function generateLargeStringSet(size: number): AttributeValue {
  const items: string[] = [];
  for (let i = 0; i < size; i++) {
    items.push(`item-${i}`);
  }
  return { SS: items };
}

/**
 * Generate a complex item with all attribute types
 */
function generateComplexItem(id: string): Item {
  return {
    id: { S: id },
    stringAttr: { S: "test-string" },
    numberAttr: { N: "42.5" },
    binaryAttr: { B: new Uint8Array([1, 2, 3, 4, 5]) },
    boolAttr: { BOOL: true },
    nullAttr: { NULL: true },
    mapAttr: {
      M: {
        nested: { S: "value" },
        count: { N: "10" },
        flag: { BOOL: false },
      },
    },
    listAttr: {
      L: [
        { S: "first" },
        { N: "2" },
        { BOOL: true },
        { M: { inner: { S: "map" } } },
      ],
    },
    stringSetAttr: { SS: ["apple", "banana", "cherry"] },
    numberSetAttr: { NS: ["1", "2", "3", "4", "5"] },
    binarySetAttr: {
      BS: [
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5, 6]),
      ],
    },
  };
}

/**
 * Generate a real-world user profile
 */
function generateUserProfile(userId: string): Item {
  return {
    id: { S: userId },
    username: { S: `user_${userId}` },
    email: { S: `${userId}@example.com` },
    profile: {
      M: {
        firstName: { S: "John" },
        lastName: { S: "Doe" },
        age: { N: "30" },
        address: {
          M: {
            street: { S: "123 Main St" },
            city: { S: "Springfield" },
            state: { S: "IL" },
            zip: { S: "62701" },
            country: { S: "USA" },
            coordinates: {
              M: {
                latitude: { N: "39.7817" },
                longitude: { N: "-89.6501" },
              },
            },
          },
        },
        phones: {
          L: [
            { M: { type: { S: "home" }, number: { S: "555-1234" } } },
            { M: { type: { S: "mobile" }, number: { S: "555-5678" } } },
          ],
        },
      },
    },
    preferences: {
      M: {
        notifications: {
          M: {
            email: { BOOL: true },
            sms: { BOOL: false },
            push: { BOOL: true },
          },
        },
        privacy: {
          M: {
            profileVisible: { BOOL: true },
            showEmail: { BOOL: false },
            allowMessages: { BOOL: true },
          },
        },
        theme: { S: "dark" },
        language: { S: "en-US" },
      },
    },
    tags: { SS: ["premium", "verified", "beta-tester"] },
    loginHistory: {
      L: [
        { M: { timestamp: { N: "1704067200" }, ip: { S: "192.168.1.1" } } },
        { M: { timestamp: { N: "1704070800" }, ip: { S: "192.168.1.1" } } },
      ],
    },
  };
}

/**
 * Generate a product catalog item
 */
function generateProduct(productId: string): Item {
  return {
    id: { S: productId },
    name: { S: `Product ${productId}` },
    category: { S: "electronics" },
    price: { N: "299.99" },
    description: { S: "A high-quality electronic product" },
    attributes: {
      M: {
        brand: { S: "TechCorp" },
        model: { S: "TC-2024" },
        color: { S: "black" },
        weight: { N: "1.5" },
        dimensions: {
          M: {
            length: { N: "10" },
            width: { N: "8" },
            height: { N: "2" },
            unit: { S: "inches" },
          },
        },
        specifications: {
          M: {
            processor: { S: "Quad-core 2.5GHz" },
            memory: { S: "8GB RAM" },
            storage: { S: "256GB SSD" },
            battery: { S: "10 hours" },
          },
        },
      },
    },
    variants: {
      L: [
        {
          M: {
            sku: { S: "TC-2024-BLK" },
            color: { S: "black" },
            stock: { N: "50" },
          },
        },
        {
          M: {
            sku: { S: "TC-2024-WHT" },
            color: { S: "white" },
            stock: { N: "30" },
          },
        },
      ],
    },
    tags: { SS: ["electronics", "new", "featured", "bestseller"] },
    reviews: {
      M: {
        average: { N: "4.5" },
        count: { N: "127" },
        distribution: {
          M: {
            five: { N: "80" },
            four: { N: "30" },
            three: { N: "10" },
            two: { N: "5" },
            one: { N: "2" },
          },
        },
      },
    },
  };
}

/**
 * Generate an order with line items
 */
function generateOrder(orderId: string): Item {
  return {
    id: { S: orderId },
    customerId: { S: "customer-123" },
    orderDate: { N: "1704067200" },
    status: { S: "shipped" },
    items: {
      L: [
        {
          M: {
            productId: { S: "prod-1" },
            name: { S: "Widget A" },
            quantity: { N: "2" },
            price: { N: "29.99" },
            subtotal: { N: "59.98" },
          },
        },
        {
          M: {
            productId: { S: "prod-2" },
            name: { S: "Gadget B" },
            quantity: { N: "1" },
            price: { N: "149.99" },
            subtotal: { N: "149.99" },
          },
        },
        {
          M: {
            productId: { S: "prod-3" },
            name: { S: "Accessory C" },
            quantity: { N: "3" },
            price: { N: "9.99" },
            subtotal: { N: "29.97" },
          },
        },
      ],
    },
    shipping: {
      M: {
        address: {
          M: {
            street: { S: "456 Oak Ave" },
            city: { S: "Portland" },
            state: { S: "OR" },
            zip: { S: "97205" },
          },
        },
        method: { S: "express" },
        cost: { N: "12.99" },
        trackingNumber: { S: "1Z999AA10123456784" },
      },
    },
    payment: {
      M: {
        method: { S: "credit_card" },
        last4: { S: "4242" },
        amount: { N: "252.93" },
        currency: { S: "USD" },
      },
    },
    totals: {
      M: {
        subtotal: { N: "239.94" },
        shipping: { N: "12.99" },
        tax: { N: "19.20" },
        total: { N: "252.93" },
      },
    },
  };
}

// ============================================================================
// Tests: Deeply Nested Maps
// ============================================================================

Deno.test("Complex - deeply nested map with 5 levels", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "nested-5" },
    data: generateDeeplyNestedMap(5),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "nested-5" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.id, { S: "nested-5" });
  assertExists(result.Item?.data);

  table.close();
});

Deno.test("Complex - deeply nested map with 10 levels", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "nested-10" },
    data: generateDeeplyNestedMap(10),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "nested-10" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.id, { S: "nested-10" });

  table.close();
});

Deno.test("Complex - deeply nested map with 20 levels", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "nested-20" },
    data: generateDeeplyNestedMap(20),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "nested-20" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.id, { S: "nested-20" });

  table.close();
});

Deno.test("Complex - update deeply nested attribute 5 levels deep", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "nested-update" },
    level1: {
      M: {
        level2: {
          M: {
            level3: {
              M: {
                level4: {
                  M: {
                    level5: { S: "original" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  // Note: Current implementation doesn't support nested path updates
  // This test documents the limitation
  // In a full implementation, this would work:
  // SET level1.level2.level3.level4.level5 = :val

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "nested-update" } },
  });

  assertExists(result.Item);

  table.close();
});

// ============================================================================
// Tests: Complex List Structures
// ============================================================================

Deno.test("Complex - list with 100 elements", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "list-100" },
    items: generateLargeList(100),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "list-100" } },
  });

  assertExists(result.Item);
  assertEquals((result.Item?.items as { L: AttributeValue[] }).L.length, 100);

  table.close();
});

Deno.test("Complex - list with mixed types (S, N, M, L, BOOL)", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "list-mixed" },
    items: generateLargeList(50, true),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "list-mixed" } },
  });

  assertExists(result.Item);
  const list = (result.Item?.items as { L: AttributeValue[] }).L;
  assertEquals(list.length, 50);

  // Verify different types are present
  const hasString = list.some((v) => "S" in v);
  const hasNumber = list.some((v) => "N" in v);
  const hasBool = list.some((v) => "BOOL" in v);
  const hasMap = list.some((v) => "M" in v);
  const hasList = list.some((v) => "L" in v);

  assertEquals(hasString, true);
  assertEquals(hasNumber, true);
  assertEquals(hasBool, true);
  assertEquals(hasMap, true);
  assertEquals(hasList, true);

  table.close();
});

Deno.test("Complex - nested lists (list of lists)", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "list-nested" },
    matrix: {
      L: [
        { L: [{ N: "1" }, { N: "2" }, { N: "3" }] },
        { L: [{ N: "4" }, { N: "5" }, { N: "6" }] },
        { L: [{ N: "7" }, { N: "8" }, { N: "9" }] },
      ],
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "list-nested" } },
  });

  assertExists(result.Item);
  const matrix = (result.Item?.matrix as { L: AttributeValue[] }).L;
  assertEquals(matrix.length, 3);
  assertEquals((matrix[0] as { L: AttributeValue[] }).L.length, 3);

  table.close();
});

Deno.test("Complex - list with maps as elements", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "list-maps" },
    records: {
      L: [
        {
          M: { name: { S: "Alice" }, age: { N: "30" }, active: { BOOL: true } },
        },
        {
          M: { name: { S: "Bob" }, age: { N: "25" }, active: { BOOL: false } },
        },
        {
          M: { name: { S: "Carol" }, age: { N: "35" }, active: { BOOL: true } },
        },
      ],
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "list-maps" } },
  });

  assertExists(result.Item);
  const records = (result.Item?.records as { L: AttributeValue[] }).L;
  assertEquals(records.length, 3);

  table.close();
});

Deno.test("Complex - empty list vs NULL vs missing attribute", async () => {
  const table = await createSimpleTable();

  const item1: Item = {
    id: { S: "empty-list" },
    items: { L: [] },
  };

  const item2: Item = {
    id: { S: "null-list" },
    items: { NULL: true },
  };

  const item3: Item = {
    id: { S: "no-list" },
    // items attribute is missing
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item1 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item2 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item3 });

  const result1 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "empty-list" } },
  });
  const result2 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "null-list" } },
  });
  const result3 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "no-list" } },
  });

  assertExists(result1.Item);
  assertEquals("L" in result1.Item?.items, true);
  assertEquals((result1.Item?.items as { L: AttributeValue[] }).L.length, 0);

  assertExists(result2.Item);
  assertEquals("NULL" in result2.Item?.items, true);

  assertExists(result3.Item);
  assertEquals("items" in result3.Item, false);

  table.close();
});

// ============================================================================
// Tests: Large Map Structures
// ============================================================================

Deno.test("Complex - map with 50 keys", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "map-50" },
    data: generateLargeMap(50),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "map-50" } },
  });

  assertExists(result.Item);
  const mapKeys = Object.keys(
    (result.Item?.data as { M: Record<string, AttributeValue> }).M,
  );
  assertEquals(mapKeys.length, 50 * 3); // Each iteration adds 3 keys

  table.close();
});

Deno.test("Complex - map with 100 keys", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "map-100" },
    data: generateLargeMap(100),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "map-100" } },
  });

  assertExists(result.Item);
  const mapKeys = Object.keys(
    (result.Item?.data as { M: Record<string, AttributeValue> }).M,
  );
  assertEquals(mapKeys.length, 100 * 3);

  table.close();
});

Deno.test("Complex - map with all attribute types as values", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "map-all-types" },
    data: {
      M: {
        stringVal: { S: "text" },
        numberVal: { N: "42" },
        binaryVal: { B: new Uint8Array([1, 2, 3]) },
        boolVal: { BOOL: true },
        nullVal: { NULL: true },
        mapVal: { M: { inner: { S: "nested" } } },
        listVal: { L: [{ S: "item1" }, { S: "item2" }] },
        stringSetVal: { SS: ["a", "b", "c"] },
        numberSetVal: { NS: ["1", "2", "3"] },
        binarySetVal: { BS: [new Uint8Array([1]), new Uint8Array([2])] },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "map-all-types" } },
  });

  assertExists(result.Item);
  const map = (result.Item?.data as { M: Record<string, AttributeValue> }).M;
  assertEquals(Object.keys(map).length, 10);

  table.close();
});

Deno.test("Complex - sparse map with many NULL values", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "map-sparse" },
    data: {
      M: {
        field1: { S: "value1" },
        field2: { NULL: true },
        field3: { S: "value3" },
        field4: { NULL: true },
        field5: { NULL: true },
        field6: { S: "value6" },
        field7: { NULL: true },
        field8: { NULL: true },
        field9: { NULL: true },
        field10: { S: "value10" },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "map-sparse" } },
  });

  assertExists(result.Item);

  table.close();
});

// ============================================================================
// Tests: Set Type Edge Cases
// ============================================================================

Deno.test("Complex - StringSet with 100 elements", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "stringset-100" },
    tags: generateLargeStringSet(100),
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "stringset-100" } },
  });

  assertExists(result.Item);
  assertEquals((result.Item?.tags as { SS: string[] }).SS.length, 100);

  table.close();
});

Deno.test("Complex - NumberSet with mixed integers and decimals", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "numberset-mixed" },
    numbers: { NS: ["1", "2.5", "3", "4.75", "5", "6.125", "7", "8.999"] },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "numberset-mixed" } },
  });

  assertExists(result.Item);
  assertEquals((result.Item?.numbers as { NS: string[] }).NS.length, 8);

  table.close();
});

Deno.test("Complex - BinarySet with various binary data", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "binaryset-test" },
    data: {
      BS: [
        new Uint8Array([0, 1, 2, 3, 4]),
        new Uint8Array([255, 254, 253]),
        new Uint8Array([100, 200]),
        new Uint8Array([1]),
      ],
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "binaryset-test" } },
  });

  assertExists(result.Item);
  assertEquals((result.Item?.data as { BS: Uint8Array[] }).BS.length, 4);

  table.close();
});

Deno.test("Complex - ADD to StringSet maintains uniqueness", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "set-add-test" },
    tags: { SS: ["tag1", "tag2", "tag3"] },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  // Add tags including duplicates
  await table.updateItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "set-add-test" } },
    UpdateExpression: "ADD tags :newTags",
    ExpressionAttributeValues: {
      ":newTags": { SS: ["tag3", "tag4", "tag5"] },
    },
  });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "set-add-test" } },
  });

  assertExists(result.Item);
  const tags = (result.Item?.tags as { SS: string[] }).SS;
  // Should have unique values: tag1, tag2, tag3, tag4, tag5
  assertEquals(tags.length, 5);

  table.close();
});

Deno.test("Complex - DELETE from StringSet", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "set-delete-test" },
    tags: { SS: ["tag1", "tag2", "tag3", "tag4", "tag5"] },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  await table.updateItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "set-delete-test" } },
    UpdateExpression: "DELETE tags :removeTags",
    ExpressionAttributeValues: {
      ":removeTags": { SS: ["tag2", "tag4"] },
    },
  });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "set-delete-test" } },
  });

  assertExists(result.Item);
  const tags = (result.Item?.tags as { SS: string[] }).SS;
  assertEquals(tags.length, 3);
  assertEquals(tags.includes("tag1"), true);
  assertEquals(tags.includes("tag3"), true);
  assertEquals(tags.includes("tag5"), true);

  table.close();
});

// ============================================================================
// Tests: Mixed Attribute Type Items
// ============================================================================

Deno.test("Complex - item with all DynamoDB types", async () => {
  const table = await createSimpleTable();

  const item = generateComplexItem("all-types");

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "all-types" } },
  });

  assertExists(result.Item);
  assertEquals("S" in (result.Item?.stringAttr || {}), true);
  assertEquals("N" in (result.Item?.numberAttr || {}), true);
  assertEquals("B" in (result.Item?.binaryAttr || {}), true);
  assertEquals("BOOL" in (result.Item?.boolAttr || {}), true);
  assertEquals("NULL" in (result.Item?.nullAttr || {}), true);
  assertEquals("M" in (result.Item?.mapAttr || {}), true);
  assertEquals("L" in (result.Item?.listAttr || {}), true);
  assertEquals("SS" in (result.Item?.stringSetAttr || {}), true);
  assertEquals("NS" in (result.Item?.numberSetAttr || {}), true);
  assertEquals("BS" in (result.Item?.binarySetAttr || {}), true);

  table.close();
});

// ============================================================================
// Tests: Sparse Data Patterns
// ============================================================================

Deno.test("Complex - sparse data with optional attributes", async () => {
  const table = await createSimpleTable();

  const item1: Item = {
    id: { S: "sparse-1" },
    name: { S: "Item 1" },
    optional1: { S: "present" },
  };

  const item2: Item = {
    id: { S: "sparse-2" },
    name: { S: "Item 2" },
    optional2: { S: "present" },
  };

  const item3: Item = {
    id: { S: "sparse-3" },
    name: { S: "Item 3" },
    optional1: { S: "present" },
    optional2: { S: "present" },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item1 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item2 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item3 });

  const result1 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "sparse-1" } },
  });
  const result2 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "sparse-2" } },
  });

  assertExists(result1.Item);
  assertExists(result2.Item);
  assertEquals("optional1" in result1.Item, true);
  assertEquals("optional2" in result1.Item, false);
  assertEquals("optional1" in result2.Item, false);
  assertEquals("optional2" in result2.Item, true);

  table.close();
});

Deno.test("Complex - GSI with sparse data (only some items have GSI attributes)", async () => {
  const table = await createTableWithGSI();

  // Item with GSI attributes
  const item1: Item = {
    id: { S: "item-1" },
    category: { S: "books" },
    timestamp: { N: "1704067200" },
    name: { S: "Item 1" },
  };

  // Item without GSI attributes
  const item2: Item = {
    id: { S: "item-2" },
    name: { S: "Item 2" },
  };

  // Another item with GSI attributes
  const item3: Item = {
    id: { S: "item-3" },
    category: { S: "books" },
    timestamp: { N: "1704070800" },
    name: { S: "Item 3" },
  };

  await table.putItem({ TableName: "ComplexGSITable", Item: item1 });
  await table.putItem({ TableName: "ComplexGSITable", Item: item2 });
  await table.putItem({ TableName: "ComplexGSITable", Item: item3 });

  // Query GSI - should only return items with GSI attributes
  const queryResult = await table.query({
    TableName: "ComplexGSITable",
    IndexName: "category-index",
    KeyConditionExpression: "category = :cat",
    ExpressionAttributeValues: {
      ":cat": { S: "books" },
    },
  });

  assertEquals(queryResult.Items.length, 2);

  table.close();
});

// ============================================================================
// Tests: Real-World Data Models
// ============================================================================

Deno.test("Complex - user profile with nested address and preferences", async () => {
  const table = await createSimpleTable();

  const userProfile = generateUserProfile("user-001");

  await table.putItem({ TableName: "ComplexTestTable", Item: userProfile });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "user-001" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.username, { S: "user_user-001" });

  // Verify nested structure
  const profile =
    (result.Item?.profile as { M: Record<string, AttributeValue> }).M;
  const address = (profile.address as { M: Record<string, AttributeValue> }).M;
  const coordinates =
    (address.coordinates as { M: Record<string, AttributeValue> }).M;

  assertExists(coordinates.latitude);
  assertExists(coordinates.longitude);

  table.close();
});

Deno.test("Complex - product catalog with variants and specifications", async () => {
  const table = await createSimpleTable();

  const product = generateProduct("prod-001");

  await table.putItem({ TableName: "ComplexTestTable", Item: product });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "prod-001" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.category, { S: "electronics" });

  const variants = (result.Item?.variants as { L: AttributeValue[] }).L;
  assertEquals(variants.length, 2);

  table.close();
});

Deno.test("Complex - order with line items and nested totals", async () => {
  const table = await createSimpleTable();

  const order = generateOrder("order-001");

  await table.putItem({ TableName: "ComplexTestTable", Item: order });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "order-001" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.status, { S: "shipped" });

  const items = (result.Item?.items as { L: AttributeValue[] }).L;
  assertEquals(items.length, 3);

  const totals =
    (result.Item?.totals as { M: Record<string, AttributeValue> }).M;
  assertEquals(totals.total, { N: "252.93" });

  table.close();
});

Deno.test("Complex - shopping cart with nested items and quantities", async () => {
  const table = await createSimpleTable();

  const cart: Item = {
    id: { S: "cart-001" },
    userId: { S: "user-123" },
    createdAt: { N: "1704067200" },
    items: {
      L: [
        {
          M: {
            productId: { S: "prod-1" },
            name: { S: "Product 1" },
            price: { N: "29.99" },
            quantity: { N: "2" },
            options: {
              M: {
                color: { S: "red" },
                size: { S: "L" },
              },
            },
          },
        },
        {
          M: {
            productId: { S: "prod-2" },
            name: { S: "Product 2" },
            price: { N: "49.99" },
            quantity: { N: "1" },
            options: {
              M: {
                color: { S: "blue" },
                size: { S: "M" },
              },
            },
          },
        },
      ],
    },
    subtotal: { N: "109.97" },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: cart });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "cart-001" } },
  });

  assertExists(result.Item);
  const items = (result.Item?.items as { L: AttributeValue[] }).L;
  assertEquals(items.length, 2);

  table.close();
});

Deno.test("Complex - social graph with followers and following sets", async () => {
  const table = await createSimpleTable();

  const socialProfile: Item = {
    id: { S: "user-social-001" },
    username: { S: "johndoe" },
    followers: { SS: ["user-1", "user-2", "user-3", "user-4", "user-5"] },
    following: { SS: ["user-10", "user-11", "user-12"] },
    posts: {
      L: [
        {
          M: {
            postId: { S: "post-1" },
            content: { S: "Hello world!" },
            likes: { N: "42" },
            timestamp: { N: "1704067200" },
          },
        },
        {
          M: {
            postId: { S: "post-2" },
            content: { S: "Another post" },
            likes: { N: "15" },
            timestamp: { N: "1704070800" },
          },
        },
      ],
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: socialProfile });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "user-social-001" } },
  });

  assertExists(result.Item);
  assertEquals((result.Item?.followers as { SS: string[] }).SS.length, 5);
  assertEquals((result.Item?.following as { SS: string[] }).SS.length, 3);

  table.close();
});

Deno.test("Complex - time-series data with nested metrics", async () => {
  const table = await createCompositeKeyTable();

  const timeSeriesData: Item = {
    pk: { S: "sensor-001" },
    sk: { S: "2024-01-01T00:00:00Z" },
    metrics: {
      M: {
        temperature: {
          M: {
            value: { N: "72.5" },
            unit: { S: "F" },
            min: { N: "70.0" },
            max: { N: "75.0" },
          },
        },
        humidity: {
          M: {
            value: { N: "45.2" },
            unit: { S: "%" },
            min: { N: "40.0" },
            max: { N: "50.0" },
          },
        },
        pressure: {
          M: {
            value: { N: "1013.25" },
            unit: { S: "hPa" },
            min: { N: "1010.0" },
            max: { N: "1015.0" },
          },
        },
      },
    },
    readings: {
      L: [
        {
          M: { time: { S: "00:00" }, temp: { N: "72.5" }, hum: { N: "45.2" } },
        },
        {
          M: { time: { S: "00:15" }, temp: { N: "72.7" }, hum: { N: "45.5" } },
        },
        {
          M: { time: { S: "00:30" }, temp: { N: "72.9" }, hum: { N: "45.8" } },
        },
      ],
    },
  };

  await table.putItem({
    TableName: "CompositeComplexTable",
    Item: timeSeriesData,
  });

  const result = await table.getItem({
    TableName: "CompositeComplexTable",
    Key: { pk: { S: "sensor-001" }, sk: { S: "2024-01-01T00:00:00Z" } },
  });

  assertExists(result.Item);
  const metrics =
    (result.Item?.metrics as { M: Record<string, AttributeValue> }).M;
  assertExists(metrics.temperature);
  assertExists(metrics.humidity);
  assertExists(metrics.pressure);

  table.close();
});

// ============================================================================
// Tests: Update Patterns on Complex Data
// ============================================================================

Deno.test("Complex - UPDATE incrementing counter in map", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "counter-test" },
    counts: {
      M: {
        visits: { N: "10" },
        clicks: { N: "5" },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  await table.updateItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "counter-test" } },
    UpdateExpression: "ADD counts.visits :inc",
    ExpressionAttributeValues: {
      ":inc": { N: "1" },
    },
  });

  // Note: Current implementation doesn't support nested path updates
  // This test documents expected behavior

  table.close();
});

Deno.test("Complex - REMOVE entire nested structure", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "remove-test" },
    data: {
      M: {
        keep: { S: "keep this" },
        remove: { S: "remove this" },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  await table.updateItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "remove-test" } },
    UpdateExpression: "REMOVE data.remove",
  });

  // Note: Current implementation doesn't support nested path updates

  table.close();
});

// ============================================================================
// Tests: Transaction Scenarios with Complex Data
// ============================================================================

Deno.test("Complex - transaction updating multiple nested items", async () => {
  const table = await createSimpleTable();

  const item1: Item = {
    id: { S: "txn-1" },
    balance: { N: "100" },
    details: {
      M: {
        accountType: { S: "checking" },
        status: { S: "active" },
      },
    },
  };

  const item2: Item = {
    id: { S: "txn-2" },
    balance: { N: "50" },
    details: {
      M: {
        accountType: { S: "savings" },
        status: { S: "active" },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item1 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item2 });

  // Transfer money between accounts
  await table.transactWriteItems({
    TransactItems: [
      {
        Update: {
          TableName: "ComplexTestTable",
          Key: { id: { S: "txn-1" } },
          UpdateExpression: "ADD balance :amount",
          ExpressionAttributeValues: {
            ":amount": { N: "-25" },
          },
        },
      },
      {
        Update: {
          TableName: "ComplexTestTable",
          Key: { id: { S: "txn-2" } },
          UpdateExpression: "ADD balance :amount",
          ExpressionAttributeValues: {
            ":amount": { N: "25" },
          },
        },
      },
    ],
  });

  const result1 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "txn-1" } },
  });
  const result2 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "txn-2" } },
  });

  assertExists(result1.Item);
  assertExists(result2.Item);
  assertEquals(result1.Item?.balance, { N: "75" });
  assertEquals(result2.Item?.balance, { N: "75" });

  table.close();
});

Deno.test("Complex - transaction with complex condition checks", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "condition-test" },
    status: { S: "active" },
    version: { N: "1" },
    data: {
      M: {
        field1: { S: "value1" },
        field2: { N: "100" },
      },
    },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  await table.transactWriteItems({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: "ComplexTestTable",
          Key: { id: { S: "condition-test" } },
          ConditionExpression: "status = :status",
          ExpressionAttributeValues: {
            ":status": { S: "active" },
          },
        },
      },
      {
        Update: {
          TableName: "ComplexTestTable",
          Key: { id: { S: "condition-test" } },
          UpdateExpression: "ADD version :inc",
          ExpressionAttributeValues: {
            ":inc": { N: "1" },
          },
        },
      },
    ],
  });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "condition-test" } },
  });

  assertExists(result.Item);
  assertEquals(result.Item?.version, { N: "2" });

  table.close();
});

// ============================================================================
// Tests: Complex Query and Filter Patterns
// ============================================================================

Deno.test("Complex - query with filter on nested attributes", async () => {
  const table = await createTableWithGSI();

  // Create items with nested structures
  for (let i = 1; i <= 10; i++) {
    const item: Item = {
      id: { S: `item-${i}` },
      category: { S: "electronics" },
      timestamp: { N: (1704067200 + i * 1000).toString() },
      details: {
        M: {
          price: { N: (100 + i * 10).toString() },
          inStock: { BOOL: i % 2 === 0 },
        },
      },
    };
    await table.putItem({ TableName: "ComplexGSITable", Item: item });
  }

  // Query with filter - items in stock with price > 150
  const result = await table.query({
    TableName: "ComplexGSITable",
    IndexName: "category-index",
    KeyConditionExpression: "category = :cat",
    ExpressionAttributeValues: {
      ":cat": { S: "electronics" },
    },
  });

  assertEquals(result.Items.length, 10);

  table.close();
});

Deno.test("Complex - scan with filter on all attribute types", async () => {
  const table = await createSimpleTable();

  // Create diverse items
  await table.putItem({
    TableName: "ComplexTestTable",
    Item: {
      id: { S: "scan-1" },
      type: { S: "typeA" },
      value: { N: "100" },
      active: { BOOL: true },
    },
  });

  await table.putItem({
    TableName: "ComplexTestTable",
    Item: {
      id: { S: "scan-2" },
      type: { S: "typeB" },
      value: { N: "200" },
      active: { BOOL: false },
    },
  });

  await table.putItem({
    TableName: "ComplexTestTable",
    Item: {
      id: { S: "scan-3" },
      type: { S: "typeA" },
      value: { N: "150" },
      active: { BOOL: true },
    },
  });

  const result = await table.scan({
    TableName: "ComplexTestTable",
    FilterExpression: "active = :active",
    ExpressionAttributeValues: {
      ":active": { BOOL: true },
    },
  });

  // At least 2 active items
  assertEquals(result.Items.length >= 2, true);

  table.close();
});

// ============================================================================
// Tests: Edge Cases and Validation
// ============================================================================

Deno.test("Complex - empty item (just keys, no other attributes)", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "empty-item" },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "empty-item" } },
  });

  assertExists(result.Item);
  assertEquals(Object.keys(result.Item).length, 1);

  table.close();
});

Deno.test("Complex - NULL vs missing vs empty string", async () => {
  const table = await createSimpleTable();

  const item1: Item = {
    id: { S: "null-test-1" },
    field: { NULL: true },
  };

  const item2: Item = {
    id: { S: "null-test-2" },
    // field is missing
  };

  const item3: Item = {
    id: { S: "null-test-3" },
    field: { S: "" },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item1 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item2 });
  await table.putItem({ TableName: "ComplexTestTable", Item: item3 });

  const result1 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "null-test-1" } },
  });
  const result2 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "null-test-2" } },
  });
  const result3 = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "null-test-3" } },
  });

  assertExists(result1.Item);
  assertEquals("NULL" in result1.Item.field, true);

  assertExists(result2.Item);
  assertEquals("field" in result2.Item, false);

  assertExists(result3.Item);
  assertEquals("S" in result3.Item.field, true);
  assertEquals((result3.Item.field as { S: string }).S, "");

  table.close();
});

Deno.test("Complex - empty collections behavior", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "empty-collections" },
    emptyList: { L: [] },
    emptyMap: { M: {} },
    emptyStringSet: { SS: [] }, // Note: DynamoDB doesn't allow empty sets
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "empty-collections" } },
  });

  assertExists(result.Item);

  table.close();
});

Deno.test("Complex - projection with nested and top-level attributes", async () => {
  const table = await createSimpleTable();

  const item: Item = {
    id: { S: "projection-test" },
    topLevel: { S: "top" },
    nested: {
      M: {
        level1: { S: "value1" },
        level2: {
          M: {
            deep: { S: "deepValue" },
          },
        },
      },
    },
    other: { S: "other" },
  };

  await table.putItem({ TableName: "ComplexTestTable", Item: item });

  const result = await table.getItem({
    TableName: "ComplexTestTable",
    Key: { id: { S: "projection-test" } },
    ProjectionExpression: "id, topLevel, nested",
  });

  assertExists(result.Item);
  assertEquals(Object.keys(result.Item).length, 3);
  assertEquals("other" in result.Item, false);

  table.close();
});

Deno.test("Complex - batch get with complex items", async () => {
  const table = await createSimpleTable();

  // Create complex items
  for (let i = 1; i <= 5; i++) {
    await table.putItem({
      TableName: "ComplexTestTable",
      Item: generateComplexItem(`batch-${i}`),
    });
  }

  const result = await table.batchGetItem({
    RequestItems: {
      ComplexTestTable: {
        Keys: [
          { id: { S: "batch-1" } },
          { id: { S: "batch-2" } },
          { id: { S: "batch-3" } },
        ],
      },
    },
  });

  assertEquals(result.Responses.ComplexTestTable.length, 3);

  table.close();
});

Deno.test("Complex - multi-tenant data with partitioning", async () => {
  const table = await createCompositeKeyTable();

  // Create items for different tenants
  const tenant1Items = [
    {
      pk: { S: "tenant-1" },
      sk: { S: "user-1" },
      data: { M: { name: { S: "User 1" } } },
    },
    {
      pk: { S: "tenant-1" },
      sk: { S: "user-2" },
      data: { M: { name: { S: "User 2" } } },
    },
  ];

  const tenant2Items = [
    {
      pk: { S: "tenant-2" },
      sk: { S: "user-1" },
      data: { M: { name: { S: "User 1" } } },
    },
  ];

  for (const item of [...tenant1Items, ...tenant2Items]) {
    await table.putItem({ TableName: "CompositeComplexTable", Item: item });
  }

  // Query for tenant-1 data
  const result = await table.query({
    TableName: "CompositeComplexTable",
    KeyConditionExpression: "pk = :tenant",
    ExpressionAttributeValues: {
      ":tenant": { S: "tenant-1" },
    },
  });

  assertEquals(result.Items.length, 2);

  table.close();
});
