self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()||{}}catch(_){data={title:'WorkLog update',body:event.data?.text()||''}}
  const title=data.title||'WorkLog update';
  event.waitUntil(self.registration.showNotification(title,{body:data.body||'',tag:data.id||undefined,renotify:false,data:{target:data.target||'daily_activity'}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const target=event.notification.data?.target||'daily_activity';const url=new URL('/',self.location.origin);url.hash=target;
    for(const client of clients)if(client.url.startsWith(self.location.origin)){await client.focus();client.postMessage({type:'worklog-notification',target});return}
    await self.clients.openWindow(url.href);
  })());
});
