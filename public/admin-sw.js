// Self-unregistering service worker (kills the previous cached version)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete all caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // Unregister self
    await self.registration.unregister();
    // Reload all clients to pick up fresh content
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.navigate(c.url);
  })());
});