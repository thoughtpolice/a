// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Comprehensive test suite for DynamoDB-like API implementation
 *
 * This test suite validates all functionality of the store.ts implementation including:
 * - Core CRUD operations (GetItem, PutItem, UpdateItem, DeleteItem)
 * - Query and Scan operations
 * - Expression evaluation (Condition, Update, KeyCondition)
 * - Secondary indexes (GSI)
 * - Batch operations
 * - Transactions
 * - Error handling and edge cases
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  ConditionalCheckFailedException,
  type GlobalSecondaryIndex,
  type Item,
  ResourceNotFoundException,
  Table,
  TransactionCanceledException,
  ValidationException,
} from "../store.ts";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a test table with simple key schema (partition key only)
 */
async function createSimpleTable(tableName = "TestTable"): Promise<Table> {
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
 * Create a test table with composite key (partition + sort key)
 */
async function createCompositeKeyTable(
  tableName = "CompositeTable",
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
 * Create a test table with GSI
 */
async function createTableWithGSI(tableName = "TableWithGSI"): Promise<Table> {
  const kv = await Deno.openKv(":memory:");

  const gsi: GlobalSecondaryIndex = {
    IndexName: "email-index",
    KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
    Projection: { ProjectionType: "ALL" },
  };

  const table = new Table(
    tableName,
    [{ AttributeName: "username", KeyType: "HASH" }],
    [
      { AttributeName: "username", AttributeType: "S" },
      { AttributeName: "email", AttributeType: "S" },
    ],
    [gsi],
    kv,
  );
  await table.initialize();
  return table;
}

// ============================================================================
// GetItem Tests
// ============================================================================

Deno.test("GetItem - returns existing item", async () => {
  const table = await createSimpleTable();

  // Put an item first
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "test-1" },
      name: { S: "Test Item" },
      count: { N: "42" },
    },
  });

  // Get the item
  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "test-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.id, { S: "test-1" });
  assertEquals(response.Item.name, { S: "Test Item" });
  assertEquals(response.Item.count, { N: "42" });

  table.close();
});

Deno.test("GetItem - returns empty for non-existent item", async () => {
  const table = await createSimpleTable();

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "non-existent" } },
  });

  assertEquals(response.Item, undefined);

  table.close();
});

Deno.test("GetItem - with ProjectionExpression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "test-1" },
      name: { S: "Test Item" },
      description: { S: "A test description" },
      count: { N: "42" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "test-1" } },
    ProjectionExpression: "id, name",
  });

  assertExists(response.Item);
  assertEquals(response.Item.id, { S: "test-1" });
  assertEquals(response.Item.name, { S: "Test Item" });
  assertEquals(response.Item.description, undefined);
  assertEquals(response.Item.count, undefined);

  table.close();
});

Deno.test("GetItem - with ExpressionAttributeNames", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "test-1" },
      name: { S: "Test Item" },
      status: { S: "active" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "test-1" } },
    ProjectionExpression: "#id, #n",
    ExpressionAttributeNames: {
      "#id": "id",
      "#n": "name",
    },
  });

  assertExists(response.Item);
  assertEquals(response.Item.id, { S: "test-1" });
  assertEquals(response.Item.name, { S: "Test Item" });
  assertEquals(response.Item.status, undefined);

  table.close();
});

// ============================================================================
// PutItem Tests
// ============================================================================

Deno.test("PutItem - inserts new item", async () => {
  const table = await createSimpleTable();

  const response = await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "new-item" },
      data: { S: "test data" },
    },
  });

  assertEquals(response.Attributes, undefined);

  // Verify it was inserted
  const getResponse = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "new-item" } },
  });

  assertExists(getResponse.Item);
  assertEquals(getResponse.Item.data, { S: "test data" });

  table.close();
});

Deno.test("PutItem - replaces existing item", async () => {
  const table = await createSimpleTable();

  // Insert initial item
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      version: { N: "1" },
    },
  });

  // Replace with new item
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      version: { N: "2" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.version, { N: "2" });

  table.close();
});

Deno.test("PutItem - with ConditionExpression (item doesn't exist)", async () => {
  const table = await createSimpleTable();

  // First put should succeed
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "unique-item" },
      data: { S: "original" },
    },
    ConditionExpression: "attribute_not_exists(id)",
  });

  // Second put should fail (item already exists)
  await assertRejects(
    async () => {
      await table.putItem({
        TableName: "TestTable",
        Item: {
          id: { S: "unique-item" },
          data: { S: "duplicate" },
        },
        ConditionExpression: "attribute_not_exists(id)",
      });
    },
    ConditionalCheckFailedException,
    "Condition not satisfied",
  );

  table.close();
});

Deno.test("PutItem - with ReturnValues ALL_OLD", async () => {
  const table = await createSimpleTable();

  // Insert initial item
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      value: { S: "old" },
    },
  });

  // Replace and get old values
  const response = await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      value: { S: "new" },
    },
    ReturnValues: "ALL_OLD",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.value, { S: "old" });

  table.close();
});

// ============================================================================
// UpdateItem Tests
// ============================================================================

Deno.test("UpdateItem - SET updates existing attributes", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "Original" },
      count: { N: "10" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #n = :newName",
    ExpressionAttributeNames: { "#n": "name" },
    ExpressionAttributeValues: { ":newName": { S: "Updated" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.name, { S: "Updated" });
  assertEquals(response.Attributes.count, { N: "10" });

  table.close();
});

Deno.test("UpdateItem - REMOVE removes attributes", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "Test" },
      temp: { S: "Remove me" },
      count: { N: "5" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "REMOVE temp",
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.temp, undefined);
  assertEquals(response.Attributes.name, { S: "Test" });

  table.close();
});

Deno.test("UpdateItem - ADD increments numeric value", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "counter" },
      count: { N: "10" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "counter" } },
    UpdateExpression: "ADD count :inc",
    ExpressionAttributeValues: { ":inc": { N: "5" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.count, { N: "15" });

  table.close();
});

Deno.test("UpdateItem - ADD to string set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["tag1", "tag2"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD tags :newTags",
    ExpressionAttributeValues: { ":newTags": { SS: ["tag3", "tag4"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertExists(response.Attributes.tags);
  assertEquals((response.Attributes.tags as { SS: string[] }).SS.sort(), [
    "tag1",
    "tag2",
    "tag3",
    "tag4",
  ]);

  table.close();
});

Deno.test("UpdateItem - DELETE from string set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["tag1", "tag2", "tag3", "tag4"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "DELETE tags :removeTags",
    ExpressionAttributeValues: { ":removeTags": { SS: ["tag2", "tag4"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertExists(response.Attributes.tags);
  assertEquals((response.Attributes.tags as { SS: string[] }).SS.sort(), [
    "tag1",
    "tag3",
  ]);

  table.close();
});

Deno.test("UpdateItem - with ConditionExpression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      version: { N: "1" },
    },
  });

  // Update should succeed
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET version = :newVer",
    ConditionExpression: "version = :oldVer",
    ExpressionAttributeValues: {
      ":newVer": { N: "2" },
      ":oldVer": { N: "1" },
    },
  });

  // Update should fail (version mismatch)
  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        UpdateExpression: "SET version = :newVer",
        ConditionExpression: "version = :oldVer",
        ExpressionAttributeValues: {
          ":newVer": { N: "3" },
          ":oldVer": { N: "1" },
        },
      });
    },
    ConditionalCheckFailedException,
  );

  table.close();
});

Deno.test("UpdateItem - with ReturnValues ALL_OLD", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      value: { S: "old" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET value = :v",
    ExpressionAttributeValues: { ":v": { S: "new" } },
    ReturnValues: "ALL_OLD",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.value, { S: "old" });

  table.close();
});

Deno.test("UpdateItem - multiple clauses in one expression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      count: { N: "10" },
      temp: { S: "delete me" },
      name: { S: "Original" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #n = :name ADD count :inc REMOVE temp",
    ExpressionAttributeNames: { "#n": "name" },
    ExpressionAttributeValues: {
      ":name": { S: "Updated" },
      ":inc": { N: "5" },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.name, { S: "Updated" });
  assertEquals(response.Attributes.count, { N: "15" });
  assertEquals(response.Attributes.temp, undefined);

  table.close();
});

// ============================================================================
// DeleteItem Tests
// ============================================================================

Deno.test("DeleteItem - deletes existing item", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      data: { S: "test" },
    },
  });

  await table.deleteItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertEquals(response.Item, undefined);

  table.close();
});

Deno.test("DeleteItem - with ConditionExpression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      status: { S: "active" },
    },
  });

  // Delete should fail (status doesn't match)
  await assertRejects(
    async () => {
      await table.deleteItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        ConditionExpression: "status = :s",
        ExpressionAttributeValues: { ":s": { S: "inactive" } },
      });
    },
    ConditionalCheckFailedException,
  );

  // Item should still exist
  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });
  assertExists(response.Item);

  table.close();
});

Deno.test("DeleteItem - with ReturnValues ALL_OLD", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      data: { S: "important data" },
    },
  });

  const response = await table.deleteItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ReturnValues: "ALL_OLD",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.data, { S: "important data" });

  table.close();
});

// ============================================================================
// Query Tests
// ============================================================================

Deno.test("Query - by partition key only", async () => {
  const table = await createCompositeKeyTable();

  // Insert multiple items with same partition key
  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-1" },
      amount: { N: "100" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-2" },
      amount: { N: "200" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-2" },
      sk: { S: "order-1" },
      amount: { N: "150" },
    },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: "user-1" } },
  });

  assertEquals(response.Count, 2);
  assertEquals(response.Items.length, 2);

  table.close();
});

Deno.test("Query - with sort key equals condition", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-1" },
      amount: { N: "100" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-2" },
      amount: { N: "200" },
    },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk = :sk",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":sk": { S: "order-1" },
    },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.Items[0].amount, { N: "100" });

  table.close();
});

Deno.test("Query - with sort key comparison operators", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "2024-01-01" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "2024-01-15" }, data: { S: "b" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "2024-02-01" }, data: { S: "c" } },
  });

  // Test greater than
  const response1 = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk > :date",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":date": { S: "2024-01-10" },
    },
  });

  assertEquals(response1.Count, 2);

  // Test less than or equal
  const response2 = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk <= :date",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":date": { S: "2024-01-15" },
    },
  });

  assertEquals(response2.Count, 2);

  table.close();
});

Deno.test("Query - with begins_with", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "order-123" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "order-456" }, data: { S: "b" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "invoice-789" }, data: { S: "c" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":prefix": { S: "order-" },
    },
  });

  assertEquals(response.Count, 2);

  table.close();
});

Deno.test("Query - with BETWEEN", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "metrics" }, sk: { S: "2024-01-01" }, value: { N: "10" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "metrics" }, sk: { S: "2024-01-15" }, value: { N: "20" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "metrics" }, sk: { S: "2024-02-01" }, value: { N: "30" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: {
      ":pk": { S: "metrics" },
      ":start": { S: "2024-01-10" },
      ":end": { S: "2024-01-31" },
    },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.Items[0].value, { N: "20" });

  table.close();
});

Deno.test("Query - with FilterExpression", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-1" },
      status: { S: "completed" },
      amount: { N: "100" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-2" },
      status: { S: "pending" },
      amount: { N: "200" },
    },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "status = :status",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":status": { S: "completed" },
    },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.ScannedCount, 2);
  assertEquals(response.Items[0].amount, { N: "100" });

  table.close();
});

Deno.test("Query - with Limit", async () => {
  const table = await createCompositeKeyTable();

  for (let i = 1; i <= 10; i++) {
    await table.putItem({
      TableName: "CompositeTable",
      Item: {
        pk: { S: "user-1" },
        sk: { S: `item-${i}` },
        data: { N: i.toString() },
      },
    });
  }

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: "user-1" } },
    Limit: 5,
  });

  assertEquals(response.Items.length, 5);

  table.close();
});

Deno.test("Query - with ScanIndexForward false (reverse order)", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "a" }, data: { N: "1" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "b" }, data: { N: "2" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "c" }, data: { N: "3" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: "user-1" } },
    ScanIndexForward: false,
  });

  assertEquals(response.Items[0].sk, { S: "c" });
  assertEquals(response.Items[1].sk, { S: "b" });
  assertEquals(response.Items[2].sk, { S: "a" });

  table.close();
});

Deno.test("Query - on GSI", async () => {
  const table = await createTableWithGSI();

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@example.com" },
      name: { S: "Alice" },
    },
  });

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "bob" },
      email: { S: "bob@example.com" },
      name: { S: "Bob" },
    },
  });

  const response = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@example.com" } },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.Items[0].username, { S: "alice" });

  table.close();
});

// ============================================================================
// Scan Tests
// ============================================================================

Deno.test("Scan - returns all items", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, data: { S: "b" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "3" }, data: { S: "c" } },
  });

  const response = await table.scan({
    TableName: "TestTable",
  });

  assertEquals(response.Count, 3);
  assertEquals(response.ScannedCount, 3);

  table.close();
});

Deno.test("Scan - with FilterExpression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, status: { S: "active" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, status: { S: "inactive" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "3" }, status: { S: "active" } },
  });

  const response = await table.scan({
    TableName: "TestTable",
    FilterExpression: "status = :s",
    ExpressionAttributeValues: { ":s": { S: "active" } },
  });

  assertEquals(response.Count, 2);
  assertEquals(response.ScannedCount, 3);

  table.close();
});

Deno.test("Scan - with Limit", async () => {
  const table = await createSimpleTable();

  for (let i = 1; i <= 10; i++) {
    await table.putItem({
      TableName: "TestTable",
      Item: { id: { S: i.toString() }, data: { N: i.toString() } },
    });
  }

  const response = await table.scan({
    TableName: "TestTable",
    Limit: 5,
  });

  assertEquals(response.Items.length, 5);

  table.close();
});

Deno.test("Scan - on GSI", async () => {
  const table = await createTableWithGSI();

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@example.com" },
    },
  });

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "bob" },
      email: { S: "bob@example.com" },
    },
  });

  const response = await table.scan({
    TableName: "TableWithGSI",
    IndexName: "email-index",
  });

  assertEquals(response.Count, 2);

  table.close();
});

// ============================================================================
// Expression Evaluation Tests
// ============================================================================

Deno.test("ConditionExpression - attribute_exists", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, flag: { BOOL: true } },
  });

  // Should succeed (flag exists)
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET updated = :val",
    ConditionExpression: "attribute_exists(flag)",
    ExpressionAttributeValues: { ":val": { BOOL: true } },
  });

  // Should fail (nonexistent doesn't exist)
  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        UpdateExpression: "SET updated = :val",
        ConditionExpression: "attribute_exists(nonexistent)",
        ExpressionAttributeValues: { ":val": { BOOL: true } },
      });
    },
    ConditionalCheckFailedException,
  );

  table.close();
});

Deno.test("ConditionExpression - comparison operators", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  // Test greater than
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :val",
    ConditionExpression: "count > :threshold",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":threshold": { N: "5" },
    },
  });

  // Test less than or equal
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :val",
    ConditionExpression: "count <= :max",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":max": { N: "10" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - begins_with", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, code: { S: "PROD-123" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :val",
    ConditionExpression: "begins_with(code, :prefix)",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":prefix": { S: "PROD-" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - contains", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["important", "urgent", "review"] },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET processed = :val",
    ConditionExpression: "contains(tags, :tag)",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":tag": { S: "urgent" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - AND operator", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      status: { S: "active" },
      count: { N: "10" },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :val",
    ConditionExpression: "status = :s AND count > :c",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":s": { S: "active" },
      ":c": { N: "5" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - OR operator", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      priority: { S: "high" },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :val",
    ConditionExpression: "priority = :high OR priority = :urgent",
    ExpressionAttributeValues: {
      ":val": { BOOL: true },
      ":high": { S: "high" },
      ":urgent": { S: "urgent" },
    },
  });

  table.close();
});

// ============================================================================
// GSI Tests
// ============================================================================

Deno.test("GSI - PutItem updates GSI pointers", async () => {
  const table = await createTableWithGSI();

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@example.com" },
      name: { S: "Alice" },
    },
  });

  // Query by email using GSI
  const response = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@example.com" } },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.Items[0].username, { S: "alice" });

  table.close();
});

Deno.test("GSI - UpdateItem updates GSI pointers when indexed attribute changes", async () => {
  const table = await createTableWithGSI();

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@old.com" },
    },
  });

  // Change email (indexed attribute)
  await table.updateItem({
    TableName: "TableWithGSI",
    Key: { username: { S: "alice" } },
    UpdateExpression: "SET email = :newEmail",
    ExpressionAttributeValues: { ":newEmail": { S: "alice@new.com" } },
  });

  // Query with new email should succeed
  const response1 = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@new.com" } },
  });

  assertEquals(response1.Count, 1);

  // Query with old email should return nothing
  const response2 = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@old.com" } },
  });

  assertEquals(response2.Count, 0);

  table.close();
});

Deno.test("GSI - DeleteItem removes GSI pointers", async () => {
  const table = await createTableWithGSI();

  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@example.com" },
    },
  });

  await table.deleteItem({
    TableName: "TableWithGSI",
    Key: { username: { S: "alice" } },
  });

  // Query should return no results
  const response = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@example.com" } },
  });

  assertEquals(response.Count, 0);

  table.close();
});

// ============================================================================
// Batch Operations Tests
// ============================================================================

Deno.test("BatchGetItem - get multiple items from single table", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, data: { S: "b" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "3" }, data: { S: "c" } },
  });

  const response = await table.batchGetItem({
    RequestItems: {
      TestTable: {
        Keys: [{ id: { S: "1" } }, { id: { S: "3" } }],
      },
    },
  });

  assertEquals(response.Responses.TestTable.length, 2);

  table.close();
});

Deno.test("BatchWriteItem - batch put multiple items", async () => {
  const table = await createSimpleTable();

  await table.batchWriteItem({
    RequestItems: {
      TestTable: [
        { PutRequest: { Item: { id: { S: "1" }, data: { S: "a" } } } },
        { PutRequest: { Item: { id: { S: "2" }, data: { S: "b" } } } },
        { PutRequest: { Item: { id: { S: "3" }, data: { S: "c" } } } },
      ],
    },
  });

  const scanResponse = await table.scan({ TableName: "TestTable" });
  assertEquals(scanResponse.Count, 3);

  table.close();
});

Deno.test("BatchWriteItem - batch delete multiple items", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, data: { S: "b" } },
  });

  await table.batchWriteItem({
    RequestItems: {
      TestTable: [
        { DeleteRequest: { Key: { id: { S: "1" } } } },
        { DeleteRequest: { Key: { id: { S: "2" } } } },
      ],
    },
  });

  const scanResponse = await table.scan({ TableName: "TestTable" });
  assertEquals(scanResponse.Count, 0);

  table.close();
});

Deno.test("BatchWriteItem - mixed put and delete operations", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "old" } },
  });

  await table.batchWriteItem({
    RequestItems: {
      TestTable: [
        { DeleteRequest: { Key: { id: { S: "1" } } } },
        { PutRequest: { Item: { id: { S: "2" }, data: { S: "new" } } } },
      ],
    },
  });

  const get1 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "1" } },
  });
  assertEquals(get1.Item, undefined);

  const get2 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "2" } },
  });
  assertExists(get2.Item);

  table.close();
});

// ============================================================================
// Transaction Tests
// ============================================================================

Deno.test("TransactWriteItems - multiple Put operations", async () => {
  const table = await createSimpleTable();

  await table.transactWriteItems({
    TransactItems: [
      {
        Put: {
          TableName: "TestTable",
          Item: { id: { S: "1" }, data: { S: "a" } },
        },
      },
      {
        Put: {
          TableName: "TestTable",
          Item: { id: { S: "2" }, data: { S: "b" } },
        },
      },
      {
        Put: {
          TableName: "TestTable",
          Item: { id: { S: "3" }, data: { S: "c" } },
        },
      },
    ],
  });

  const scanResponse = await table.scan({ TableName: "TestTable" });
  assertEquals(scanResponse.Count, 3);

  table.close();
});

Deno.test("TransactWriteItems - multiple Update operations", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, count: { N: "0" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, count: { N: "0" } },
  });

  await table.transactWriteItems({
    TransactItems: [
      {
        Update: {
          TableName: "TestTable",
          Key: { id: { S: "1" } },
          UpdateExpression: "ADD count :inc",
          ExpressionAttributeValues: { ":inc": { N: "1" } },
        },
      },
      {
        Update: {
          TableName: "TestTable",
          Key: { id: { S: "2" } },
          UpdateExpression: "ADD count :inc",
          ExpressionAttributeValues: { ":inc": { N: "1" } },
        },
      },
    ],
  });

  const item1 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "1" } },
  });
  assertEquals(item1.Item?.count, { N: "1" });

  const item2 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "2" } },
  });
  assertEquals(item2.Item?.count, { N: "1" });

  table.close();
});

Deno.test("TransactWriteItems - multiple Delete operations", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, data: { S: "b" } },
  });

  await table.transactWriteItems({
    TransactItems: [
      { Delete: { TableName: "TestTable", Key: { id: { S: "1" } } } },
      { Delete: { TableName: "TestTable", Key: { id: { S: "2" } } } },
    ],
  });

  const scanResponse = await table.scan({ TableName: "TestTable" });
  assertEquals(scanResponse.Count, 0);

  table.close();
});

Deno.test("TransactWriteItems - ConditionCheck operation", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "lock" }, status: { S: "unlocked" } },
  });

  await table.transactWriteItems({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: "TestTable",
          Key: { id: { S: "lock" } },
          ConditionExpression: "status = :s",
          ExpressionAttributeValues: { ":s": { S: "unlocked" } },
        },
      },
      {
        Put: {
          TableName: "TestTable",
          Item: { id: { S: "data" }, value: { S: "important" } },
        },
      },
    ],
  });

  const item = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "data" } },
  });
  assertExists(item.Item);

  table.close();
});

Deno.test("TransactWriteItems - mixed operations", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, count: { N: "5" } },
  });

  await table.transactWriteItems({
    TransactItems: [
      {
        Put: {
          TableName: "TestTable",
          Item: { id: { S: "2" }, data: { S: "new" } },
        },
      },
      {
        Update: {
          TableName: "TestTable",
          Key: { id: { S: "1" } },
          UpdateExpression: "ADD count :inc",
          ExpressionAttributeValues: { ":inc": { N: "3" } },
        },
      },
    ],
  });

  const item1 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "1" } },
  });
  assertEquals(item1.Item?.count, { N: "8" });

  const item2 = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "2" } },
  });
  assertExists(item2.Item);

  table.close();
});

Deno.test("TransactWriteItems - rollback on condition failure", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "lock" }, status: { S: "locked" } },
  });

  await assertRejects(
    async () => {
      await table.transactWriteItems({
        TransactItems: [
          {
            Put: {
              TableName: "TestTable",
              Item: { id: { S: "temp" }, data: { S: "temporary" } },
            },
          },
          {
            ConditionCheck: {
              TableName: "TestTable",
              Key: { id: { S: "lock" } },
              ConditionExpression: "status = :s",
              ExpressionAttributeValues: { ":s": { S: "unlocked" } },
            },
          },
        ],
      });
    },
    TransactionCanceledException,
  );

  // Verify temp item was not created (transaction rolled back)
  const tempItem = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "temp" } },
  });
  assertEquals(tempItem.Item, undefined);

  table.close();
});

Deno.test("TransactGetItems - get multiple items in consistent snapshot", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "1" }, data: { S: "a" } },
  });

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "2" }, data: { S: "b" } },
  });

  const response = await table.transactGetItems({
    TransactItems: [
      { Get: { TableName: "TestTable", Key: { id: { S: "1" } } } },
      { Get: { TableName: "TestTable", Key: { id: { S: "2" } } } },
    ],
  });

  assertEquals(response.Responses.length, 2);
  assertExists(response.Responses[0].Item);
  assertExists(response.Responses[1].Item);

  table.close();
});

// ============================================================================
// Edge Cases and Error Handling Tests
// ============================================================================

Deno.test("Error - ResourceNotFoundException for non-existent table", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await assertRejects(
      async () => {
        await Table.load("NonExistentTable", kv);
      },
      ResourceNotFoundException,
      "Table NonExistentTable not found",
    );
  } finally {
    kv.close();
  }
});

Deno.test("Error - ValidationException for invalid key schema", async () => {
  const kv = await Deno.openKv(":memory:");

  assertThrows(
    () => {
      new Table(
        "BadTable",
        [], // Empty key schema
        [{ AttributeName: "id", AttributeType: "S" }],
        undefined,
        kv,
      );
    },
    ValidationException,
    "KeySchema must have 1 or 2 elements",
  );

  kv.close();
});

Deno.test("Error - ValidationException for GSI key type mismatch", async () => {
  const table = await createTableWithGSI();

  // Put an item
  await table.putItem({
    TableName: "TestTable",
    Item: {
      username: { S: "user1" }, // Correct key name
      email: { S: "test@example.com" },
      name: { S: "Test User" },
    },
  });

  // Try to query GSI with wrong type (Number instead of String)
  await assertRejects(
    async () => {
      await table.query({
        TableName: "TestTable",
        IndexName: "email-index", // Correct index name
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": { N: "123" }, // Wrong type - should be S
        },
      });
    },
    ValidationException,
    "Type mismatch",
  );

  table.close();
});

Deno.test("Edge case - all attribute value types", async () => {
  const table = await createSimpleTable();

  const testItem: Item = {
    id: { S: "test-types" },
    stringAttr: { S: "hello" },
    numberAttr: { N: "123.45" },
    binaryAttr: { B: new Uint8Array([1, 2, 3]) },
    boolAttr: { BOOL: true },
    nullAttr: { NULL: true },
    mapAttr: { M: { nested: { S: "value" } } },
    listAttr: { L: [{ S: "a" }, { N: "1" }] },
    stringSetAttr: { SS: ["a", "b", "c"] },
    numberSetAttr: { NS: ["1", "2", "3"] },
    binarySetAttr: { BS: [new Uint8Array([1]), new Uint8Array([2])] },
  };

  await table.putItem({
    TableName: "TestTable",
    Item: testItem,
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "test-types" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.stringAttr, { S: "hello" });
  assertEquals(response.Item.numberAttr, { N: "123.45" });
  assertEquals(response.Item.boolAttr, { BOOL: true });
  assertEquals(response.Item.nullAttr, { NULL: true });

  table.close();
});

Deno.test("Edge case - empty attribute values", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "empty-test" },
      emptyString: { S: "" },
      emptyList: { L: [] },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "empty-test" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.emptyString, { S: "" });
  assertEquals(response.Item.emptyList, { L: [] });

  table.close();
});

Deno.test("Edge case - nested map structures", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "nested" },
      data: {
        M: {
          level1: {
            M: {
              level2: {
                M: {
                  level3: { S: "deep value" },
                },
              },
            },
          },
        },
      },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "nested" } },
  });

  assertExists(response.Item);
  assertExists(response.Item.data);

  table.close();
});

// ============================================================================
// Real-World Scenario Tests
// ============================================================================

Deno.test("Real-world - user authentication system", async () => {
  const table = await createTableWithGSI();

  // Register user
  await table.putItem({
    TableName: "TableWithGSI",
    Item: {
      username: { S: "alice" },
      email: { S: "alice@example.com" },
      passwordHash: { S: "hashed_password" },
      createdAt: { S: "2024-01-01T00:00:00Z" },
    },
    ConditionExpression: "attribute_not_exists(username)",
  });

  // Login by username
  const loginResponse = await table.getItem({
    TableName: "TableWithGSI",
    Key: { username: { S: "alice" } },
  });
  assertExists(loginResponse.Item);
  assertEquals(loginResponse.Item.passwordHash, { S: "hashed_password" });

  // Find user by email
  const emailResponse = await table.query({
    TableName: "TableWithGSI",
    IndexName: "email-index",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: "alice@example.com" } },
  });
  assertEquals(emailResponse.Count, 1);

  table.close();
});

Deno.test("Real-world - shopping cart", async () => {
  const table = await createCompositeKeyTable();

  // Add items to cart
  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-123" },
      sk: { S: "item-abc" },
      quantity: { N: "2" },
      price: { N: "19.99" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-123" },
      sk: { S: "item-xyz" },
      quantity: { N: "1" },
      price: { N: "49.99" },
    },
  });

  // Get all cart items
  const cartResponse = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :userId",
    ExpressionAttributeValues: { ":userId": { S: "user-123" } },
  });
  assertEquals(cartResponse.Count, 2);

  // Update quantity
  await table.updateItem({
    TableName: "CompositeTable",
    Key: { pk: { S: "user-123" }, sk: { S: "item-abc" } },
    UpdateExpression: "SET quantity = :qty",
    ExpressionAttributeValues: { ":qty": { N: "3" } },
  });

  // Remove item
  await table.deleteItem({
    TableName: "CompositeTable",
    Key: { pk: { S: "user-123" }, sk: { S: "item-xyz" } },
  });

  table.close();
});

Deno.test("Real-world - time-series data", async () => {
  const table = await createCompositeKeyTable();

  // Record metrics
  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "sensor-001" },
      sk: { S: "2024-01-01T10:00:00Z" },
      temperature: { N: "22.5" },
      humidity: { N: "45" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "sensor-001" },
      sk: { S: "2024-01-01T11:00:00Z" },
      temperature: { N: "23.1" },
      humidity: { N: "47" },
    },
  });

  // Query time range
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :sensor AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: {
      ":sensor": { S: "sensor-001" },
      ":start": { S: "2024-01-01T00:00:00Z" },
      ":end": { S: "2024-01-01T12:00:00Z" },
    },
  });

  assertEquals(response.Count, 2);

  table.close();
});

Deno.test("Real-world - inventory management with stock updates", async () => {
  const table = await createSimpleTable();

  // Initialize inventory
  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "product-123" },
      name: { S: "Widget" },
      stock: { N: "100" },
    },
  });

  // Process order (decrease stock)
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "product-123" } },
    UpdateExpression: "ADD stock :decrease",
    ConditionExpression: "stock >= :minStock",
    ExpressionAttributeValues: {
      ":decrease": { N: "-5" },
      ":minStock": { N: "5" },
    },
    ReturnValues: "ALL_NEW",
  });

  // Restock
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "product-123" } },
    UpdateExpression: "ADD stock :increase",
    ExpressionAttributeValues: { ":increase": { N: "50" } },
    ReturnValues: "ALL_NEW",
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "product-123" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.stock, { N: "145" });

  table.close();
});
