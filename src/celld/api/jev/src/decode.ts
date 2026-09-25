// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict decoding of API responses against the questions that were asked,
 * with the schemas in `schemas.ts`. A mismatch fails the whole response with
 * a {@link JevDecodeError} listing every issue.
 *
 * @module
 */

import { JevDecodeError } from "./errors.ts";
import {
  type DecodedResponse,
  type DecodeOptions,
  ModelListSchema,
  responseSchema,
} from "./schemas.ts";
import type { ModelCard, Questions } from "./types.ts";

/**
 * Decodes a `POST /v1/systemone` body against the questions sent.
 *
 * @throws {JevDecodeError} with every mismatch.
 */
export function decodeResponse(
  body: unknown,
  questions: Questions,
  options: DecodeOptions = {},
): DecodedResponse {
  const result = responseSchema(questions, options).safeParse(body);
  if (!result.success) throw new JevDecodeError(result.error.issues);
  return result.data;
}

/**
 * Decodes a `GET /v1/models` body.
 *
 * @throws {JevDecodeError} with every mismatch.
 */
export function decodeModels(body: unknown): ModelCard[] {
  const result = ModelListSchema.safeParse(body);
  if (!result.success) throw new JevDecodeError(result.error.issues);
  return result.data.models;
}
