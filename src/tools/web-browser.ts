/**
 * WebBrowserTool — headless browser automation for JavaScript-heavy pages.
 * Uses Puppeteer (if installed) for full browser rendering.
 * Fallback: errors with install instructions.
 *
 * Gated behind BROWSER_TOOL feature flag.
 */

import type { Tool, ToolContext } from "./types.ts";

interface BrowserResult {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  screenshot?: string; // base64
}

async function getPuppeteer(): Promise<any | null> {
  try {
    // Dynamic import — puppeteer may not be installed
    // @ts-expect-error — optional peer dependency
    return await import("puppeteer");
  } catch {
    try {
      // @ts-expect-error — optional peer dependency
      return await import("puppeteer-core");
    } catch {
      return null;
    }
  }
}

async function findChromePath(): Promise<string | null> {
  const paths =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "linux"
        ? ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
        : [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ];

  const { existsSync } = await import("fs");
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

let _browser: any = null;

async function getBrowser(): Promise<any> {
  if (_browser?.isConnected?.()) return _browser;
  _browser = null;

  const puppeteer = await getPuppeteer();
  if (!puppeteer) {
    throw new Error("Puppeteer not installed. Run: bun add puppeteer");
  }

  const chromePath = await findChromePath();
  _browser = await puppeteer.launch({
    headless: "new",
    executablePath: chromePath ?? undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  return _browser;
}

async function browsePage(
  url: string,
  action: string,
  selector?: string,
  value?: string,
  waitMs?: number
): Promise<BrowserResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AshlrCode/1.0"
    );

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

    if (waitMs) await page.waitForTimeout(waitMs);

    switch (action) {
      case "read":
        break; // Just read the page
      case "click":
        if (selector) {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          await page.waitForTimeout(1000);
        }
        break;
      case "type":
        if (selector && value) {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.type(selector, value);
        }
        break;
      case "screenshot": {
        const screenshotBuffer = await page.screenshot({ encoding: "base64" });
        return {
          title: await page.title(),
          url: page.url(),
          text: "",
          links: [],
          screenshot: screenshotBuffer as string,
        };
      }
    }

    // Extract page content after JS has rendered.
    // The callback runs inside the browser context (Puppeteer serializes it),
    // so DOM globals like `document` exist at runtime but not in our TS lib.
    const result: { title: string; text: string; links: Array<{ text: string; href: string }> } =
      await page.evaluate(`
        (() => {
          const title = document.title;
          const bodyText = (document.body && document.body.innerText || "").slice(0, 10000);
          const links = Array.from(document.querySelectorAll("a[href]"))
            .slice(0, 20)
            .map(a => ({
              text: (a.textContent || "").trim().slice(0, 50),
              href: a.href,
            }));
          return { title, text: bodyText, links };
        })()
      `);

    return { ...result, url: page.url() };
  } finally {
    await page.close();
  }
}

export const webBrowserTool: Tool = {
  name: "WebBrowser",

  prompt() {
    return `Browse web pages with full JavaScript rendering. Use for:
- Reading JavaScript-heavy SPAs that WebFetch can't handle
- Clicking buttons and filling forms
- Taking screenshots of web pages
- Extracting text from dynamically-rendered content

Requires Puppeteer (bun add puppeteer). Actions: read, click, type, screenshot.`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        action: {
          type: "string",
          enum: ["read", "click", "type", "screenshot"],
          description: "Action to perform on the page",
        },
        selector: {
          type: "string",
          description: "CSS selector for click/type actions",
        },
        value: {
          type: "string",
          description: "Text to type (for type action)",
        },
        waitMs: {
          type: "number",
          description: "Extra wait time in ms after page load",
        },
      },
      required: ["url", "action"],
    };
  },

  isReadOnly() {
    return true;
  },
  isDestructive() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  validateInput(input) {
    if (!input.url || typeof input.url !== "string") return "url is required";
    if (!input.action || typeof input.action !== "string") return "action is required";

    const validActions = ["read", "click", "type", "screenshot"];
    if (!validActions.includes(input.action as string)) {
      return `Invalid action: ${input.action}. Must be one of: ${validActions.join(", ")}`;
    }

    try {
      new URL(input.url as string);
    } catch {
      return "Invalid URL";
    }

    if (input.action === "click" && !input.selector) {
      return "selector is required for click action";
    }
    if (input.action === "type" && (!input.selector || !input.value)) {
      return "selector and value are required for type action";
    }

    return null;
  },

  async call(input, _context) {
    const url = input.url as string;
    const action = input.action as string;
    const selector = input.selector as string | undefined;
    const value = input.value as string | undefined;
    const waitMs = input.waitMs as number | undefined;

    try {
      const result = await browsePage(url, action, selector, value, waitMs);

      if (result.screenshot) {
        return `Screenshot captured (base64, ${result.screenshot.length} chars)\nTitle: ${result.title}\nURL: ${result.url}`;
      }

      const lines: string[] = [];
      lines.push(`Title: ${result.title}`);
      lines.push(`URL: ${result.url}`);
      lines.push("");
      lines.push(result.text.slice(0, 8000));

      if (result.links.length > 0) {
        lines.push("\nLinks:");
        for (const link of result.links.slice(0, 10)) {
          lines.push(`  [${link.text}](${link.href})`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `Browser error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Gracefully shut down the shared browser instance. */
export async function shutdownBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
