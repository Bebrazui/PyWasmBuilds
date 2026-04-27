import type { RuntimeConfig, ValidationResult } from '../types.js';
import { ConfigValidationError } from '../errors/index.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const CONFIG_SCHEMA: Record<keyof RuntimeConfig, { type: string; default: unknown }> = {
  pythonVersion:      { type: 'string',  default: '3.13' },
  wasmUrl:            { type: 'string',  default: null },
  persistenceBackend: { type: 'string',  default: 'opfs' },
  autoSyncInterval:   { type: 'number',  default: 5000 },
  executionTimeout:   { type: 'number',  default: 30000 },
  allowedSyscalls:    { type: 'array',   default: null },
};

const KNOWN_FIELDS = new Set(Object.keys(CONFIG_SCHEMA));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesSchemaType(value: unknown, schemaType: string): boolean {
  if (value === null) return true; // null is allowed for nullable fields
  return getActualType(value) === schemaType;
}

// ─── ConfigParser ─────────────────────────────────────────────────────────────

export class ConfigParser {
  /**
   * Parses a raw unknown value into a RuntimeConfig, applying defaults from CONFIG_SCHEMA.
   * Warns about unknown fields via console.warn.
   * Throws ConfigValidationError if a known field has an incorrect type.
   */
  parse(raw: unknown): RuntimeConfig {
    const input: Record<string, unknown> =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    // Warn about unknown fields
    for (const key of Object.keys(input)) {
      if (!KNOWN_FIELDS.has(key)) {
        console.warn(`[ConfigParser] Unknown configuration field: "${key}"`);
      }
    }

    const result: Partial<RuntimeConfig> = {};

    for (const [field, schema] of Object.entries(CONFIG_SCHEMA) as [keyof RuntimeConfig, { type: string; default: unknown }][]) {
      const rawValue = Object.prototype.hasOwnProperty.call(input, field)
        ? input[field]
        : undefined;

      if (rawValue === undefined) {
        // Apply default
        (result as Record<string, unknown>)[field] = schema.default;
      } else {
        // Validate type before accepting
        if (!matchesSchemaType(rawValue, schema.type)) {
          throw new ConfigValidationError(
            field,
            schema.type,
            `Configuration field "${field}" must be of type ${schema.type}, got ${getActualType(rawValue)}`,
          );
        }
        (result as Record<string, unknown>)[field] = rawValue;
      }
    }

    return result as RuntimeConfig;
  }

  /**
   * Validates a RuntimeConfig object, returning a ValidationResult with any type errors.
   * Does NOT throw — collects all errors and returns them.
   */
  validate(config: RuntimeConfig): ValidationResult {
    const errors: ValidationResult['errors'] = [];

    for (const [field, schema] of Object.entries(CONFIG_SCHEMA) as [keyof RuntimeConfig, { type: string; default: unknown }][]) {
      const value = (config as unknown as Record<string, unknown>)[field];
      if (value === undefined) continue; // missing fields are not a type error here

      if (!matchesSchemaType(value, schema.type)) {
        errors.push({
          field,
          expectedType: schema.type,
          actualType: getActualType(value),
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Serializes a RuntimeConfig into a plain Record<string, unknown>.
   */
  serialize(config: RuntimeConfig): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of Object.keys(CONFIG_SCHEMA) as (keyof RuntimeConfig)[]) {
      result[field] = (config as unknown as Record<string, unknown>)[field];
    }
    return result;
  }
}
