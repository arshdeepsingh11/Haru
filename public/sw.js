/* HARU service worker — shows push notifications and confirms display.
   It does not cache the app or run any timers; scheduling happens on the server. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "HARU", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "HARU";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: data.tag || undefined, // same tag replaces a duplicate instead of stacking
    renotify: false,
    data: { url: data.url || "/", deliveryId: data.deliveryId || null },
  };
  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (target.origin !== self.location.origin) return; // never open other sites
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === target.origin && "focus" in w) {
          w.navigate(target.href).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
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
