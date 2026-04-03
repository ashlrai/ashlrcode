/**
 * IPC — Inter-Process Communication via Unix Domain Sockets.
 * Allows multiple AshlrCode instances to discover and message each other.
 *
 * Each running instance registers itself by writing a .json peer-info file
 * and listening on a .sock Unix domain socket. Other instances discover
 * peers by scanning the sockets directory and can send newline-delimited
 * JSON messages over the socket.
 */

import { createServer, connect, type Server, type Socket } from "net";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────

export interface PeerInfo {
  id: string;
  pid: number;
  cwd: string;
  sessionId: string;
  startedAt: string;
  socketPath: string;
}

export interface IPCMessage {
  from: string;
  to: string;
  type: "ping" | "pong" | "message" | "task" | "result";
  payload: string;
  timestamp: string;
}

// ── Internal state ───────────────────────────────────────────────────

function getSocketsDir(): string {
  return join(getConfigDir(), "sockets");
}

function getSocketPath(id: string): string {
  return join(getSocketsDir(), `${id}.sock`);
}

function getPeerInfoPath(id: string): string {
  return join(getSocketsDir(), `${id}.json`);
}

let _server: Server | null = null;
let _peerId: string | null = null;
let _inbox: IPCMessage[] = [];
let _onMessage: ((msg: IPCMessage) => void) | null = null;

// ── Server lifecycle ─────────────────────────────────────────────────

/**
 * Start listening for IPC messages on a Unix domain socket.
 * Registers this instance as a discoverable peer.
 */
export async function startIPCServer(
  sessionId: string,
  cwd: string,
  onMessage?: (msg: IPCMessage) => void,
): Promise<string> {
  const dir = getSocketsDir();
  await mkdir(dir, { recursive: true });

  // Clean up sockets left behind by dead processes
  await cleanStaleSockets();

  _peerId = randomUUID().slice(0, 8);
  _onMessage = onMessage ?? null;
  const socketPath = getSocketPath(_peerId);

  // Write peer info so other instances can discover us
  const peerInfo: PeerInfo = {
    id: _peerId,
    pid: process.pid,
    cwd,
    sessionId,
    startedAt: new Date().toISOString(),
    socketPath,
  };
  await writeFile(getPeerInfoPath(_peerId), JSON.stringify(peerInfo), "utf-8");

  // Create the UDS server
  _server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete trailing line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as IPCMessage;
          _inbox.push(msg);
          _onMessage?.(msg);
        } catch {
          // Ignore malformed messages
        }
      }
    });
  });

  // Remove leftover socket file if it exists
  if (existsSync(socketPath)) {
    await unlink(socketPath).catch(() => {});
  }

  _server.listen(socketPath);
  return _peerId;
}

/**
 * Stop the IPC server and remove this peer's registration files.
 */
export async function stopIPCServer(): Promise<void> {
  if (_server) {
    _server.close();
    _server = null;
  }
  if (_peerId) {
    await unlink(getSocketPath(_peerId)).catch(() => {});
    await unlink(getPeerInfoPath(_peerId)).catch(() => {});
    _peerId = null;
  }
  _inbox = [];
  _onMessage = null;
}

// ── Peer discovery ───────────────────────────────────────────────────

/**
 * List all active AshlrCode peers (including self).
 * Dead peers whose process no longer exists are excluded.
 */
export async function listPeers(): Promise<PeerInfo[]> {
  const dir = getSocketsDir();
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const peers: PeerInfo[] = [];

  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const peer = JSON.parse(raw) as PeerInfo;

      // Verify the process is still alive (signal 0 = existence check)
      try {
        process.kill(peer.pid, 0);
        peers.push(peer);
      } catch {
        // Process is dead — skip (cleanup happens on server start)
      }
    } catch {
      // Corrupt file — skip
    }
  }

  return peers;
}

// ── Messaging ────────────────────────────────────────────────────────

/**
 * Send a message to a specific peer by ID.
 * Returns true if the message was delivered, false otherwise.
 */
export async function sendToPeer(
  peerId: string,
  type: IPCMessage["type"],
  payload: string,
): Promise<boolean> {
  const peers = await listPeers();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) return false;

  const msg: IPCMessage = {
    from: _peerId ?? "unknown",
    to: peerId,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };

  return new Promise<boolean>((resolve) => {
    const socket = connect(peer.socketPath, () => {
      socket.write(JSON.stringify(msg) + "\n");
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    // 5-second timeout to avoid hanging
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 5000);
    socket.on("close", () => clearTimeout(timer));
  });
}

/**
 * Read and clear the inbox — returns all messages received since last read.
 */
export function readInbox(): IPCMessage[] {
  const msgs = [..._inbox];
  _inbox = [];
  return msgs;
}

/**
 * Peek at inbox without clearing it.
 */
export function peekInbox(): readonly IPCMessage[] {
  return _inbox;
}

/**
 * Get this instance's peer ID (null if IPC server not started).
 */
export function getPeerId(): string | null {
  return _peerId;
}

// ── Maintenance ──────────────────────────────────────────────────────

/**
 * Remove socket and info files for peers whose process is no longer alive.
 */
async function cleanStaleSockets(): Promise<void> {
  const dir = getSocketsDir();
  if (!existsSync(dir)) return;

  const files = await readdir(dir);

  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const peer = JSON.parse(raw) as PeerInfo;
      try {
        process.kill(peer.pid, 0);
      } catch {
        // Process is dead — clean up both files
        await unlink(join(dir, file)).catch(() => {});
        await unlink(peer.socketPath).catch(() => {});
      }
    } catch {
      // Corrupt info file — remove it
      await unlink(join(dir, file)).catch(() => {});
    }
  }
}
