/**
 * Bridge Client — connect to a remote AshlrCode instance.
 */

export interface BridgeClientConfig {
  url: string;
  authToken: string;
}

export class BridgeClient {
  private url: string;
  private token: string;

  constructor(config: BridgeClientConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.token = config.authToken;
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const response = await fetch(`${this.url}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!response.ok) throw new Error(`Bridge error: ${response.status}`);
    return response.json();
  }

  async getStatus(): Promise<{
    mode: string;
    contextPercent: number;
    isProcessing: boolean;
    sessionId: string;
  }> {
    return this.request("/api/status");
  }

  async submit(prompt: string): Promise<{ result: string }> {
    return this.request("/api/submit", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
  }

  async getHistory(): Promise<{
    messages: Array<{ role: string; content: string }>;
  }> {
    return this.request("/api/history");
  }

  async health(): Promise<{ status: string; uptime: number }> {
    return this.request("/api/health");
  }
}
