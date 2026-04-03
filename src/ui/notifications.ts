/**
 * Desktop notifications — alert users when tasks complete.
 * Uses platform-native notification APIs.
 */

let _enabled = true;

export function setNotificationsEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/**
 * Send a desktop notification.
 */
export async function sendNotification(title: string, body: string): Promise<void> {
  if (!_enabled) return;

  try {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS: osascript
      const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } else if (platform === "linux") {
      // Linux: notify-send
      const proc = Bun.spawn(["notify-send", title, body], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } else if (platform === "win32") {
      // Windows: PowerShell toast
      const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); $text = $xml.GetElementsByTagName('text'); $text[0].AppendChild($xml.CreateTextNode('${title}')); $text[1].AppendChild($xml.CreateTextNode('${body}')); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AshlrCode').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
      const proc = Bun.spawn(["powershell", "-Command", script], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    }
  } catch {} // Never crash on notification failure
}

/**
 * Notify on turn completion (when terminal is unfocused).
 */
export async function notifyTurnComplete(toolCount: number, durationMs: number): Promise<void> {
  const seconds = Math.round(durationMs / 1000);
  const body = toolCount > 0
    ? `Completed with ${toolCount} tool calls (${seconds}s)`
    : `Response ready (${seconds}s)`;
  await sendNotification("AshlrCode", body);
}

/**
 * Notify on error.
 */
export async function notifyError(message: string): Promise<void> {
  await sendNotification("AshlrCode Error", message.slice(0, 100));
}
