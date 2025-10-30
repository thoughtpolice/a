// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB-like API implementation on top of Deno KV
 *
 * This module provides a comprehensive DynamoDB-compatible interface using Deno KV
 * as the underlying storage engine. It supports primary key access, global secondary
 * indexes (GSIs), conditional operations, transactions, and expression evaluation.
 */

// ============================================================================
// Core Type Definitions
// ============================================================================

/**
 * DynamoDB attribute value types
 */
export type AttributeValue =
  | { S: string } // String
  | { N: string } // Number (stored as string to preserve precision)
  | { B: Uint8Array } // Binary
  | { BOOL: boolean } // Boolean
  | { NULL: true } // Null
  | { M: Record<string, AttributeValue> } // Map
  | { L: AttributeValue[] } // List
  | { SS: string[] } // String Set
  | { NS: string[] } // Number Set
  | { BS: Uint8Array[] }; // Binary Set

/**
 * DynamoDB item (map of attribute names to values)
 */
export type Item = Record<string, AttributeValue>;

/**
 * Key type for table or index
 */
export type KeyType = "HASH" | "RANGE";

/**
 * Attribute type for key attributes
 */
export type AttributeType = "S" | "N" | "B";

/**
 * Key schema element
 */
export interface KeySchemaElement {
  AttributeName: string;
  KeyType: KeyType;
}

/**
 * Attribute definition
 */
export interface AttributeDefinition {
  AttributeName: string;
  AttributeType: AttributeType;
}

/**
 * Projection type for secondary indexes
 */
export type ProjectionType = "ALL" | "KEYS_ONLY" | "INCLUDE";

/**
 * Projection specification
 */
export interface Projection {
  ProjectionType: ProjectionType;
  NonKeyAttributes?: string[];
}

/**
 * Global Secondary Index definition
 */
export interface GlobalSecondaryIndex {
  IndexName: string;
  KeySchema: KeySchemaElement[];
  Projection: Projection;
}

/**
 * Key type (used for GetItem, DeleteItem, etc.)
 */
export type Key = Record<string, AttributeValue>;

/**
 * Expression attribute names mapping
 */
export type ExpressionAttributeNames = Record<string, string>;

/**
 * Expression attribute values mapping
 */
export type ExpressionAttributeValues = Record<string, AttributeValue>;

/**
 * Return values option
 */
export type ReturnValues =
  | "NONE"
  | "ALL_OLD"
  | "UPDATED_OLD"
  | "ALL_NEW"
  | "UPDATED_NEW";

// ============================================================================
// API Parameter Types
// ============================================================================

export interface GetItemParams {
  TableName: string;
  Key: Key;
  ConsistentRead?: boolean;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
}

export interface PutItemParams {
  TableName: string;
  Item: Item;
  ConditionExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
  ExpressionAttributeValues?: ExpressionAttributeValues;
  ReturnValues?: "NONE" | "ALL_OLD";
}

export interface UpdateItemParams {
  TableName: string;
  Key: Key;
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
  ExpressionAttributeValues?: ExpressionAttributeValues;
  ReturnValues?: ReturnValues;
}

export interface DeleteItemParams {
  TableName: string;
  Key: Key;
  ConditionExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
  ExpressionAttributeValues?: ExpressionAttributeValues;
  ReturnValues?: "NONE" | "ALL_OLD";
}

export interface QueryParams {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression: string;
  FilterExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
  ExpressionAttributeValues?: ExpressionAttributeValues;
  Limit?: number;
  ScanIndexForward?: boolean;
  ExclusiveStartKey?: Key;
}

export interface ScanParams {
  TableName: string;
  IndexName?: string;
  FilterExpression?: string;
  ExpressionAttributeNames?: ExpressionAttributeNames;
  ExpressionAttributeValues?: ExpressionAttributeValues;
  Limit?: number;
  ExclusiveStartKey?: Key;
}

export interface BatchGetItemParams {
  RequestItems: Record<string, { Keys: Key[] }>;
}

export interface BatchWriteItemParams {
  RequestItems: Record<
    string,
    Array<{ PutRequest?: { Item: Item }; DeleteRequest?: { Key: Key } }>
  >;
}

export interface TransactWriteItemsParams {
  TransactItems: Array<{
    Put?: { TableName: string; Item: Item; ConditionExpression?: string };
    Update?: UpdateItemParams;
    Delete?: DeleteItemParams;
    ConditionCheck?: {
      TableName: string;
      Key: Key;
      ConditionExpression: string;
      ExpressionAttributeNames?: ExpressionAttributeNames;
      ExpressionAttributeValues?: ExpressionAttributeValues;
    };
  }>;
}

export interface TransactGetItemsParams {
  TransactItems: Array<{ Get: { TableName: string; Key: Key } }>;
}

// ============================================================================
// Response Types
// ============================================================================

export interface GetItemResponse {
  Item?: Item;
}

export interface PutItemResponse {
  Attributes?: Item;
}

export interface UpdateItemResponse {
  Attributes?: Item;
}

export interface DeleteItemResponse {
  Attributes?: Item;
}

export interface QueryResponse {
  Items: Item[];
  Count: number;
  ScannedCount: number;
  LastEvaluatedKey?: Key;
}

export interface ScanResponse {
  Items: Item[];
  Count: number;
  ScannedCount: number;
  LastEvaluatedKey?: Key;
}

export interface BatchGetItemResponse {
  Responses: Record<string, Item[]>;
  UnprocessedKeys?: Record<string, { Keys: Key[] }>;
}

export interface BatchWriteItemResponse {
  UnprocessedItems?: Record<
    string,
    Array<{ PutRequest?: { Item: Item }; DeleteRequest?: { Key: Key } }>
  >;
}

export interface TransactWriteItemsResponse {
  // Empty on success
}

export interface TransactGetItemsResponse {
  Responses: Array<{ Item?: Item }>;
}

// ============================================================================
// Error Types
// ============================================================================

export class ConditionalCheckFailedException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionalCheckFailedException";
  }
}

export class ValidationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationException";
  }
}

export class ResourceNotFoundException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundException";
  }
}

export class TransactionCanceledException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionCanceledException";
  }
}

// ============================================================================
// Table Metadata
// ============================================================================

interface TableMetadata {
  tableName: string;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  globalSecondaryIndexes?: GlobalSecondaryIndex[];
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract the scalar value from an AttributeValue
 */
function getScalarValue(
  attr: AttributeValue,
): string | number | boolean | null | Uint8Array {
  if ("S" in attr) return attr.S;
  if ("N" in attr) return parseFloat(attr.N);
  if ("B" in attr) return attr.B;
  if ("BOOL" in attr) return attr.BOOL;
  if ("NULL" in attr) return null;
  throw new ValidationException("Attribute is not a scalar type");
}

/**
 * Compare two attribute values for equality
 */
function attributeValuesEqual(a: AttributeValue, b: AttributeValue): boolean {
  if ("S" in a && "S" in b) return a.S === b.S;
  if ("N" in a && "N" in b) return a.N === b.N;
  if ("BOOL" in a && "BOOL" in b) return a.BOOL === b.BOOL;
  if ("NULL" in a && "NULL" in b) return true;
  if ("B" in a && "B" in b) {
    return a.B.length === b.B.length && a.B.every((v, i) => v === b.B[i]);
  }
  if ("SS" in a && "SS" in b) {
    return a.SS.length === b.SS.length && a.SS.every((v) => b.SS.includes(v));
  }
  if ("NS" in a && "NS" in b) {
    return a.NS.length === b.NS.length && a.NS.every((v) => b.NS.includes(v));
  }
  if ("BS" in a && "BS" in b) {
    return a.BS.length === b.BS.length &&
      a.BS.every((av) =>
        b.BS.some((bv) =>
          av.length === bv.length && av.every((v, i) => v === bv[i])
        )
      );
  }
  if ("L" in a && "L" in b) {
    return a.L.length === b.L.length &&
      a.L.every((v, i) => attributeValuesEqual(v, b.L[i]));
  }
  if ("M" in a && "M" in b) {
    const aKeys = Object.keys(a.M);
    const bKeys = Object.keys(b.M);
    return aKeys.length === bKeys.length &&
      aKeys.every((k) => k in b.M && attributeValuesEqual(a.M[k], b.M[k]));
  }
  return false;
}

/**
 * Substitute expression attribute names in an expression
 */
function substituteNames(
  expr: string,
  names?: ExpressionAttributeNames,
): string {
  if (!names) return expr;
  let result = expr;
  for (const [placeholder, actualName] of Object.entries(names)) {
    result = result.replaceAll(placeholder, actualName);
  }
  return result;
}

/**
 * Parse a key condition expression into a structured format
 */
interface ParsedKeyCondition {
  partitionKey: { name: string; operator: "="; value: AttributeValue };
  sortKey?: {
    name: string;
    operator: string;
    value: AttributeValue | AttributeValue[];
  };
}

function parseKeyConditionExpression(
  expr: string,
  names?: ExpressionAttributeNames,
  values?: ExpressionAttributeValues,
): ParsedKeyCondition {
  if (!values) {
    throw new ValidationException("ExpressionAttributeValues required");
  }

  const workingExpr = substituteNames(expr, names);

  const result: ParsedKeyCondition = {
    partitionKey: { name: "", operator: "=", value: { NULL: true } },
  };

  // First, check if this contains a BETWEEN clause
  // BETWEEN needs special handling because it contains AND within it
  const betweenMatch = workingExpr.match(
    /^(\w+)\s*=\s*(:[\w]+)\s+AND\s+(\w+)\s+BETWEEN\s+(:[\w]+)\s+AND\s+(:[\w]+)$/i,
  );
  if (betweenMatch) {
    const [
      ,
      pkAttrName,
      pkValuePlaceholder,
      skAttrName,
      value1Placeholder,
      value2Placeholder,
    ] = betweenMatch;
    const pkValue = values[pkValuePlaceholder];
    const value1 = values[value1Placeholder];
    const value2 = values[value2Placeholder];
    if (!pkValue || !value1 || !value2) {
      throw new ValidationException("Expression values not found");
    }

    result.partitionKey = { name: pkAttrName, operator: "=", value: pkValue };
    result.sortKey = {
      name: skAttrName,
      operator: "BETWEEN",
      value: [value1, value2],
    };
    return result;
  }

  // Also check for BETWEEN without partition key (single condition)
  const betweenOnlyMatch = workingExpr.match(
    /^(\w+)\s+BETWEEN\s+(:[\w]+)\s+AND\s+(:[\w]+)$/i,
  );
  if (betweenOnlyMatch) {
    throw new ValidationException("Partition key condition must be equality");
  }

  // Split by AND (case-insensitive) for non-BETWEEN cases
  const parts = workingExpr.split(/\s+AND\s+/i);
  if (parts.length === 0 || parts.length > 2) {
    throw new ValidationException(
      "KeyConditionExpression must have 1 or 2 conditions",
    );
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();

    // Handle equality: attr = :value
    const eqMatch = part.match(/^(\w+)\s*=\s*(:[\w]+)$/);
    if (eqMatch) {
      const [, attrName, valuePlaceholder] = eqMatch;
      const value = values[valuePlaceholder];
      if (!value) {
        throw new ValidationException(`Value ${valuePlaceholder} not found`);
      }

      if (i === 0) {
        result.partitionKey = { name: attrName, operator: "=", value };
      } else {
        result.sortKey = { name: attrName, operator: "=", value };
      }
      continue;
    }

    // Handle comparison operators: attr < :value, attr <= :value, attr > :value, attr >= :value
    const cmpMatch = part.match(/^(\w+)\s*(<=?|>=?|<>)\s*(:[\w]+)$/);
    if (cmpMatch) {
      const [, attrName, operator, valuePlaceholder] = cmpMatch;
      const value = values[valuePlaceholder];
      if (!value) {
        throw new ValidationException(`Value ${valuePlaceholder} not found`);
      }

      if (i === 0) {
        throw new ValidationException(
          "Partition key condition must be equality",
        );
      }
      result.sortKey = { name: attrName, operator, value };
      continue;
    }

    // Handle begins_with: begins_with(attr, :value)
    const beginsMatch = part.match(/^begins_with\((\w+),\s*(:[\w]+)\)$/i);
    if (beginsMatch) {
      const [, attrName, valuePlaceholder] = beginsMatch;
      const value = values[valuePlaceholder];
      if (!value) {
        throw new ValidationException(`Value ${valuePlaceholder} not found`);
      }

      if (i === 0) {
        throw new ValidationException(
          "Partition key condition must be equality",
        );
      }
      result.sortKey = { name: attrName, operator: "begins_with", value };
      continue;
    }

    throw new ValidationException(`Invalid key condition: ${part}`);
  }

  return result;
}

/**
 * Evaluate a condition expression against an item
 */
function evaluateConditionExpression(
  expr: string,
  item: Item | null,
  names?: ExpressionAttributeNames,
  values?: ExpressionAttributeValues,
): boolean {
  const workingExpr = substituteNames(expr, names);

  // Handle attribute_exists
  const existsMatch = workingExpr.match(/^attribute_exists\((\w+)\)$/);
  if (existsMatch) {
    return item !== null && existsMatch[1] in item;
  }

  // Handle attribute_not_exists
  const notExistsMatch = workingExpr.match(/^attribute_not_exists\((\w+)\)$/);
  if (notExistsMatch) {
    return item === null || !(notExistsMatch[1] in item);
  }

  if (!item) return false;
  if (!values) {
    throw new ValidationException("ExpressionAttributeValues required");
  }

  // Handle equality: attr = :value
  const eqMatch = workingExpr.match(/^(\w+)\s*=\s*(:[\w]+)$/);
  if (eqMatch) {
    const [, attrName, valuePlaceholder] = eqMatch;
    const expectedValue = values[valuePlaceholder];
    if (!expectedValue) {
      throw new ValidationException(`Value ${valuePlaceholder} not found`);
    }
    const actualValue = item[attrName];
    if (!actualValue) return false;
    return attributeValuesEqual(actualValue, expectedValue);
  }

  // Handle inequality: attr <> :value
  const neqMatch = workingExpr.match(/^(\w+)\s*<>\s*(:[\w]+)$/);
  if (neqMatch) {
    const [, attrName, valuePlaceholder] = neqMatch;
    const expectedValue = values[valuePlaceholder];
    if (!expectedValue) {
      throw new ValidationException(`Value ${valuePlaceholder} not found`);
    }
    const actualValue = item[attrName];
    if (!actualValue) return true;
    return !attributeValuesEqual(actualValue, expectedValue);
  }

  // Handle comparison operators
  const cmpMatch = workingExpr.match(/^(\w+)\s*(<=?|>=?)\s*(:[\w]+)$/);
  if (cmpMatch) {
    const [, attrName, operator, valuePlaceholder] = cmpMatch;
    const compareValue = values[valuePlaceholder];
    if (!compareValue) {
      throw new ValidationException(`Value ${valuePlaceholder} not found`);
    }
    const actualValue = item[attrName];
    if (!actualValue) return false;

    const actual = getScalarValue(actualValue);
    const compare = getScalarValue(compareValue);

    // Null safety checks for comparisons
    if (actual === null || compare === null) return false;

    switch (operator) {
      case "<":
        return actual < compare;
      case "<=":
        return actual <= compare;
      case ">":
        return actual > compare;
      case ">=":
        return actual >= compare;
      default:
        throw new ValidationException(`Unknown operator: ${operator}`);
    }
  }

  // Handle begins_with
  const beginsMatch = workingExpr.match(/^begins_with\((\w+),\s*(:[\w]+)\)$/);
  if (beginsMatch) {
    const [, attrName, valuePlaceholder] = beginsMatch;
    if (!values) {
      throw new ValidationException("ExpressionAttributeValues required");
    }
    const prefixValue = values[valuePlaceholder];
    if (!prefixValue || !("S" in prefixValue)) {
      throw new ValidationException("begins_with requires string value");
    }
    const actualValue = item[attrName];
    if (!actualValue || !("S" in actualValue)) return false;
    return actualValue.S.startsWith(prefixValue.S);
  }

  // Handle contains
  const containsMatch = workingExpr.match(/^contains\((\w+),\s*(:[\w]+)\)$/);
  if (containsMatch) {
    const [, attrName, valuePlaceholder] = containsMatch;
    if (!values) {
      throw new ValidationException("ExpressionAttributeValues required");
    }
    const searchValue = values[valuePlaceholder];
    if (!searchValue) {
      throw new ValidationException(`Value ${valuePlaceholder} not found`);
    }
    const actualValue = item[attrName];
    if (!actualValue) return false;

    if ("S" in actualValue && "S" in searchValue) {
      return actualValue.S.includes(searchValue.S);
    }
    if ("SS" in actualValue && "S" in searchValue) {
      return actualValue.SS.includes(searchValue.S);
    }
    if ("NS" in actualValue && "N" in searchValue) {
      return actualValue.NS.includes(searchValue.N);
    }
    if ("L" in actualValue) {
      return actualValue.L.some((v) => attributeValuesEqual(v, searchValue));
    }
    return false;
  }

  // Handle AND
  if (workingExpr.includes(" AND ")) {
    const parts = workingExpr.split(" AND ");
    return parts.every((part) =>
      evaluateConditionExpression(part.trim(), item, names, values)
    );
  }

  // Handle OR
  if (workingExpr.includes(" OR ")) {
    const parts = workingExpr.split(" OR ");
    return parts.some((part) =>
      evaluateConditionExpression(part.trim(), item, names, values)
    );
  }

  throw new ValidationException(
    `Unsupported condition expression: ${workingExpr}`,
  );
}

/**
 * Parse an update expression into structured operations
 */
interface UpdateOperation {
  action: "SET" | "REMOVE" | "ADD" | "DELETE";
  path: string;
  value?: AttributeValue;
}

function parseUpdateExpression(
  expr: string,
  names?: ExpressionAttributeNames,
  values?: ExpressionAttributeValues,
): UpdateOperation[] {
  const operations: UpdateOperation[] = [];
  const workingExpr = substituteNames(expr, names);

  // Split by clause keywords
  const clauses = workingExpr.split(/\b(SET|REMOVE|ADD|DELETE)\b/i).filter((
    s,
  ) => s.trim());

  let currentAction: "SET" | "REMOVE" | "ADD" | "DELETE" | null = null;

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (/^(SET|REMOVE|ADD|DELETE)$/i.test(trimmed)) {
      currentAction = trimmed.toUpperCase() as
        | "SET"
        | "REMOVE"
        | "ADD"
        | "DELETE";
      continue;
    }

    if (!currentAction) continue;

    // Split by comma to handle multiple operations in same clause
    const parts = trimmed.split(",").map((s) => s.trim());

    for (const part of parts) {
      if (!part) continue;

      if (currentAction === "SET") {
        // SET path = value
        const match = part.match(/^(\w+(?:\.\w+|\[\d+\])*)\s*=\s*(.+)$/);
        if (match) {
          const [, path, valueExpr] = match;
          const valuePlaceholder = valueExpr.trim();
          if (values && valuePlaceholder.startsWith(":")) {
            const value = values[valuePlaceholder];
            if (!value) {
              throw new ValidationException(
                `Value ${valuePlaceholder} not found`,
              );
            }
            operations.push({ action: "SET", path, value });
          } else {
            throw new ValidationException(`Invalid SET expression: ${part}`);
          }
        }
      } else if (currentAction === "REMOVE") {
        // REMOVE path
        operations.push({ action: "REMOVE", path: part });
      } else if (currentAction === "ADD") {
        // ADD path value
        const match = part.match(/^(\w+(?:\.\w+|\[\d+\])*)\s+(.+)$/);
        if (match) {
          const [, path, valueExpr] = match;
          const valuePlaceholder = valueExpr.trim();
          if (values && valuePlaceholder.startsWith(":")) {
            const value = values[valuePlaceholder];
            if (!value) {
              throw new ValidationException(
                `Value ${valuePlaceholder} not found`,
              );
            }
            operations.push({ action: "ADD", path, value });
          }
        }
      } else if (currentAction === "DELETE") {
        // DELETE path value
        const match = part.match(/^(\w+(?:\.\w+|\[\d+\])*)\s+(.+)$/);
        if (match) {
          const [, path, valueExpr] = match;
          const valuePlaceholder = valueExpr.trim();
          if (values && valuePlaceholder.startsWith(":")) {
            const value = values[valuePlaceholder];
            if (!value) {
              throw new ValidationException(
                `Value ${valuePlaceholder} not found`,
              );
            }
            operations.push({ action: "DELETE", path, value });
          }
        }
      }
    }
  }

  return operations;
}

/**
 * Apply update operations to an item
 */
function applyUpdateExpression(
  item: Item,
  operations: UpdateOperation[],
): Item {
  const result = { ...item };

  for (const op of operations) {
    if (op.action === "SET") {
      if (!op.value) throw new ValidationException("SET requires a value");
      result[op.path] = op.value;
    } else if (op.action === "REMOVE") {
      delete result[op.path];
    } else if (op.action === "ADD") {
      if (!op.value) throw new ValidationException("ADD requires a value");
      const existing = result[op.path];

      if ("N" in op.value) {
        // Numeric add
        if (!existing) {
          result[op.path] = op.value;
        } else if ("N" in existing) {
          const sum = parseFloat(existing.N) + parseFloat(op.value.N);
          result[op.path] = { N: sum.toString() };
        }
      } else if ("SS" in op.value || "NS" in op.value || "BS" in op.value) {
        // Set add
        if (!existing) {
          result[op.path] = op.value;
        } else if ("SS" in existing && "SS" in op.value) {
          const combined = new Set([...existing.SS, ...op.value.SS]);
          result[op.path] = { SS: Array.from(combined) };
        } else if ("NS" in existing && "NS" in op.value) {
          const combined = new Set([...existing.NS, ...op.value.NS]);
          result[op.path] = { NS: Array.from(combined) };
        } else if ("BS" in existing && "BS" in op.value) {
          result[op.path] = { BS: [...existing.BS, ...op.value.BS] };
        }
      }
    } else if (op.action === "DELETE") {
      if (!op.value) throw new ValidationException("DELETE requires a value");
      const existing = result[op.path];

      if (existing) {
        if ("SS" in existing && "SS" in op.value) {
          const opValue = op.value;
          if ("SS" in opValue) {
            const filtered = existing.SS.filter((v) => !opValue.SS.includes(v));
            if (filtered.length > 0) {
              result[op.path] = { SS: filtered };
            } else {
              delete result[op.path];
            }
          }
        } else if ("NS" in existing && "NS" in op.value) {
          const opValue = op.value;
          if ("NS" in opValue) {
            const filtered = existing.NS.filter((v) => !opValue.NS.includes(v));
            if (filtered.length > 0) {
              result[op.path] = { NS: filtered };
            } else {
              delete result[op.path];
            }
          }
        } else if ("BS" in existing && "BS" in op.value) {
          const opValue = op.value;
          if ("BS" in opValue) {
            const filtered = existing.BS.filter(
              (ev) =>
                !opValue.BS.some((ov: Uint8Array) =>
                  ev.every((b, i) => b === ov[i])
                ),
            );
            if (filtered.length > 0) {
              result[op.path] = { BS: filtered };
            } else {
              delete result[op.path];
            }
          }
        }
      }
    }
  }

  return result;
}

/**
 * Apply projection expression to an item
 */
function applyProjection(
  item: Item,
  projection?: string,
  names?: ExpressionAttributeNames,
): Item {
  if (!projection) return item;

  const workingProjection = substituteNames(projection, names);
  const attributes = workingProjection.split(",").map((s) => s.trim());

  const result: Item = {};
  for (const attr of attributes) {
    if (attr in item) {
      result[attr] = item[attr];
    }
  }
  return result;
}

/**
 * Check if sort key matches the condition
 */
function sortKeyMatches(
  sortKeyValue: AttributeValue,
  condition: ParsedKeyCondition["sortKey"],
): boolean {
  if (!condition) return true;

  const value = condition.value;

  switch (condition.operator) {
    case "=":
      return attributeValuesEqual(sortKeyValue, value as AttributeValue);
    case "<>":
      return !attributeValuesEqual(sortKeyValue, value as AttributeValue);
    case "<": {
      const actual = getScalarValue(sortKeyValue);
      const compare = getScalarValue(value as AttributeValue);
      if (actual === null || compare === null) return false;
      return actual < compare;
    }
    case "<=": {
      const actual = getScalarValue(sortKeyValue);
      const compare = getScalarValue(value as AttributeValue);
      if (actual === null || compare === null) return false;
      return actual <= compare;
    }
    case ">": {
      const actual = getScalarValue(sortKeyValue);
      const compare = getScalarValue(value as AttributeValue);
      if (actual === null || compare === null) return false;
      return actual > compare;
    }
    case ">=": {
      const actual = getScalarValue(sortKeyValue);
      const compare = getScalarValue(value as AttributeValue);
      if (actual === null || compare === null) return false;
      return actual >= compare;
    }
    case "BETWEEN": {
      const actual = getScalarValue(sortKeyValue);
      const [v1, v2] = value as AttributeValue[];
      const compare1 = getScalarValue(v1);
      const compare2 = getScalarValue(v2);
      if (actual === null || compare1 === null || compare2 === null) {
        return false;
      }
      return actual >= compare1 && actual <= compare2;
    }
    case "begins_with": {
      const attrValue = value as AttributeValue;
      if (!("S" in sortKeyValue) || !("S" in attrValue)) return false;
      return sortKeyValue.S.startsWith(attrValue.S);
    }
    default:
      return false;
  }
}

// ============================================================================
// Table Class
// ============================================================================

/**
 * DynamoDB-like table implementation using Deno KV
 */
export class Table {
  private kv: Deno.Kv;
  private tableName: string;
  private keySchema: KeySchemaElement[];
  private attributeDefinitions: AttributeDefinition[];
  private globalSecondaryIndexes?: GlobalSecondaryIndex[];

  /**
   * Create a new table instance
   *
   * @param tableName - Name of the table
   * @param keySchema - Primary key schema (hash and optional range key)
   * @param attributeDefinitions - Attribute definitions for key attributes
   * @param globalSecondaryIndexes - Optional GSI definitions
   * @param kv - Deno KV instance
   */
  constructor(
    tableName: string,
    keySchema: KeySchemaElement[],
    attributeDefinitions: AttributeDefinition[],
    globalSecondaryIndexes?: GlobalSecondaryIndex[],
    kv: Deno.Kv = undefined as unknown as Deno.Kv,
  ) {
    this.tableName = tableName;
    this.keySchema = keySchema;
    this.attributeDefinitions = attributeDefinitions;
    this.globalSecondaryIndexes = globalSecondaryIndexes;

    // Validate key schema
    if (keySchema.length === 0 || keySchema.length > 2) {
      throw new ValidationException("KeySchema must have 1 or 2 elements");
    }

    const hashKeys = keySchema.filter((k) => k.KeyType === "HASH");
    const rangeKeys = keySchema.filter((k) => k.KeyType === "RANGE");

    if (hashKeys.length !== 1) {
      throw new ValidationException("KeySchema must have exactly one HASH key");
    }
    if (rangeKeys.length > 1) {
      throw new ValidationException("KeySchema can have at most one RANGE key");
    }

    // KV must be provided
    if (!kv) {
      throw new ValidationException("Deno.Kv instance is required");
    }
    this.kv = kv;
  }

  /**
   * Initialize the table by storing metadata in Deno KV
   */
  async initialize(): Promise<void> {
    const metadata: TableMetadata = {
      tableName: this.tableName,
      keySchema: this.keySchema,
      attributeDefinitions: this.attributeDefinitions,
      globalSecondaryIndexes: this.globalSecondaryIndexes,
    };

    await this.kv.set(["table", this.tableName, "meta"], metadata);
  }

  /**
   * Load table metadata from Deno KV
   */
  static async load(tableName: string, kv?: Deno.Kv): Promise<Table> {
    const kvInstance = kv || await Deno.openKv();
    const result = await kvInstance.get<TableMetadata>([
      "table",
      tableName,
      "meta",
    ]);

    if (!result.value) {
      throw new ResourceNotFoundException(`Table ${tableName} not found`);
    }

    const { keySchema, attributeDefinitions, globalSecondaryIndexes } =
      result.value;
    return new Table(
      tableName,
      keySchema,
      attributeDefinitions,
      globalSecondaryIndexes,
      kvInstance,
    );
  }

  /**
   * Get primary key values from an item or key
   */
  private getPrimaryKeyValues(keyOrItem: Key | Item): Deno.KvKey {
    const hashKey = this.keySchema.find((k) => k.KeyType === "HASH");
    const rangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

    if (!hashKey) throw new ValidationException("No hash key in schema");

    const hashValue = keyOrItem[hashKey.AttributeName];
    if (!hashValue) {
      throw new ValidationException(
        `Missing hash key: ${hashKey.AttributeName}`,
      );
    }

    const pkValue = getScalarValue(hashValue);
    if (pkValue === null) {
      throw new ValidationException(
        `Hash key cannot be null: ${hashKey.AttributeName}`,
      );
    }

    if (rangeKey) {
      const rangeValue = keyOrItem[rangeKey.AttributeName];
      if (!rangeValue) {
        throw new ValidationException(
          `Missing range key: ${rangeKey.AttributeName}`,
        );
      }
      const skValue = getScalarValue(rangeValue);
      if (skValue === null) {
        throw new ValidationException(
          `Range key cannot be null: ${rangeKey.AttributeName}`,
        );
      }
      return ["table", this.tableName, "item", pkValue, skValue];
    }

    return ["table", this.tableName, "item", pkValue];
  }

  /**
   * Get GSI key values from an item
   *
   * GSI key structure needs to include the primary table keys to ensure uniqueness.
   * For a GSI with hash key only: ["table", tableName, "gsi", indexName, gsiPK, primaryPK, primarySK?]
   * For a GSI with hash and range: ["table", tableName, "gsi", indexName, gsiPK, gsiSK, primaryPK, primarySK?]
   */
  private getGSIKeyValues(
    gsi: GlobalSecondaryIndex,
    item: Item,
  ): Deno.KvKey | null {
    const gsiHashKey = gsi.KeySchema.find((k) => k.KeyType === "HASH");
    const gsiRangeKey = gsi.KeySchema.find((k) => k.KeyType === "RANGE");

    if (!gsiHashKey) return null;

    const gsiHashValue = item[gsiHashKey.AttributeName];
    if (!gsiHashValue) return null;

    const gsiPKValue = getScalarValue(gsiHashValue);
    if (gsiPKValue === null) return null;

    // Get primary table keys for uniqueness
    const primaryHashKey = this.keySchema.find((k) => k.KeyType === "HASH")!;
    const primaryRangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

    const primaryPKValue = getScalarValue(item[primaryHashKey.AttributeName]);
    if (primaryPKValue === null) return null;

    // Build key parts array
    const keyParts: Array<Deno.KvKeyPart> = [
      "table",
      this.tableName,
      "gsi",
      gsi.IndexName,
      gsiPKValue,
    ];

    if (gsiRangeKey) {
      const gsiRangeValue = item[gsiRangeKey.AttributeName];
      if (!gsiRangeValue) return null;
      const gsiSKValue = getScalarValue(gsiRangeValue);
      if (gsiSKValue === null) return null;
      keyParts.push(gsiSKValue);
    }

    // Always add primary table keys to ensure uniqueness
    keyParts.push(primaryPKValue);
    if (primaryRangeKey) {
      const primarySKValue = getScalarValue(
        item[primaryRangeKey.AttributeName],
      );
      if (primarySKValue !== null) {
        keyParts.push(primarySKValue);
      }
    }

    return keyParts as Deno.KvKey;
  }

  /**
   * Update GSI pointers for an item
   */
  private updateGSIPointers(
    atomic: Deno.AtomicOperation,
    item: Item,
    oldItem?: Item,
  ): Deno.AtomicOperation {
    if (!this.globalSecondaryIndexes) return atomic;

    const hashKey = this.keySchema.find((k) => k.KeyType === "HASH");
    const rangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

    const primaryKey = {
      pk: item[hashKey!.AttributeName],
      ...(rangeKey ? { sk: item[rangeKey.AttributeName] } : {}),
    };

    for (const gsi of this.globalSecondaryIndexes) {
      // Remove old GSI pointer if it exists
      if (oldItem) {
        const oldGSIKey = this.getGSIKeyValues(gsi, oldItem);
        if (oldGSIKey) {
          atomic.delete(oldGSIKey);
        }
      }

      // Add new GSI pointer
      const newGSIKey = this.getGSIKeyValues(gsi, item);
      if (newGSIKey) {
        atomic.set(newGSIKey, primaryKey);
      }
    }

    return atomic;
  }

  /**
   * Get an item by primary key
   */
  async getItem(params: GetItemParams): Promise<GetItemResponse> {
    const itemKey = this.getPrimaryKeyValues(params.Key);
    const result = await this.kv.get<Item>(itemKey);

    if (!result.value) {
      return {};
    }

    const item = applyProjection(
      result.value,
      params.ProjectionExpression,
      params.ExpressionAttributeNames,
    );
    return { Item: item };
  }

  /**
   * Put an item into the table
   */
  async putItem(params: PutItemParams): Promise<PutItemResponse> {
    const itemKey = this.getPrimaryKeyValues(params.Item);

    // Get existing item if needed
    const existingResult =
      params.ConditionExpression || params.ReturnValues === "ALL_OLD"
        ? await this.kv.get<Item>(itemKey)
        : null;

    const existingItem = existingResult?.value || null;

    // Check condition
    if (params.ConditionExpression) {
      const conditionMet = evaluateConditionExpression(
        params.ConditionExpression,
        existingItem,
        params.ExpressionAttributeNames,
        params.ExpressionAttributeValues,
      );

      if (!conditionMet) {
        throw new ConditionalCheckFailedException("Condition not satisfied");
      }
    }

    // Build atomic operation
    let atomic = this.kv.atomic();

    if (existingResult) {
      atomic = atomic.check(existingResult);
    }

    atomic.set(itemKey, params.Item);

    // Update GSI pointers
    atomic = this.updateGSIPointers(
      atomic,
      params.Item,
      existingItem || undefined,
    );

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      throw new ConditionalCheckFailedException("Atomic operation failed");
    }

    return params.ReturnValues === "ALL_OLD"
      ? { Attributes: existingItem || undefined }
      : {};
  }

  /**
   * Update an item in the table
   */
  async updateItem(params: UpdateItemParams): Promise<UpdateItemResponse> {
    const itemKey = this.getPrimaryKeyValues(params.Key);

    // Get existing item
    const existingResult = await this.kv.get<Item>(itemKey);
    const existingItem = existingResult?.value || null;

    // Check condition
    if (params.ConditionExpression) {
      const conditionMet = evaluateConditionExpression(
        params.ConditionExpression,
        existingItem,
        params.ExpressionAttributeNames,
        params.ExpressionAttributeValues,
      );

      if (!conditionMet) {
        throw new ConditionalCheckFailedException("Condition not satisfied");
      }
    }

    // Parse and apply update expression
    const operations = parseUpdateExpression(
      params.UpdateExpression,
      params.ExpressionAttributeNames,
      params.ExpressionAttributeValues,
    );

    const baseItem = existingItem || { ...params.Key };
    const updatedItem = applyUpdateExpression(baseItem, operations);

    // Build atomic operation
    let atomic = this.kv.atomic();
    if (existingResult) {
      atomic = atomic.check(existingResult);
    }

    atomic.set(itemKey, updatedItem);

    // Update GSI pointers
    atomic = this.updateGSIPointers(
      atomic,
      updatedItem,
      existingItem || undefined,
    );

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      throw new ConditionalCheckFailedException("Atomic operation failed");
    }

    // Return values based on ReturnValues parameter
    let returnedAttributes: Item | undefined;
    switch (params.ReturnValues) {
      case "ALL_OLD":
        returnedAttributes = existingItem || undefined;
        break;
      case "ALL_NEW":
        returnedAttributes = updatedItem;
        break;
      case "UPDATED_OLD":
      case "UPDATED_NEW":
        // TODO: Track which attributes were actually updated
        returnedAttributes = updatedItem;
        break;
      default:
        returnedAttributes = undefined;
    }

    return { Attributes: returnedAttributes };
  }

  /**
   * Delete an item from the table
   */
  async deleteItem(params: DeleteItemParams): Promise<DeleteItemResponse> {
    const itemKey = this.getPrimaryKeyValues(params.Key);

    // Get existing item
    const existingResult = await this.kv.get<Item>(itemKey);
    const existingItem = existingResult?.value || null;

    if (!existingItem) {
      return {};
    }

    // Check condition
    if (params.ConditionExpression) {
      const conditionMet = evaluateConditionExpression(
        params.ConditionExpression,
        existingItem,
        params.ExpressionAttributeNames,
        params.ExpressionAttributeValues,
      );

      if (!conditionMet) {
        throw new ConditionalCheckFailedException("Condition not satisfied");
      }
    }

    // Build atomic operation
    const atomic = this.kv.atomic().check(existingResult).delete(itemKey);

    // Remove GSI pointers
    if (this.globalSecondaryIndexes) {
      for (const gsi of this.globalSecondaryIndexes) {
        const gsiKey = this.getGSIKeyValues(gsi, existingItem);
        if (gsiKey) {
          atomic.delete(gsiKey);
        }
      }
    }

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      throw new ConditionalCheckFailedException("Atomic operation failed");
    }

    return params.ReturnValues === "ALL_OLD"
      ? { Attributes: existingItem }
      : {};
  }

  /**
   * Query items by key condition
   */
  async query(params: QueryParams): Promise<QueryResponse> {
    const keyCondition = parseKeyConditionExpression(
      params.KeyConditionExpression,
      params.ExpressionAttributeNames,
      params.ExpressionAttributeValues,
    );

    let items: Item[] = [];
    let scannedCount = 0;

    if (params.IndexName) {
      // Query GSI
      const gsi = this.globalSecondaryIndexes?.find((g) =>
        g.IndexName === params.IndexName
      );
      if (!gsi) {
        throw new ResourceNotFoundException(
          `Index ${params.IndexName} not found`,
        );
      }

      const gsiHashKey = gsi.KeySchema.find((k) => k.KeyType === "HASH")!;
      const gsiRangeKey = gsi.KeySchema.find((k) => k.KeyType === "RANGE");

      // Validate GSI hash key type
      const gsiHashAttrDef = this.attributeDefinitions.find(
        (a) => a.AttributeName === gsiHashKey.AttributeName,
      );
      if (gsiHashAttrDef) {
        const pkAttr = keyCondition.partitionKey.value;
        const expectedType = gsiHashAttrDef.AttributeType;
        const actualType = Object.keys(pkAttr)[0];
        if (actualType !== expectedType) {
          throw new ValidationException(
            `Type mismatch for key ${gsiHashKey.AttributeName} expected: ${expectedType} actual: ${actualType}`,
          );
        }
      }

      const pkValue = getScalarValue(keyCondition.partitionKey.value);
      if (pkValue === null) {
        throw new ValidationException("Partition key cannot be null");
      }
      const baseKey: Deno.KvKey = [
        "table",
        this.tableName,
        "gsi",
        params.IndexName,
        pkValue,
      ];

      // List GSI pointers
      const gsiEntries = this.kv.list<
        { pk: AttributeValue; sk?: AttributeValue }
      >({
        prefix: baseKey,
      });

      const pointers: Array<{ pk: AttributeValue; sk?: AttributeValue }> = [];
      for await (const entry of gsiEntries) {
        scannedCount++;

        // Check sort key condition on GSI key
        // The GSI sort key value is stored in the entry.key, not entry.value
        // GSI key structure:
        // - With GSI hash only: ["table", tableName, "gsi", indexName, gsiPK, primaryPK, primarySK?]
        // - With GSI hash+range: ["table", tableName, "gsi", indexName, gsiPK, gsiSK, primaryPK, primarySK?]
        if (keyCondition.sortKey && gsiRangeKey) {
          // gsiSK would be at index 5 (after gsiPK at index 4)
          if (entry.key.length > 5) {
            const gsiSKValue = entry.key[5];
            // Reconstruct AttributeValue from the scalar value
            const gsiRangeAttrDef = this.attributeDefinitions.find(
              (a) => a.AttributeName === gsiRangeKey.AttributeName,
            );
            if (gsiRangeAttrDef) {
              let gsiSortKeyValue: AttributeValue;
              if (gsiRangeAttrDef.AttributeType === "S") {
                gsiSortKeyValue = { S: gsiSKValue as string };
              } else if (gsiRangeAttrDef.AttributeType === "N") {
                gsiSortKeyValue = { N: String(gsiSKValue) };
              } else {
                gsiSortKeyValue = { B: gsiSKValue as Uint8Array };
              }

              if (!sortKeyMatches(gsiSortKeyValue, keyCondition.sortKey)) {
                continue;
              }
            }
          }
        }

        pointers.push(entry.value);

        if (params.Limit && pointers.length >= params.Limit) break;
      }

      // Fetch actual items
      const primaryKeys: Deno.KvKey[] = [];
      for (const pointer of pointers) {
        const hashKey = this.keySchema.find((k) => k.KeyType === "HASH")!;
        const rangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

        // Validate primary hash key type
        const hashAttrDef = this.attributeDefinitions.find(
          (a) => a.AttributeName === hashKey.AttributeName,
        );
        if (hashAttrDef && pointer.pk) {
          const actualType = Object.keys(pointer.pk)[0];
          if (actualType !== hashAttrDef.AttributeType) {
            throw new ValidationException(
              `Type mismatch for key ${hashKey.AttributeName} expected: ${hashAttrDef.AttributeType} actual: ${actualType}`,
            );
          }
        }

        const pkValue = getScalarValue(pointer.pk);
        if (pkValue === null) continue; // Skip if null

        if (rangeKey && pointer.sk) {
          const skValue = getScalarValue(pointer.sk);
          if (skValue === null) continue; // Skip if null
          primaryKeys.push(["table", this.tableName, "item", pkValue, skValue]);
        } else {
          primaryKeys.push(["table", this.tableName, "item", pkValue]);
        }
      }

      const itemResults = await this.kv.getMany<Item[]>(primaryKeys);
      items = itemResults.map((r) => r.value).filter((v): v is Item =>
        v !== null
      );
    } else {
      // Query primary index
      const pkValue = getScalarValue(keyCondition.partitionKey.value);
      if (pkValue === null) {
        throw new ValidationException("Partition key cannot be null");
      }

      // Check if table has a range key
      const rangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

      if (!rangeKey) {
        // No range key - item is stored at exact key, not under a prefix
        const itemKey: Deno.KvKey = ["table", this.tableName, "item", pkValue];
        const entry = await this.kv.get<Item>(itemKey);
        if (entry.value) {
          scannedCount = 1;
          // Respect Limit parameter even for single item
          if (params.Limit === undefined || params.Limit > 0) {
            items.push(entry.value);
          }
        }
      } else {
        // Has range key - use list with prefix
        const baseKey: Deno.KvKey = ["table", this.tableName, "item", pkValue];
        const entries = this.kv.list<Item>({ prefix: baseKey });

        for await (const entry of entries) {
          scannedCount++;

          // Check sort key condition
          if (keyCondition.sortKey) {
            const sortKeyValue = entry.value[rangeKey.AttributeName];
            if (
              !sortKeyValue ||
              !sortKeyMatches(sortKeyValue, keyCondition.sortKey)
            ) {
              continue;
            }
          }

          items.push(entry.value);

          if (params.Limit && items.length >= params.Limit) break;
        }
      }
    }

    // Apply filter expression
    if (params.FilterExpression) {
      items = items.filter((item) =>
        evaluateConditionExpression(
          params.FilterExpression!,
          item,
          params.ExpressionAttributeNames,
          params.ExpressionAttributeValues,
        )
      );
    }

    // Reverse if needed
    if (params.ScanIndexForward === false) {
      items.reverse();
    }

    return {
      Items: items,
      Count: items.length,
      ScannedCount: scannedCount,
    };
  }

  /**
   * Scan all items in the table
   */
  async scan(params: ScanParams): Promise<ScanResponse> {
    const items: Item[] = [];
    let scannedCount = 0;

    if (params.IndexName) {
      // Scan GSI
      const gsi = this.globalSecondaryIndexes?.find((g) =>
        g.IndexName === params.IndexName
      );
      if (!gsi) {
        throw new ResourceNotFoundException(
          `Index ${params.IndexName} not found`,
        );
      }

      const gsiPrefix = ["table", this.tableName, "gsi", params.IndexName];
      const gsiEntries = this.kv.list<
        { pk: AttributeValue; sk?: AttributeValue }
      >({ prefix: gsiPrefix });

      const pointers: Array<{ pk: AttributeValue; sk?: AttributeValue }> = [];
      for await (const entry of gsiEntries) {
        scannedCount++;
        pointers.push(entry.value);

        if (params.Limit && pointers.length >= params.Limit) break;
      }

      // Fetch actual items
      const primaryKeys: Deno.KvKey[] = [];
      for (const pointer of pointers) {
        const hashKey = this.keySchema.find((k) => k.KeyType === "HASH")!;
        const rangeKey = this.keySchema.find((k) => k.KeyType === "RANGE");

        // Validate primary hash key type
        const hashAttrDef = this.attributeDefinitions.find(
          (a) => a.AttributeName === hashKey.AttributeName,
        );
        if (hashAttrDef && pointer.pk) {
          const actualType = Object.keys(pointer.pk)[0];
          if (actualType !== hashAttrDef.AttributeType) {
            throw new ValidationException(
              `Type mismatch for key ${hashKey.AttributeName} expected: ${hashAttrDef.AttributeType} actual: ${actualType}`,
            );
          }
        }

        const pkValue = getScalarValue(pointer.pk);
        if (pkValue === null) continue; // Skip if null

        if (rangeKey && pointer.sk) {
          const skValue = getScalarValue(pointer.sk);
          if (skValue === null) continue; // Skip if null
          primaryKeys.push(["table", this.tableName, "item", pkValue, skValue]);
        } else {
          primaryKeys.push(["table", this.tableName, "item", pkValue]);
        }
      }

      const itemResults = await this.kv.getMany<Item[]>(primaryKeys);
      items.push(
        ...itemResults.map((r) => r.value).filter((v): v is Item => v !== null),
      );
    } else {
      // Scan primary index
      const prefix = ["table", this.tableName, "item"];
      const entries = this.kv.list<Item>({ prefix });

      for await (const entry of entries) {
        scannedCount++;
        items.push(entry.value);

        if (params.Limit && items.length >= params.Limit) break;
      }
    }

    // Apply filter expression
    let filteredItems = items;
    if (params.FilterExpression) {
      filteredItems = items.filter((item) =>
        evaluateConditionExpression(
          params.FilterExpression!,
          item,
          params.ExpressionAttributeNames,
          params.ExpressionAttributeValues,
        )
      );
    }

    return {
      Items: filteredItems,
      Count: filteredItems.length,
      ScannedCount: scannedCount,
    };
  }

  /**
   * Batch get items
   */
  async batchGetItem(
    params: BatchGetItemParams,
  ): Promise<BatchGetItemResponse> {
    const responses: Record<string, Item[]> = {};

    for (const [tableName, request] of Object.entries(params.RequestItems)) {
      if (tableName !== this.tableName) {
        throw new ValidationException(
          `Table name mismatch: ${tableName} vs ${this.tableName}`,
        );
      }

      const keys = request.Keys.map((key) => this.getPrimaryKeyValues(key));

      // Chunk keys into groups of 10 (Deno KV limit)
      const chunks: Deno.KvKey[][] = [];
      for (let i = 0; i < keys.length; i += 10) {
        chunks.push(keys.slice(i, i + 10));
      }

      // Fetch all chunks
      const allResults: Deno.KvEntryMaybe<Item>[] = [];
      for (const chunk of chunks) {
        const results = await this.kv.getMany<Item[]>(chunk);
        allResults.push(...results);
      }

      responses[tableName] = allResults.map((r) => r.value).filter((
        v,
      ): v is Item => v !== null);
    }

    return { Responses: responses };
  }

  /**
   * Batch write items
   */
  async batchWriteItem(
    params: BatchWriteItemParams,
  ): Promise<BatchWriteItemResponse> {
    for (const [tableName, requests] of Object.entries(params.RequestItems)) {
      if (tableName !== this.tableName) {
        throw new ValidationException(
          `Table name mismatch: ${tableName} vs ${this.tableName}`,
        );
      }

      let atomic = this.kv.atomic();

      for (const request of requests) {
        if (request.PutRequest) {
          const itemKey = this.getPrimaryKeyValues(request.PutRequest.Item);
          atomic.set(itemKey, request.PutRequest.Item);

          // Update GSI pointers
          atomic = this.updateGSIPointers(atomic, request.PutRequest.Item);
        } else if (request.DeleteRequest) {
          const itemKey = this.getPrimaryKeyValues(request.DeleteRequest.Key);
          const existingResult = await this.kv.get<Item>(itemKey);

          if (existingResult.value) {
            atomic.delete(itemKey);

            // Remove GSI pointers
            if (this.globalSecondaryIndexes) {
              for (const gsi of this.globalSecondaryIndexes) {
                const gsiKey = this.getGSIKeyValues(gsi, existingResult.value);
                if (gsiKey) {
                  atomic.delete(gsiKey);
                }
              }
            }
          }
        }
      }

      const result = await atomic.commit();
      if (!result.ok) {
        throw new Error("Batch write failed");
      }
    }

    return {};
  }

  /**
   * Transactional write
   */
  async transactWriteItems(
    params: TransactWriteItemsParams,
  ): Promise<TransactWriteItemsResponse> {
    let atomic = this.kv.atomic();

    for (const item of params.TransactItems) {
      if (item.Put) {
        const itemKey = this.getPrimaryKeyValues(item.Put.Item);

        if (item.Put.ConditionExpression) {
          const existingResult = await this.kv.get<Item>(itemKey);
          const conditionMet = evaluateConditionExpression(
            item.Put.ConditionExpression,
            existingResult.value,
          );

          if (!conditionMet) {
            throw new TransactionCanceledException("Condition check failed");
          }
        }

        atomic.set(itemKey, item.Put.Item);
        atomic = this.updateGSIPointers(atomic, item.Put.Item);
      } else if (item.Update) {
        const itemKey = this.getPrimaryKeyValues(item.Update.Key);
        const existingResult = await this.kv.get<Item>(itemKey);
        const existingItem = existingResult?.value || null;

        if (item.Update.ConditionExpression) {
          const conditionMet = evaluateConditionExpression(
            item.Update.ConditionExpression,
            existingItem,
            item.Update.ExpressionAttributeNames,
            item.Update.ExpressionAttributeValues,
          );

          if (!conditionMet) {
            throw new TransactionCanceledException("Condition check failed");
          }
        }

        const operations = parseUpdateExpression(
          item.Update.UpdateExpression,
          item.Update.ExpressionAttributeNames,
          item.Update.ExpressionAttributeValues,
        );

        const baseItem = existingItem || { ...item.Update.Key };
        const updatedItem = applyUpdateExpression(baseItem, operations);

        atomic.set(itemKey, updatedItem);
        atomic = this.updateGSIPointers(
          atomic,
          updatedItem,
          existingItem || undefined,
        );
      } else if (item.Delete) {
        const itemKey = this.getPrimaryKeyValues(item.Delete.Key);
        const existingResult = await this.kv.get<Item>(itemKey);
        const existingItem = existingResult?.value;

        if (item.Delete.ConditionExpression && existingItem) {
          const conditionMet = evaluateConditionExpression(
            item.Delete.ConditionExpression,
            existingItem,
            item.Delete.ExpressionAttributeNames,
            item.Delete.ExpressionAttributeValues,
          );

          if (!conditionMet) {
            throw new TransactionCanceledException("Condition check failed");
          }
        }

        if (existingItem) {
          atomic.delete(itemKey);

          if (this.globalSecondaryIndexes) {
            for (const gsi of this.globalSecondaryIndexes) {
              const gsiKey = this.getGSIKeyValues(gsi, existingItem);
              if (gsiKey) {
                atomic.delete(gsiKey);
              }
            }
          }
        }
      } else if (item.ConditionCheck) {
        const itemKey = this.getPrimaryKeyValues(item.ConditionCheck.Key);
        const existingResult = await this.kv.get<Item>(itemKey);

        const conditionMet = evaluateConditionExpression(
          item.ConditionCheck.ConditionExpression,
          existingResult.value,
          item.ConditionCheck.ExpressionAttributeNames,
          item.ConditionCheck.ExpressionAttributeValues,
        );

        if (!conditionMet) {
          throw new TransactionCanceledException("Condition check failed");
        }
      }
    }

    const result = await atomic.commit();
    if (!result.ok) {
      throw new TransactionCanceledException("Transaction failed to commit");
    }

    return {};
  }

  /**
   * Transactional get
   */
  async transactGetItems(
    params: TransactGetItemsParams,
  ): Promise<TransactGetItemsResponse> {
    const keys = params.TransactItems.map((item) =>
      this.getPrimaryKeyValues(item.Get.Key)
    );
    const results = await this.kv.getMany<Item[]>(keys);

    return {
      Responses: results.map((result) => ({ Item: result.value || undefined })),
    };
  }

  /**
   * Close the KV connection
   */
  close(): void {
    this.kv.close();
  }
}
