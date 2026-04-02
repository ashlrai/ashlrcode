/**
 * ConfigTool — view and modify settings from within the agent.
 */

import type { Tool, ToolContext } from "./types.ts";
import { loadSettings, saveSettings } from "../config/settings.ts";

export const configTool: Tool = {
  name: "Config",

  prompt() {
    return "View or modify AshlrCode settings. Operations: 'get' (read a setting), 'set' (write a setting), 'list' (show all settings).";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["get", "set", "list"],
          description: "Operation to perform",
        },
        key: {
          type: "string",
          description: "Setting key (dot-notation, e.g. 'providers.primary.model')",
        },
        value: {
          type: "string",
          description: "Value to set (for 'set' operation)",
        },
      },
      required: ["operation"],
    };
  },

  isReadOnly() {
    return false;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    const op = input.operation as string;
    if (!["get", "set", "list"].includes(op)) {
      return "operation must be 'get', 'set', or 'list'";
    }
    if (op === "set" && (!input.key || !input.value)) {
      return "key and value are required for set operation";
    }
    return null;
  },

  async call(input, _context) {
    const op = input.operation as string;
    const settings = await loadSettings();

    switch (op) {
      case "list": {
        const sanitized = redactSecrets(JSON.parse(JSON.stringify(settings)));
        return JSON.stringify(sanitized, null, 2);
      }

      case "get": {
        const key = input.key as string;
        // Block direct access to API keys
        if (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("api_key")) {
          return "API keys are redacted for security. View them in ~/.ashlrcode/settings.json directly.";
        }
        const value = getNestedValue(settings as unknown as Record<string, unknown>, key);
        if (value === undefined) return `Setting not found: ${key}`;
        if (typeof value === "object" && value !== null) {
          // Redact any nested secrets before returning
          const sanitized = redactSecrets(JSON.parse(JSON.stringify(value)));
          return JSON.stringify(sanitized, null, 2);
        }
        return String(value);
      }

      case "set": {
        const key = input.key as string;
        // Block setting API keys via the tool (security)
        if (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("api_key")) {
          return "Cannot set API keys via Config tool. Set them as environment variables or edit ~/.ashlrcode/settings.json directly.";
        }
        const value = input.value as string;
        setNestedValue(settings as unknown as Record<string, unknown>, key, value);
        await saveSettings(settings);
        return `Set ${key} = ${value}`;
      }

      default:
        return `Unknown operation: ${op}`;
    }
  },
};

function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("api_key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")) {
      result[key] = "[redacted]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSecrets(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) =>
        typeof v === "object" && v !== null ? redactSecrets(v as Record<string, unknown>) : v
      );
    }
  }
  return result;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  // Try to parse as JSON, fallback to string
  const lastKey = keys[keys.length - 1]!;
  try {
    current[lastKey] = JSON.parse(value);
  } catch {
    current[lastKey] = value;
  }
}
