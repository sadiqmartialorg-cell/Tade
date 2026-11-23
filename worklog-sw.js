self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
const reminderTime=new Intl.DateTimeFormat('en-IN',{
  timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true,
});
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()||{}}catch(_){data={title:'WorkLog update',body:event.data?.text()||''}}
  const urgent=data.urgent===true;
  const title=data.test===true?'WorkLog test · Action needed':urgent?`Action needed · ${data.title}`:data.title||'WorkLog update';
  const dueAt=Date.parse(data.deadline);
  const deadline=Number.isFinite(dueAt)?`Due ${reminderTime.format(dueAt)} IST`:'';
  const body=[data.body,deadline].filter(Boolean).join('\n');
  const target=data.target==='roster'?'roster':'daily_activity';
  event.waitUntil((async()=>{
    await self.registration.showNotification(title,{
      body,icon:'/worklog-notification.png',tag:data.id||undefined,requireInteraction:urgent,
      actions:[{action:'open',title:target==='roster'?'View roster':'Open activity'}],data:{target},
    });
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clients){
      if(data.test===true&&data.id)client.postMessage({type:'worklog-push-received',id:data.id});
      else if(client.visibilityState==='visible')client.postMessage({type:'worklog-inbox-changed'});
    }
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const target=event.notification.data?.target||'daily_activity';const url=new URL('/',self.location.origin);url.hash=target;
    for(const client of clients)if(client.url.startsWith(self.location.origin)){await client.focus();client.postMessage({type:'worklog-notification',target});return}
    await self.clients.openWindow(url.href);
  })());
});
