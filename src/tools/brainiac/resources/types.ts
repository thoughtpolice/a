// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

// Resource handler type definition
export type ResourceHandler<T = Record<string, string>> = (
  uri: URL,
  params?: T,
) => Promise<ReadResourceResult> | ReadResourceResult;

// Static resource definition (no parameters)
export interface StaticResourceDefinition {
  name: string;
  description: string;
  uri: string;
  mimeType?: string;
  handler: ResourceHandler<never>;
}

// Dynamic resource definition (with parameters)
export interface DynamicResourceDefinition<T = Record<string, string>> {
  name: string;
  description: string;
  uriTemplate: string;
  mimeType?: string;
  handler: ResourceHandler<T>;
}

// Union type for all resource definitions
export type ResourceDefinition<T = Record<string, string>> =
  | StaticResourceDefinition
  | DynamicResourceDefinition<T>;

// Type guard to check if resource is dynamic
export function isDynamicResource<T>(
  resource: ResourceDefinition<T>,
): resource is DynamicResourceDefinition<T> {
  return "uriTemplate" in resource;
}

// Type guard to check if resource is static
export function isStaticResource(
  resource: ResourceDefinition,
): resource is StaticResourceDefinition {
  return "uri" in resource;
}
