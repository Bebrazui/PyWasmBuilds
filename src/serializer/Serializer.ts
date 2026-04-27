import { SerializationDepthError } from '../errors/index.js';

const MAX_DEPTH = 100;

export class Serializer {
  readonly PYTHON_OBJECT_MARKER = '__python_object__';

  jsToJson(value: unknown): string {
    return JSON.stringify(this._toJsonValue(value, 0));
  }

  jsonToJs(json: string): unknown {
    return JSON.parse(json);
  }

  private _toJsonValue(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new SerializationDepthError(MAX_DEPTH);
    }

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this._toJsonValue(item, depth + 1));
    }

    if (typeof value === 'object') {
      // Check for python-object marker passthrough
      const obj = value as Record<string, unknown>;
      if (obj['__type'] === 'python-object' && typeof obj['repr'] === 'string') {
        return obj;
      }

      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        result[key] = this._toJsonValue(obj[key], depth + 1);
      }
      return result;
    }

    // Non-serializable (functions, symbols, etc.) — mark as python-object
    return { __type: 'python-object', repr: String(value) };
  }
}
