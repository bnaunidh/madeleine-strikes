const CACHE="madeleine-strikes-v1";
const ASSETS=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
self.addEventListener("install",e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())); });
self.addEventListener("activate",e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch",e=>{
  const req=e.request;
  if(req.method!=="GET"){ return; }
  const isDoc = req.mode==="navigate" || (req.headers.get("accept")||"").includes("text/html");
  if(isDoc){
    // network-first so new deploys show up, fall back to cached shell offline
    e.respondWith(fetch(req).then(r=>{ const cp=r.clone(); caches.open(CACHE).then(c=>c.put("./index.html",cp)); return r; }).catch(()=>caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(req).then(r=> r || fetch(req).then(resp=>{ const cp=resp.clone(); caches.open(CACHE).then(c=>c.put(req,cp)); return resp; }).catch(()=>r)));
});