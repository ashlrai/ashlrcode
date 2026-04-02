/**
 * NotebookEdit tool — edit Jupyter notebook cells.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolContext } from "./types.ts";
import { fileHistory } from "../state/file-history.ts";

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export const notebookEditTool: Tool = {
  name: "NotebookEdit",

  prompt() {
    return `Edit a Jupyter notebook (.ipynb) cell. Operations:
- replace: Replace cell content at a given index
- insert: Insert a new cell at a given index
- delete: Delete a cell at a given index`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the .ipynb file",
        },
        operation: {
          type: "string",
          enum: ["replace", "insert", "delete"],
          description: "Operation to perform",
        },
        cell_index: {
          type: "number",
          description: "Cell index (0-based)",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "Cell type (for insert/replace)",
        },
        content: {
          type: "string",
          description: "New cell content (for insert/replace)",
        },
      },
      required: ["file_path", "operation", "cell_index"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return false; },

  validateInput(input) {
    if (!input.file_path) return "file_path is required";
    if (!input.operation) return "operation is required";
    if (input.cell_index === undefined) return "cell_index is required";
    const op = input.operation as string;
    if (op !== "delete" && !input.content) return "content is required for insert/replace";
    return null;
  },

  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path as string);
    if (!existsSync(filePath)) return `File not found: ${filePath}`;

    await fileHistory.snapshot(filePath);

    const raw = await readFile(filePath, "utf-8");
    const notebook = JSON.parse(raw) as Notebook;
    const idx = input.cell_index as number;
    const op = input.operation as string;

    if (idx < 0 || (op !== "insert" && idx >= notebook.cells.length)) {
      return `Cell index ${idx} out of range (${notebook.cells.length} cells)`;
    }

    switch (op) {
      case "replace": {
        const cellType = (input.cell_type as string) ?? notebook.cells[idx]!.cell_type;
        const content = input.content as string;
        notebook.cells[idx] = {
          cell_type: cellType as NotebookCell["cell_type"],
          source: content.split("\n").map((line, i, arr) =>
            i < arr.length - 1 ? line + "\n" : line
          ),
          metadata: {},
          ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
        };
        break;
      }

      case "insert": {
        const cellType = (input.cell_type as string) ?? "code";
        const content = input.content as string;
        const newCell: NotebookCell = {
          cell_type: cellType as NotebookCell["cell_type"],
          source: content.split("\n").map((line, i, arr) =>
            i < arr.length - 1 ? line + "\n" : line
          ),
          metadata: {},
          ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
        };
        notebook.cells.splice(idx, 0, newCell);
        break;
      }

      case "delete":
        notebook.cells.splice(idx, 1);
        break;
    }

    await writeFile(filePath, JSON.stringify(notebook, null, 1) + "\n", "utf-8");
    return `${op} cell ${idx} in ${filePath} (${notebook.cells.length} cells total)`;
  },
};
