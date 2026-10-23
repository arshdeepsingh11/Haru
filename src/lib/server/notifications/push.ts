import "server-only";
import webpush from "web-push";

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string; // same tag replaces an earlier notification on the device (duplicate guard)
  deliveryId?: string;
  kind?: string;
  shiftId?: string;
  /** Up to two buttons shown on the notification (supported on Chrome/Edge/Android). */
  actions?: { action: string; title: string }[];
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; gone: boolean; retryable: boolean; error: string };

let initialised = false;

export function pushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function init() {
  if (initialised) return;
  if (!pushConfigured()) throw new Error("Web Push is not configured (VAPID env vars missing)");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  initialised = true;
}

/** Send one push. A 2xx means the browser's push service accepted it — not that it was shown. */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushResult> {
  init();
  try {
    const res = await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { TTL: 4 * 3600, urgency: "high", timeout: 10_000, topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined },
    );
    return { ok: true, status: res.statusCode };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? null;
    const gone = status === 404 || status === 410;
    const retryable = status == null || status === 429 || status >= 500;
    const body = (e as { body?: string }).body;
    return { ok: false, status, gone, retryable, error: (body || (e as Error).message || "push failed").slice(0, 300) };
  }
}
