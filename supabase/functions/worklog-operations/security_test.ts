import webPush from 'npm:web-push@3.6.7'
import {isBrowserPushEndpoint,scheduledIdentity,vapidKeys} from './security.ts'

Deno.test('browser push tests only send to known HTTPS push services',()=>{
  const accepted=['https://fcm.googleapis.com/fcm/send/test','https://example.notify.windows.com/w/test']
  const rejected=['http://fcm.googleapis.com/test','https://fcm.googleapis.com.example.test/test',
    'https://fcm.googleapis.com:9000/test','https://user@fcm.googleapis.com/test','https://127.0.0.1/test']
  if(!accepted.every(isBrowserPushEndpoint)||rejected.some(isBrowserPushEndpoint))throw Error('Unexpected push endpoint validation')
})

Deno.test('derived VAPID keys are stable, correctly sized, and accepted by web-push',()=>{
  const first=vapidKeys('service-role-secret-for-test')
  const second=vapidKeys('service-role-secret-for-test')
  const other=vapidKeys('different-secret-for-test')
  if(JSON.stringify(first)!==JSON.stringify(second))throw Error('VAPID key changed for the same secret')
  if(first.privateKey===other.privateKey)throw Error('VAPID key did not change with its seed')
  if(first.publicKey.length!==87||first.privateKey.length!==43)throw Error('Unexpected VAPID key length')
  webPush.setVapidDetails('mailto:sadiq.a@talview.com',first.publicKey,first.privateKey)
})

Deno.test('scheduled tick rejects missing and invalid GitHub tokens',async()=>{
  const missing=await scheduledIdentity(new Request('https://example.test'))
  const invalid=await scheduledIdentity(new Request('https://example.test',{headers:{Authorization:'Bearer invalid'}}))
  if(missing||invalid)throw Error('Unauthorized scheduler identity was accepted')
})
