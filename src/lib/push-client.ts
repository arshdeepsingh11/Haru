// Browser-side push helpers shared by onboarding and settings.

export function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushSupport = { ok: true } | { ok: false; reason: string };

export function detectPushSupport(): PushSupport {
  if (typeof window === "undefined") return { ok: false, reason: "" };
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone)
    return { ok: false, reason: "On iPhone, add HARU to your Home Screen first (Share → Add to Home Screen), then turn on notifications from there." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return { ok: false, reason: "This browser can't receive push notifications. Reminders will still show inside HARU." };
  return { ok: true };
}

/** Ask permission (call only from a click), subscribe this device, and register it with HARU. */
export async function enablePush(vapidPublicKey: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const sup = detectPushSupport();
  if (!sup.ok) return { ok: false, error: sup.reason };
  if (!vapidPublicKey) return { ok: false, error: "Push isn't set up on the server yet (VAPID keys). You can turn it on later in Settings." };
  const p = await Notification.requestPermission();
  if (p !== "granted") return { ok: false, error: p === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings." : "Permission wasn't granted." };
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  if (!res.ok) return { ok: false, error: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save this device." };
  return { ok: true };
}
