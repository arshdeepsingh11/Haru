"use client";

import { useEffect } from "react";

/** Registers the service worker (needed for push). Never asks for permission by itself. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* unsupported or blocked — notifications UI explains the fallback */
    });
  }, []);
  return null;
}
