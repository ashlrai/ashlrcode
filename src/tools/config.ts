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
      case "list":
        return JSON.stringify(settings, null, 2);

      case "get": {
        const key = input.key as string;
        const value = getNestedValue(settings as unknown as Record<string, unknown>, key);
        if (value === undefined) return `Setting not found: ${key}`;
        return typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
      }

      case "set": {
        const key = input.key as string;
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
