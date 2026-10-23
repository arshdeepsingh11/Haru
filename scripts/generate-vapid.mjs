// Prints a fresh VAPID key pair for Web Push. Keep the private key secret (server env only).
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY="${publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${privateKey}"`);
console.log(`VAPID_SUBJECT="mailto:you@example.com"`);
