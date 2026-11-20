import {createHash,createECDH} from 'node:crypto'
import {Buffer} from 'node:buffer'
import {createRemoteJWKSet,jwtVerify} from 'npm:jose@6.1.0'

const githubKeys=createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'))
export async function scheduledIdentity(request:Request) {
  const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if(!token)return false
  try{
    const {payload}=await jwtVerify(token,githubKeys,{issuer:'https://token.actions.githubusercontent.com',audience:'worklog-reminders',maxTokenAge:'5m'})
    return payload.repository==='sadiqmartialorg-cell/Tade'
      &&payload.ref==='refs/heads/main'
      &&payload.workflow_ref==='sadiqmartialorg-cell/Tade/.github/workflows/worklog-reminders.yml@refs/heads/main'
      &&['schedule','workflow_dispatch'].includes(String(payload.event_name))
  }catch{return false}
}
export function vapidKeys(secret:string){
  // Domain separation keeps the push signing key independent of service-role use.
  const digest=createHash('sha256').update('WorkLog VAPID v1\0').update(secret).digest('hex')
  const order=BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
  const scalar=BigInt('0x'+digest)%(order-1n)+1n
  const privateKey=Buffer.from(scalar.toString(16).padStart(64,'0'),'hex')
  const curve=createECDH('prime256v1');curve.setPrivateKey(privateKey)
  return {publicKey:curve.getPublicKey().toString('base64url'),privateKey:privateKey.toString('base64url')}
}
