/* HARU service worker — shows push notifications, handles their buttons, confirms display.
   It does not cache the app or run timers; all scheduling happens on the server. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "HARU", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: data.tag || undefined, // same tag replaces a duplicate instead of stacking
    renotify: false,
    requireInteraction: data.kind === "shift" || data.kind === "checkout",
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    data: { url: data.url || "/", deliveryId: data.deliveryId || null, shiftId: data.shiftId || null, kind: data.kind || null },
  };
  event.waitUntil(
    self.registration.showNotification(data.title || "HARU", options).then(() => {
      // Tell HARU this device actually displayed it (separate from "push service accepted").
      if (!data.deliveryId) return;
      return fetch("/api/push/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliveryId: data.deliveryId }),
        keepalive: true,
      }).catch(() => {});
    }),
  );
});

async function openApp(path) {
  const target = new URL(path || "/", self.location.origin);
  if (target.origin !== self.location.origin) return; // never open other sites
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === target.origin && "focus" in w) {
      await w.navigate(target.href).catch(() => {});
      return w.focus();
    }
  }
  return self.clients.openWindow(target.href);
}

/** Answer a shift question straight from the notification, then confirm with the result. */
async function answer(shiftId, endpoint, payload, fallbackPath) {
  try {
    const res = await fetch(`/api/shifts/${shiftId}/${endpoint}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return openApp(fallbackPath);
    await self.registration.showNotification("HARU", {
      body: json.summary || "Saved.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: `done-${shiftId}`,
    });
  } catch {
    return openApp(fallbackPath);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const id = d.shiftId;
  if (id && event.action === "going") return event.waitUntil(answer(id, "attendance", { going: true }, "/"));
  if (id && event.action === "skip") return event.waitUntil(answer(id, "attendance", { going: false }, "/"));
  if (id && event.action === "full") return event.waitUntil(answer(id, "checkout", { full: true }, `/?checkout=${id}`));
  if (id && event.action === "partial") return event.waitUntil(openApp(`/?checkout=${id}`));
  event.waitUntil(openApp(d.url || "/"));
});

// If the browser rotates the subscription, re-register it with HARU.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const opts = event.oldSubscription && event.oldSubscription.options;
      if (!opts) return;
      const sub = await self.registration.pushManager.subscribe(opts);
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    })().catch(() => {}),
  );
});
