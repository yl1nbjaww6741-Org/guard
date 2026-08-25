// Deliberately does nothing - present only to satisfy Chrome's Android
// installability criteria (a manifest + a registered service worker
// with a fetch handler), not to cache anything. This is a live security
// dashboard (Santa rules, MDM lockdown status, pending ratchet timers) -
// serving a cached/stale response here would be actively wrong, not
// just unhelpful, so there's no cache.put/cache.match anywhere in this
// file on purpose. Every request passes straight through to the network
// exactly as if this service worker didn't exist.
self.addEventListener("fetch", () => {
  // No event.respondWith() call - the browser handles the request
  // natively. The empty listener itself is what satisfies the
  // installability check.
});
