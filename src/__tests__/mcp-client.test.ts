import { test, expect, describe } from "bun:test";
import {
  MCPClient,
  MCPSSEClient,
  MCPWebSocketClient,
  createMCPClient,
} from "../mcp/client.ts";

describe("createMCPClient factory", () => {
  test("returns MCPClient for stdio config (command, no url)", () => {
    const client = createMCPClient("test-stdio", {
      command: "node",
      args: ["server.js"],
    });
    expect(client).toBeInstanceOf(MCPClient);
    expect(client.name).toBe("test-stdio");
  });

  test("returns MCPSSEClient for http:// url", () => {
    const client = createMCPClient("test-sse", {
      url: "http://localhost:3000",
    });
    expect(client).toBeInstanceOf(MCPSSEClient);
    expect(client.name).toBe("test-sse");
  });

  test("returns MCPSSEClient for https:// url", () => {
    const client = createMCPClient("test-sse-secure", {
      url: "https://mcp.example.com/api",
    });
    expect(client).toBeInstanceOf(MCPSSEClient);
    expect(client.name).toBe("test-sse-secure");
  });

  test("returns MCPWebSocketClient for ws:// url", () => {
    const client = createMCPClient("test-ws", {
      url: "ws://localhost:8080",
    });
    expect(client).toBeInstanceOf(MCPWebSocketClient);
    expect(client.name).toBe("test-ws");
  });

  test("returns MCPWebSocketClient for wss:// url", () => {
    const client = createMCPClient("test-wss", {
      url: "wss://mcp.example.com/ws",
    });
    expect(client).toBeInstanceOf(MCPWebSocketClient);
    expect(client.name).toBe("test-wss");
  });

  test("url matching is case-insensitive", () => {
    const client = createMCPClient("test-case", {
      url: "WS://LOCALHOST:8080",
    });
    expect(client).toBeInstanceOf(MCPWebSocketClient);
  });

  test("returns MCPClient for config with no url and no command", () => {
    const client = createMCPClient("test-empty", {});
    expect(client).toBeInstanceOf(MCPClient);
  });
});

describe("MCPClient", () => {
  test("is not connected initially", () => {
    const client = new MCPClient("test", { command: "echo" });
    expect(client.isConnected).toBe(false);
  });

  test("tools array is empty initially", () => {
    const client = new MCPClient("test", { command: "echo" });
    expect(client.tools).toEqual([]);
  });

  test("name is set correctly", () => {
    const client = new MCPClient("my-server", { command: "node" });
    expect(client.name).toBe("my-server");
  });
});

describe("MCPSSEClient", () => {
  test("is not connected initially", () => {
    const client = new MCPSSEClient("test", { url: "http://localhost:3000" });
    expect(client.isConnected).toBe(false);
  });

  test("tools array is empty initially", () => {
    const client = new MCPSSEClient("test", { url: "http://localhost:3000" });
    expect(client.tools).toEqual([]);
  });

  test("name is set correctly", () => {
    const client = new MCPSSEClient("sse-server", { url: "http://localhost:3000" });
    expect(client.name).toBe("sse-server");
  });
});

describe("MCPWebSocketClient", () => {
  test("is not connected initially", () => {
    const client = new MCPWebSocketClient("test", { url: "ws://localhost:8080" });
    expect(client.isConnected).toBe(false);
  });

  test("tools array is empty initially", () => {
    const client = new MCPWebSocketClient("test", { url: "ws://localhost:8080" });
    expect(client.tools).toEqual([]);
  });

  test("name is set correctly", () => {
    const client = new MCPWebSocketClient("ws-server", { url: "ws://localhost:8080" });
    expect(client.name).toBe("ws-server");
  });

  test("disconnect on unconnected client does not throw", async () => {
    const client = new MCPWebSocketClient("test", { url: "ws://localhost:8080" });
    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});
