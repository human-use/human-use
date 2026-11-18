self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  event.waitUntil(self.registration.showNotification("human-use", {
    body: "A card is ready.",
    icon: "/icon-192.png",
    tag: "human-use-card"
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const active = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && (url.pathname === "/" || url.pathname === "/unit.html");
    });
    if (active) await active.focus();
    else await self.clients.openWindow("/");
  })());
});
