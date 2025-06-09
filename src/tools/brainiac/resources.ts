// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";

// Re-export all resources as an array for convenience
import {
  isDynamicResource,
  isStaticResource,
  ResourceDefinition,
} from "./resources/types.ts";
import { configResource, serverInfoResource } from "./resources/appinfo.ts";
import {
  buck2TargetProvidersResource,
  buck2TargetsResource,
} from "./resources/buck2.ts";

// Registry of all available resources
// deno-lint-ignore no-explicit-any
export const RESOURCES: ResourceDefinition<any>[] = [
  configResource,
  serverInfoResource,
  buck2TargetsResource,
  buck2TargetProvidersResource,
];

// Convert resource definitions to MCP Resource format
export function convertToMcpResources(
  // deno-lint-ignore no-explicit-any
  resources: ResourceDefinition<any>[],
): Resource[] {
  return resources.map((resource) => {
    if (isStaticResource(resource)) {
      return {
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      };
    } else if (isDynamicResource(resource)) {
      return {
        uri: resource.uriTemplate,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      };
    } else {
      throw new Error(`Unknown resource type: ${resource}`);
    }
  });
}

// Parse URI template parameters
function parseUriTemplateParams(
  template: string,
  uri: string,
): Record<string, string> {
  const params: Record<string, string> = {};

  // Handle file:// URIs specially
  if (template.startsWith("file://") && uri.startsWith("file://")) {
    if (template.includes("{path}")) {
      // Extract path from file URI
      const uriParts = uri.split("?");
      const uriPath = uriParts[0];
      const path = uriPath.replace("file://", "");
      params["path"] = path;
      return params;
    }
  }

  // Simple template parsing - convert {param} to regex capture groups
  // For Buck2 targets, we need to allow //:... patterns
  const templateRegex = template.replace(/\{([^}]+)\}/g, "([^?]+)");
  const regex = new RegExp(`^${templateRegex}`);

  const match = uri.match(regex);
  if (!match) {
    return params;
  }

  // Extract parameter names from template
  const paramNames = [];
  let paramMatch;
  const paramRegex = /\{([^}]+)\}/g;
  while ((paramMatch = paramRegex.exec(template)) !== null) {
    paramNames.push(paramMatch[1]);
  }

  // Map captured values to parameter names
  for (let i = 0; i < paramNames.length && i + 1 < match.length; i++) {
    params[paramNames[i]] = match[i + 1];
  }

  return params;
}

// Parse query parameters from URI
function parseQueryParams(uri: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of uri.searchParams.entries()) {
    params[key] = value;
  }
  return params;
}

// Resource execution with parameter parsing
export async function executeResource(
  resourceUri: string,
): Promise<ReadResourceResult> {
  const uri = new URL(resourceUri);

  // Find matching resource
  let matchingResource: ResourceDefinition | undefined;
  let params: Record<string, string> = {};

  for (const resource of RESOURCES) {
    if (isStaticResource(resource)) {
      if (resource.uri === resourceUri) {
        matchingResource = resource;
        break;
      }
    } else if (isDynamicResource(resource)) {
      // Check if URI matches the template pattern
      const templateParams = parseUriTemplateParams(
        resource.uriTemplate,
        resourceUri,
      );
      if (Object.keys(templateParams).length > 0) {
        matchingResource = resource;
        params = { ...templateParams, ...parseQueryParams(uri) };
        break;
      }
    }
  }

  if (!matchingResource) {
    return {
      contents: [{
        uri: resourceUri,
        mimeType: "text/plain",
        text: `Error: Unknown resource: ${resourceUri}`,
      }],
    };
  }

  try {
    // Execute the resource handler
    let result;
    if (isStaticResource(matchingResource)) {
      result = await matchingResource.handler(uri);
    } else {
      result = await matchingResource.handler(uri, params);
    }
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      contents: [{
        uri: resourceUri,
        mimeType: "text/plain",
        text: `Error: ${errorMessage}`,
      }],
    };
  }
}

// Helper function to create resource templates for dynamic resources
// Note: ResourceTemplate is a type import and not used as a constructor here
export function createResourceTemplate(uriTemplate: string): string {
  return uriTemplate;
}
