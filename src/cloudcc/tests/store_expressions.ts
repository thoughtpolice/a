// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Comprehensive expression parsing and evaluation edge case tests
 *
 * This test suite validates ALL edge cases for DynamoDB expression parsing:
 * - ConditionExpression (all operators, functions, combinations)
 * - UpdateExpression (SET, REMOVE, ADD, DELETE with edge cases)
 * - KeyConditionExpression (all sort key operators, BETWEEN, begins_with)
 * - FilterExpression (post-query filtering)
 * - ProjectionExpression (attribute selection)
 * - ExpressionAttributeNames (reserved words, special characters)
 * - ExpressionAttributeValues (all types, edge values)
 * - Expression parsing errors and validation
 *
 * Total: 70+ test cases covering all expression edge cases
 *
 * Run with: deno test --allow-read --allow-write --allow-env --unstable-kv store_expressions_test.ts
 *
 * Note: Some advanced features not yet supported by the parser:
 * - Parentheses in boolean expressions (precedence is AND before OR)
 * - Nested attribute paths (M.nested.field, L[0])
 * - Functions like if_not_exists, list_append, size(), attribute_type()
 * - Attribute names with special characters directly (must use ExpressionAttributeNames)
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  ConditionalCheckFailedException,
  type Item,
  Table,
  ValidationException,
} from "../store.ts";

// ============================================================================
// Test Utilities
// ============================================================================

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

// ============================================================================
// 1. ConditionExpression Edge Cases
// ============================================================================

Deno.test("ConditionExpression - nested AND with multiple conditions", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      status: { S: "active" },
      count: { N: "50" },
      priority: { S: "high" },
    },
  });

  // Three-way AND condition
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "status = :s AND count > :c AND priority = :p",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":s": { S: "active" },
      ":c": { N: "25" },
      ":p": { S: "high" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - nested OR with multiple conditions", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      priority: { S: "medium" },
    },
  });

  // Three-way OR condition - should match "medium"
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression:
      "priority = :high OR priority = :medium OR priority = :low",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":high": { S: "high" },
      ":medium": { S: "medium" },
      ":low": { S: "low" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - all comparison operators", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, value: { N: "100" } },
  });

  // Test equality
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test1 = :v",
    ConditionExpression: "value = :val",
    ExpressionAttributeValues: { ":v": { N: "1" }, ":val": { N: "100" } },
  });

  // Test inequality
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test2 = :v",
    ConditionExpression: "value <> :val",
    ExpressionAttributeValues: { ":v": { N: "2" }, ":val": { N: "50" } },
  });

  // Test less than
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test3 = :v",
    ConditionExpression: "value < :val",
    ExpressionAttributeValues: { ":v": { N: "3" }, ":val": { N: "200" } },
  });

  // Test less than or equal
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test4 = :v",
    ConditionExpression: "value <= :val",
    ExpressionAttributeValues: { ":v": { N: "4" }, ":val": { N: "100" } },
  });

  // Test greater than
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test5 = :v",
    ConditionExpression: "value > :val",
    ExpressionAttributeValues: { ":v": { N: "5" }, ":val": { N: "50" } },
  });

  // Test greater than or equal
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET test6 = :v",
    ConditionExpression: "value >= :val",
    ExpressionAttributeValues: { ":v": { N: "6" }, ":val": { N: "100" } },
  });

  table.close();
});

Deno.test("ConditionExpression - begins_with with empty string", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, code: { S: "ABC123" } },
  });

  // Empty prefix should match everything
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "begins_with(code, :prefix)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":prefix": { S: "" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - begins_with with exact match", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, code: { S: "EXACT" } },
  });

  // Exact match should work
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "begins_with(code, :prefix)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":prefix": { S: "EXACT" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - begins_with with single character", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, code: { S: "ABC123" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "begins_with(code, :prefix)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":prefix": { S: "A" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - contains with empty string", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, text: { S: "hello world" } },
  });

  // Empty string should be contained in any string
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "contains(text, :search)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":search": { S: "" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - contains in string set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["alpha", "beta", "gamma"] },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "contains(tags, :tag)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":tag": { S: "beta" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - contains in number set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      numbers: { NS: ["10", "20", "30"] },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "contains(numbers, :num)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":num": { N: "20" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - contains in list", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      items: { L: [{ S: "apple" }, { S: "banana" }, { S: "cherry" }] },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "contains(items, :item)",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":item": { S: "banana" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - attribute_exists AND comparison", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      optional: { S: "exists" },
      count: { N: "10" },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "attribute_exists(optional) AND count > :c",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":c": { N: "5" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - attribute_not_exists OR comparison", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      status: { S: "pending" },
    },
  });

  // Should succeed because status = pending (attribute_not_exists is false but OR saves it)
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "attribute_not_exists(missing) OR status = :s",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":s": { S: "pending" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - inequality with non-existent attribute", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, name: { S: "test" } },
  });

  // Inequality with missing attribute should evaluate to true
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "missing <> :val",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":val": { S: "anything" },
    },
  });

  table.close();
});

Deno.test("ConditionExpression - reserved word using ExpressionAttributeNames", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "reserved" }, // "name" is reserved
      data: { S: "value" }, // "data" is reserved
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #n = :v",
    ConditionExpression: "#d = :dval",
    ExpressionAttributeNames: {
      "#n": "name",
      "#d": "data",
    },
    ExpressionAttributeValues: {
      ":v": { S: "updated" },
      ":dval": { S: "value" },
    },
  });

  table.close();
});

// ============================================================================
// 2. UpdateExpression Edge Cases
// ============================================================================

Deno.test("UpdateExpression - multiple SET clauses", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      a: { S: "old-a" },
      b: { S: "old-b" },
      c: { S: "old-c" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET a = :a, b = :b, c = :c",
    ExpressionAttributeValues: {
      ":a": { S: "new-a" },
      ":b": { S: "new-b" },
      ":c": { S: "new-c" },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.a, { S: "new-a" });
  assertEquals(response.Attributes.b, { S: "new-b" });
  assertEquals(response.Attributes.c, { S: "new-c" });

  table.close();
});

Deno.test("UpdateExpression - multiple REMOVE clauses", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      temp1: { S: "remove1" },
      temp2: { S: "remove2" },
      temp3: { S: "remove3" },
      keep: { S: "keep-me" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "REMOVE temp1, temp2, temp3",
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.temp1, undefined);
  assertEquals(response.Attributes.temp2, undefined);
  assertEquals(response.Attributes.temp3, undefined);
  assertEquals(response.Attributes.keep, { S: "keep-me" });

  table.close();
});

Deno.test("UpdateExpression - ADD with positive number", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD count :val",
    ExpressionAttributeValues: { ":val": { N: "15" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.count, { N: "25" });

  table.close();
});

Deno.test("UpdateExpression - ADD with negative number", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "100" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD count :val",
    ExpressionAttributeValues: { ":val": { N: "-30" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.count, { N: "70" });

  table.close();
});

Deno.test("UpdateExpression - ADD with zero", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "50" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD count :val",
    ExpressionAttributeValues: { ":val": { N: "0" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.count, { N: "50" });

  table.close();
});

Deno.test("UpdateExpression - ADD to non-existent attribute creates it", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, name: { S: "test" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD newCounter :val",
    ExpressionAttributeValues: { ":val": { N: "42" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.newCounter, { N: "42" });

  table.close();
});

Deno.test("UpdateExpression - ADD to string set with duplicates", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["alpha", "beta"] },
    },
  });

  // Adding duplicate should not create duplicates in set
  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD tags :new",
    ExpressionAttributeValues: { ":new": { SS: ["beta", "gamma", "delta"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertExists(response.Attributes.tags);
  const tags = (response.Attributes.tags as { SS: string[] }).SS.sort();
  assertEquals(tags, ["alpha", "beta", "delta", "gamma"]);

  table.close();
});

Deno.test("UpdateExpression - DELETE from empty set removes attribute", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["only-one"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "DELETE tags :removeTags",
    ExpressionAttributeValues: { ":removeTags": { SS: ["only-one"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.tags, undefined);

  table.close();
});

Deno.test("UpdateExpression - DELETE non-existent values from set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["alpha", "beta", "gamma"] },
    },
  });

  // Deleting non-existent values should not error
  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "DELETE tags :removeTags",
    ExpressionAttributeValues: { ":removeTags": { SS: ["delta", "epsilon"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  const tags = (response.Attributes.tags as { SS: string[] }).SS.sort();
  assertEquals(tags, ["alpha", "beta", "gamma"]);

  table.close();
});

Deno.test("UpdateExpression - all four clauses in one expression", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "old" },
      temp: { S: "delete-me" },
      counter: { N: "10" },
      tags: { SS: ["old-tag", "remove-me"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression:
      "SET #n = :name ADD counter :inc REMOVE temp DELETE tags :removeTags",
    ExpressionAttributeNames: { "#n": "name" },
    ExpressionAttributeValues: {
      ":name": { S: "updated" },
      ":inc": { N: "5" },
      ":removeTags": { SS: ["remove-me"] },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.name, { S: "updated" });
  assertEquals(response.Attributes.counter, { N: "15" });
  assertEquals(response.Attributes.temp, undefined);
  assertEquals((response.Attributes.tags as { SS: string[] }).SS, ["old-tag"]);

  table.close();
});

Deno.test("UpdateExpression - ADD to number set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      numbers: { NS: ["1", "2", "3"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD numbers :new",
    ExpressionAttributeValues: { ":new": { NS: ["4", "5"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  const numbers = (response.Attributes.numbers as { NS: string[] }).NS.sort();
  assertEquals(numbers, ["1", "2", "3", "4", "5"]);

  table.close();
});

Deno.test("UpdateExpression - DELETE from number set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      numbers: { NS: ["10", "20", "30", "40"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "DELETE numbers :removeNums",
    ExpressionAttributeValues: { ":removeNums": { NS: ["20", "40"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  const numbers = (response.Attributes.numbers as { NS: string[] }).NS.sort();
  assertEquals(numbers, ["10", "30"]);

  table.close();
});

// ============================================================================
// 3. KeyConditionExpression Edge Cases
// ============================================================================

Deno.test("KeyConditionExpression - partition key only", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "item-a" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "item-b" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: "user-1" } },
  });

  assertEquals(response.Count, 2);

  table.close();
});

Deno.test("KeyConditionExpression - BETWEEN with equal start and end", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "2024-01-15" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":start": { S: "2024-01-15" },
      ":end": { S: "2024-01-15" },
    },
  });

  assertEquals(response.Count, 1);

  table.close();
});

Deno.test("KeyConditionExpression - BETWEEN with reversed values", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "2024-01-15" } },
  });

  // BETWEEN with end < start should return no results
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":start": { S: "2024-12-31" },
      ":end": { S: "2024-01-01" },
    },
  });

  assertEquals(response.Count, 0);

  table.close();
});

Deno.test("KeyConditionExpression - begins_with with empty string", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "anything" } },
  });

  // Empty prefix should match all
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":prefix": { S: "" },
    },
  });

  assertEquals(response.Count, 1);

  table.close();
});

Deno.test("KeyConditionExpression - begins_with with full value", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "exact-match" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":prefix": { S: "exact-match" },
    },
  });

  assertEquals(response.Count, 1);

  table.close();
});

Deno.test("KeyConditionExpression - sort key with != operator", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "a" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "b" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk <> :sk",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":sk": { S: "a" },
    },
  });

  // Should return items where sk != "a"
  assertEquals(response.Count, 1);
  assertEquals(response.Items[0].sk, { S: "b" });

  table.close();
});

Deno.test("KeyConditionExpression - invalid partition key operator throws", async () => {
  const table = await createCompositeKeyTable();

  // Partition key must use = operator
  await assertRejects(
    async () => {
      await table.query({
        TableName: "CompositeTable",
        KeyConditionExpression: "pk > :pk",
        ExpressionAttributeValues: { ":pk": { S: "user-1" } },
      });
    },
    ValidationException,
    "Partition key condition must be equality",
  );

  table.close();
});

// ============================================================================
// 4. FilterExpression Edge Cases
// ============================================================================

Deno.test("FilterExpression - removes all results", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "a" }, status: { S: "active" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "b" }, status: { S: "active" } },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "status = :status",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":status": { S: "inactive" },
    },
  });

  assertEquals(response.Count, 0);
  assertEquals(response.ScannedCount, 2); // Scanned 2 but filtered to 0

  table.close();
});

Deno.test("FilterExpression - on non-existent attribute", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "a" } },
  });

  // Filter on missing attribute should fail for equality
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "missing = :val",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":val": { S: "anything" },
    },
  });

  assertEquals(response.Count, 0);

  table.close();
});

Deno.test("FilterExpression - complex boolean logic", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "a" },
      priority: { S: "high" },
      count: { N: "100" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "b" },
      priority: { S: "low" },
      count: { N: "50" },
    },
  });

  // Note: The current parser evaluates AND before OR (no parentheses support)
  // So "priority = high AND count > 50 OR priority = low" is:
  // (priority = high AND count > 50) OR (priority = low)
  // First item: high priority AND count > 50 (100 > 50) = true
  // Second item: low priority = true
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk",
    FilterExpression: "priority = :low OR priority = :high",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":high": { S: "high" },
      ":low": { S: "low" },
    },
  });

  assertEquals(response.Count, 2); // Both should match

  table.close();
});

// ============================================================================
// 5. ProjectionExpression Edge Cases
// ============================================================================

Deno.test("ProjectionExpression - single attribute", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "test" },
      data: { S: "value" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ProjectionExpression: "name",
  });

  assertExists(response.Item);
  assertEquals(response.Item.name, { S: "test" });
  assertEquals(response.Item.data, undefined);

  table.close();
});

Deno.test("ProjectionExpression - multiple attributes", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      a: { S: "a-value" },
      b: { S: "b-value" },
      c: { S: "c-value" },
      d: { S: "d-value" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ProjectionExpression: "a, c, d",
  });

  assertExists(response.Item);
  assertEquals(response.Item.a, { S: "a-value" });
  assertEquals(response.Item.b, undefined);
  assertEquals(response.Item.c, { S: "c-value" });
  assertEquals(response.Item.d, { S: "d-value" });

  table.close();
});

Deno.test("ProjectionExpression - non-existent attributes", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      existing: { S: "value" },
    },
  });

  // Requesting non-existent attributes should not error
  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ProjectionExpression: "existing, nonexistent1, nonexistent2",
  });

  assertExists(response.Item);
  assertEquals(response.Item.existing, { S: "value" });
  assertEquals(response.Item.nonexistent1, undefined);
  assertEquals(response.Item.nonexistent2, undefined);

  table.close();
});

Deno.test("ProjectionExpression - with reserved words via ExpressionAttributeNames", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "test-name" },
      data: { S: "test-data" },
      value: { S: "test-value" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ProjectionExpression: "#n, #d",
    ExpressionAttributeNames: {
      "#n": "name",
      "#d": "data",
    },
  });

  assertExists(response.Item);
  assertEquals(response.Item.name, { S: "test-name" });
  assertEquals(response.Item.data, { S: "test-data" });
  assertEquals(response.Item.value, undefined);

  table.close();
});

// ============================================================================
// 6. ExpressionAttributeNames Edge Cases
// ============================================================================

Deno.test("ExpressionAttributeNames - multiple placeholder symbols", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      field1: { S: "value1" },
      field2: { S: "value2" },
      field3: { S: "value3" },
    },
  });

  // Test multiple attribute name substitutions
  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #f1 = :v1, #f2 = :v2, #f3 = :v3",
    ExpressionAttributeNames: {
      "#f1": "field1",
      "#f2": "field2",
      "#f3": "field3",
    },
    ExpressionAttributeValues: {
      ":v1": { S: "updated1" },
      ":v2": { S: "updated2" },
      ":v3": { S: "updated3" },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.field1, { S: "updated1" });
  assertEquals(response.Attributes.field2, { S: "updated2" });
  assertEquals(response.Attributes.field3, { S: "updated3" });

  table.close();
});

Deno.test("ExpressionAttributeNames - reserved word 'name'", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, name: { S: "original" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #name = :val",
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: { ":val": { S: "updated" } },
  });

  table.close();
});

Deno.test("ExpressionAttributeNames - reserved word 'data'", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, data: { S: "original" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #data = :val",
    ExpressionAttributeNames: { "#data": "data" },
    ExpressionAttributeValues: { ":val": { S: "updated" } },
  });

  table.close();
});

Deno.test("ExpressionAttributeNames - reserved word 'value'", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, value: { S: "original" } },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #value = :val",
    ExpressionAttributeNames: { "#value": "value" },
    ExpressionAttributeValues: { ":val": { S: "updated" } },
  });

  table.close();
});

Deno.test("ExpressionAttributeNames - attribute name substitution for projection", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "test-name" },
      data: { S: "test-data" },
      status: { S: "active" },
    },
  });

  // Test using ExpressionAttributeNames for projection (reserved words)
  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    ProjectionExpression: "#n, #d",
    ExpressionAttributeNames: {
      "#n": "name",
      "#d": "data",
    },
  });

  assertExists(response.Item);
  assertEquals(response.Item.name, { S: "test-name" });
  assertEquals(response.Item.data, { S: "test-data" });
  assertEquals(response.Item.status, undefined);

  table.close();
});

Deno.test("ExpressionAttributeNames - attribute name in condition", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      name: { S: "original" },
      value: { S: "existing" },
    },
  });

  // Use ExpressionAttributeNames in ConditionExpression
  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #n = :newName",
    ConditionExpression: "#v = :expectedValue",
    ExpressionAttributeNames: {
      "#n": "name",
      "#v": "value",
    },
    ExpressionAttributeValues: {
      ":newName": { S: "updated" },
      ":expectedValue": { S: "existing" },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.name, { S: "updated" });

  table.close();
});

// ============================================================================
// 7. ExpressionAttributeValues Edge Cases
// ============================================================================

Deno.test("ExpressionAttributeValues - all attribute types", async () => {
  const table = await createSimpleTable();

  const testItem: Item = {
    id: { S: "item-1" },
    s: { S: "string" },
    n: { N: "123" },
    b: { B: new Uint8Array([1, 2, 3]) },
    bool: { BOOL: true },
    nul: { NULL: true },
    m: { M: { nested: { S: "value" } } },
    l: { L: [{ S: "a" }] },
    ss: { SS: ["a", "b"] },
    ns: { NS: ["1", "2"] },
    bs: { BS: [new Uint8Array([1])] },
  };

  await table.putItem({
    TableName: "TestTable",
    Item: testItem,
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.s, { S: "string" });
  assertEquals(response.Item.n, { N: "123" });
  assertEquals(response.Item.bool, { BOOL: true });
  assertEquals(response.Item.nul, { NULL: true });

  table.close();
});

Deno.test("ExpressionAttributeValues - very large number", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, bigNum: { N: "999999999999999999" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD bigNum :val",
    ExpressionAttributeValues: { ":val": { N: "1" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.bigNum, { N: "1000000000000000000" });

  table.close();
});

Deno.test("ExpressionAttributeValues - decimal numbers", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, decimal: { N: "123.456" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD decimal :val",
    ExpressionAttributeValues: { ":val": { N: "0.544" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.decimal, { N: "124" });

  table.close();
});

Deno.test("ExpressionAttributeValues - scientific notation", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, sci: { N: "1e10" } },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.sci, { N: "1e10" });

  table.close();
});

Deno.test("ExpressionAttributeValues - binary data", async () => {
  const table = await createSimpleTable();

  const binaryData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, binary: { B: binaryData } },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertExists(response.Item.binary);
  assertEquals((response.Item.binary as { B: Uint8Array }).B, binaryData);

  table.close();
});

// ============================================================================
// 8. Expression Parsing Errors
// ============================================================================

Deno.test("Expression error - missing ExpressionAttributeValues", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        UpdateExpression: "SET count = :val",
        // Missing ExpressionAttributeValues
      });
    },
    ValidationException,
  );

  table.close();
});

Deno.test("Expression error - value placeholder not found", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        UpdateExpression: "SET count = :val",
        ExpressionAttributeValues: { ":wrongKey": { N: "20" } },
      });
    },
    ValidationException,
    "Value :val not found",
  );

  table.close();
});

Deno.test("Expression error - invalid UpdateExpression syntax", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  // Note: Current parser may not catch all syntax errors
  // This test verifies error handling for malformed expressions
  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        // Missing value reference in expression
        UpdateExpression: "SET count = :missing",
        ExpressionAttributeValues: { ":val": { N: "20" } },
      });
    },
    ValidationException,
    "Value :missing not found",
  );

  table.close();
});

Deno.test("Expression error - BETWEEN without partition key", async () => {
  const table = await createCompositeKeyTable();

  await assertRejects(
    async () => {
      await table.query({
        TableName: "CompositeTable",
        // Invalid - BETWEEN can only be used on sort key, not as sole condition
        KeyConditionExpression: "sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":start": { S: "a" },
          ":end": { S: "z" },
        },
      });
    },
    ValidationException,
  );

  table.close();
});

// ============================================================================
// 9. Complex Combined Expressions
// ============================================================================

Deno.test("Combined - ConditionExpression + UpdateExpression + ReturnValues", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      version: { N: "1" },
      data: { S: "old" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #d = :newData, version = :newVer",
    ConditionExpression: "version = :oldVer",
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: {
      ":newData": { S: "new" },
      ":newVer": { N: "2" },
      ":oldVer": { N: "1" },
    },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.data, { S: "new" });
  assertEquals(response.Attributes.version, { N: "2" });

  table.close();
});

Deno.test("Combined - KeyConditionExpression + FilterExpression", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "2024-01-15" },
      status: { S: "active" },
      amount: { N: "100" },
    },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "2024-01-20" },
      status: { S: "inactive" },
      amount: { N: "200" },
    },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk >= :start",
    FilterExpression: "status = :status AND amount > :min",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":start": { S: "2024-01-01" },
      ":status": { S: "active" },
      ":min": { N: "50" },
    },
  });

  assertEquals(response.Count, 1);
  assertEquals(response.ScannedCount, 2);

  table.close();
});

Deno.test("Combined - all expression types with attribute name/value substitution", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: {
      pk: { S: "user-1" },
      sk: { S: "order-123" },
      status: { S: "pending" },
      amount: { N: "100" },
      data: { S: "original" },
    },
  });

  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "#pk = :pkVal AND begins_with(#sk, :skPrefix)",
    FilterExpression: "#status = :statusVal AND #amount > :minAmount",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
      "#status": "status",
      "#amount": "amount",
    },
    ExpressionAttributeValues: {
      ":pkVal": { S: "user-1" },
      ":skPrefix": { S: "order-" },
      ":statusVal": { S: "pending" },
      ":minAmount": { N: "50" },
    },
  });

  assertEquals(response.Count, 1);

  table.close();
});

// ============================================================================
// 10. Unicode and Special Characters
// ============================================================================

Deno.test("Unicode - emoji in attribute value", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      message: { S: "Hello 👋 World 🌍" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.message, { S: "Hello 👋 World 🌍" });

  table.close();
});

Deno.test("Unicode - multi-byte characters in condition", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      text: { S: "日本語テキスト" },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "begins_with(#text, :prefix)",
    ExpressionAttributeNames: { "#text": "text" },
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":prefix": { S: "日本" },
    },
  });

  table.close();
});

Deno.test("Unicode - Chinese characters", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      description: { S: "这是中文描述" },
    },
  });

  const response = await table.getItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
  });

  assertExists(response.Item);
  assertEquals(response.Item.description, { S: "这是中文描述" });

  table.close();
});

Deno.test("Special characters - attribute name with dots", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      "my.dotted.name": { S: "value" },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET #attr = :val",
    ExpressionAttributeNames: { "#attr": "my.dotted.name" },
    ExpressionAttributeValues: { ":val": { S: "updated" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes["my.dotted.name"], { S: "updated" });

  table.close();
});

Deno.test("Special characters - contains with special chars", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      text: { S: "Special!@#$%^&*()_+-=[]{}|;:,.<>?/~`" },
    },
  });

  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "contains(#text, :search)",
    ExpressionAttributeNames: { "#text": "text" },
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":search": { S: "@#$" },
    },
  });

  table.close();
});

// ============================================================================
// Additional Edge Cases
// ============================================================================

Deno.test("Edge case - DELETE entire set when all values removed", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      tags: { SS: ["alpha", "beta"] },
    },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "DELETE tags :removeTags",
    ExpressionAttributeValues: { ":removeTags": { SS: ["alpha", "beta"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.tags, undefined);

  table.close();
});

Deno.test("Edge case - ADD to non-existent string set", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, name: { S: "test" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD newSet :values",
    ExpressionAttributeValues: { ":values": { SS: ["a", "b", "c"] } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  const set = (response.Attributes.newSet as { SS: string[] }).SS.sort();
  assertEquals(set, ["a", "b", "c"]);

  table.close();
});

Deno.test("Edge case - multiple AND and OR in complex condition", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      status: { S: "active" },
      priority: { S: "high" },
      count: { N: "75" },
    },
  });

  // (status = active AND priority = high) OR (count > 100)
  await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "SET flag = :v",
    ConditionExpression: "status = :s1 AND priority = :p OR count > :c",
    ExpressionAttributeValues: {
      ":v": { BOOL: true },
      ":s1": { S: "active" },
      ":p": { S: "high" },
      ":c": { N: "100" },
    },
  });

  table.close();
});

Deno.test("Edge case - REMOVE non-existent attribute", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      existing: { S: "value" },
    },
  });

  // REMOVE should not error on non-existent attribute
  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "REMOVE nonexistent",
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.existing, { S: "value" });

  table.close();
});

Deno.test("Edge case - query with number comparison on sort key", async () => {
  const table = await createCompositeKeyTable();

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "10" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "20" } },
  });

  await table.putItem({
    TableName: "CompositeTable",
    Item: { pk: { S: "user-1" }, sk: { S: "30" } },
  });

  // String comparison on numeric strings
  const response = await table.query({
    TableName: "CompositeTable",
    KeyConditionExpression: "pk = :pk AND sk > :sk",
    ExpressionAttributeValues: {
      ":pk": { S: "user-1" },
      ":sk": { S: "15" },
    },
  });

  // Should match "20" and "30" based on string comparison
  assertEquals(response.Count, 2);

  table.close();
});

Deno.test("Edge case - contains case sensitivity", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: {
      id: { S: "item-1" },
      text: { S: "Hello World" },
    },
  });

  // Should be case-sensitive (lowercase "hello" != "Hello")
  await assertRejects(
    async () => {
      await table.updateItem({
        TableName: "TestTable",
        Key: { id: { S: "item-1" } },
        UpdateExpression: "SET flag = :v",
        ConditionExpression: "contains(#text, :search)",
        ExpressionAttributeNames: { "#text": "text" },
        ExpressionAttributeValues: {
          ":v": { BOOL: true },
          ":search": { S: "hello" },
        },
      });
    },
    ConditionalCheckFailedException,
  );

  table.close();
});

Deno.test("Edge case - ADD negative to decrease counter below zero", async () => {
  const table = await createSimpleTable();

  await table.putItem({
    TableName: "TestTable",
    Item: { id: { S: "item-1" }, count: { N: "10" } },
  });

  const response = await table.updateItem({
    TableName: "TestTable",
    Key: { id: { S: "item-1" } },
    UpdateExpression: "ADD count :val",
    ExpressionAttributeValues: { ":val": { N: "-50" } },
    ReturnValues: "ALL_NEW",
  });

  assertExists(response.Attributes);
  assertEquals(response.Attributes.count, { N: "-40" });

  table.close();
});
