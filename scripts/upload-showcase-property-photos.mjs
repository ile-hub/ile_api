// Approved illustrative uploads only. All database queries are read-only;
// writes use the existing authenticated owner HTTP API.
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import sharp from 'sharp';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const {env,workdir}=isolatedSupabaseEnvironment();
if(workdir!=='/private/tmp/leri-supabase-phase2-20261014-final')throw new Error('Wrong isolated target');
const isolation=JSON.parse(execFileSync(process.execPath,['scripts/inspect-demo-isolation.mjs'],{env,encoding:'utf8'}));
const manifest=JSON.parse(readFileSync('demo/assets/manifest.json','utf8'));
const allow=JSON.parse(readFileSync('demo/preview-allowlist.json','utf8'));
const credentialBytes=readFileSync('demo/showcase.credentials.local');
const credentials=JSON.parse(credentialBytes).people;
const assets=manifest.assets.filter(a=>a.type==='interior');
if(assets.length!==7||new Set(assets.map(a=>a.propertyId)).size!==7||Object.keys(allow.properties).some(id=>!assets.some(a=>a.propertyId===id)))throw new Error('Expected exact seven approved assets');
const digest=data=>createHash('sha256').update(data).digest('hex');
for(const a of assets){
 if(!resolve(a.path).startsWith(resolve('demo/assets/properties')+'/')||digest(readFileSync(a.path))!==a.sha256)throw new Error('Asset path/hash mismatch');
 const owner=allow.properties[a.propertyId];
 if(!owner||a.ownerAccountId!==allow.accounts[owner]||credentials[owner]?.id!==a.ownerAccountId)throw new Error('Invalid approved ownership map');
}
const statePath='demo/property-photo-uploads.local',reportPath='demo/property-photo-upload-verification.local',lockPath='demo/property-photo-upload.lock.local';
const lock=openSync(lockPath,'wx',0o600);
const db=new pg.Client({connectionString:env.E2E_ADMIN_DATABASE_URL});
const apiOrigin='http://localhost:3001';
const tokens={};
let state;
try{state=JSON.parse(readFileSync(statePath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;state={project:allow.project,photos:{}}}
if(state.project!==allow.project){closeSync(lock);unlinkSync(lockPath);throw new Error('Checkpoint target mismatch')}
const save=()=>writeFileSync(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const call=async(owner,path,method='GET',body)=>{
 const headers={Authorization:`Bearer ${tokens[owner]}`};
 if(body!==undefined&&!(body instanceof FormData))headers['Content-Type']='application/json';
 const response=await fetch(apiOrigin+path,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`${method} ${path}: HTTP ${response.status}`);
 return {status:response.status,body:await response.json()};
};
const snapshot=async()=>{
 const rows={};
 for(const table of ['users','renter_profiles','renter_preferences','landlord_profiles','properties','evidence_items','leri_connections','leri_messages'])
  rows[table]=(await db.query(`SELECT count(*)::int n,md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) hash FROM ${table} t`)).rows[0];
 return rows;
};
const authSnapshot=async()=>JSON.stringify((await db.query('SELECT id,email,encrypted_password FROM auth.users WHERE id=ANY($1::uuid[]) ORDER BY id',[Object.values(allow.accounts)])).rows);
const report={project:allow.project,api:apiOrigin,isolation,properties:[]};
try{
 await db.connect();await db.query('BEGIN READ ONLY');
 const before=await snapshot(),authBefore=await authSnapshot();
 const stored=(await db.query('SELECT id,landlord_id,status,published_at FROM properties WHERE id=ANY($1::uuid[])',[assets.map(a=>a.propertyId)])).rows;
 if(stored.length!==7||assets.some(a=>!stored.some(p=>p.id===a.propertyId&&p.landlord_id===a.ownerAccountId&&p.status==='draft'&&p.published_at===null)))throw new Error('Stored property/owner/draft mismatch');
 await db.query('ROLLBACK');
 const health=await fetch(apiOrigin+'/health',{signal:AbortSignal.timeout(10000)});if(!health.ok)throw new Error('API health check failed');
 for(const owner of ['amina','david','sarah']){
  const c=credentials[owner];
  const res=await fetch(env.SUPABASE_URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:c.email,password:c.password}),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error(`Local Auth failed for ${owner}: ${res.status}`);
  const session=await res.json();if(session.user.id!==c.id)throw new Error('Session ID mismatch');tokens[owner]=session.access_token;
  const me=await call(owner,'/me');if(me.body.id!==c.id||me.body.role!=='landlord')throw new Error('API owner identity mismatch');
 }
 // Preflight every property before the first upload, including retry recovery.
 const existing={};
 for(const a of assets){
  const owner=allow.properties[a.propertyId],row=(await call(owner,`/properties/${a.propertyId}`)).body;
  if(row.id!==a.propertyId||row.landlordId!==a.ownerAccountId||row.status!=='draft'||row.publishedAt!==null)throw new Error('API property mismatch');
  const photos=(await call(owner,`/properties/${a.propertyId}/photos`)).body;
  if(photos.length>1||(photos.length===1&&photos[0].fileName!==basename(a.path)))throw new Error(`Unexpected existing photos for ${a.propertyId}; refusing duplicates or replacement`);
  const saved=state.photos[a.propertyId];
  if(saved&&(saved.sha256!==a.sha256||saved.ownerId!==a.ownerAccountId||photos.length!==1||photos[0].id!==saved.photoId))throw new Error('Checkpoint/photo mismatch');
  existing[a.propertyId]=photos[0]??null;
 }
 for(const a of assets){
  const owner=allow.properties[a.propertyId];let photo=existing[a.propertyId];let action='reused';let uploadStatus=null;
  if(!photo){
   const form=new FormData();form.append('file',new Blob([readFileSync(a.path)],{type:'image/png'}),basename(a.path));
   const uploaded=await call(owner,`/properties/${a.propertyId}/photos`,'POST',form);photo=uploaded.body;uploadStatus=uploaded.status;action='uploaded';
  }
  state.photos[a.propertyId]={photoId:photo.id,ownerId:a.ownerAccountId,file:a.path,sha256:a.sha256};save();
  // Verify bytes before adopting any image found during interrupted-run recovery.
  const signed=await call(owner,`/properties/${a.propertyId}/photos/${photo.id}/download`);
  const response=await fetch(signed.body.url,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Photo retrieval failed: HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  const sourceRaw=await sharp(readFileSync(a.path)).rotate().raw().toBuffer({resolveWithObject:true});
  const servedRaw=await sharp(data).raw().toBuffer({resolveWithObject:true});
  if(sourceRaw.info.width!==servedRaw.info.width||sourceRaw.info.height!==servedRaw.info.height||digest(sourceRaw.data)!==digest(servedRaw.data))throw new Error('Retrieved image does not match the approved crop');
  const caption='Illustrative image for demo purposes — synthetic interior, not an actual home';
  let captionStatus=null;
  if(photo.caption!==caption||photo.position!==0)captionStatus=(await call(owner,`/properties/${a.propertyId}/photos/${photo.id}`,'PATCH',{caption,position:0})).status;
  const list=await call(owner,`/properties/${a.propertyId}/photos`);
  if(list.body.length!==1||list.body[0].id!==photo.id||list.body[0].caption!==caption)throw new Error('Active photo verification failed');
  const row=(await call(owner,`/properties/${a.propertyId}`)).body;
  if(row.status!=='draft'||row.publishedAt!==null)throw new Error('Unexpected publication state');
  report.properties.push({id:a.propertyId,owner,title:row.title,photoId:photo.id,action,uploadStatus,captionStatus,activePhotos:list.body.length,photoListStatus:list.status,signedUrlStatus:signed.status,imageGetStatus:response.status,approvedPixelsMatch:true,width:servedRaw.info.width,height:servedRaw.info.height,status:row.status,publishedAt:row.publishedAt});
 }
 await db.query('BEGIN READ ONLY');const after=await snapshot(),authAfter=await authSnapshot();
 report.counts=(await db.query(`SELECT (SELECT count(*)::int FROM users WHERE id=ANY($1::uuid[])) accounts,(SELECT count(*)::int FROM properties WHERE id=ANY($2::uuid[])) properties,(SELECT count(*)::int FROM leri_connections WHERE sender_id=ANY($1::uuid[]) AND recipient_id=ANY($1::uuid[])) connections,(SELECT count(*)::int FROM leri_messages m JOIN leri_connections c ON c.id=m.connection_id WHERE c.sender_id=ANY($1::uuid[]) AND c.recipient_id=ANY($1::uuid[])) messages`,[Object.values(allow.accounts),assets.map(a=>a.propertyId)])).rows[0];
 await db.query('ROLLBACK');
 report.checks={protectedRowsUnchanged:JSON.stringify(before)===JSON.stringify(after),accountIdsEmailsPasswordsUnchanged:authBefore===authAfter,credentialFileUnchanged:digest(credentialBytes)===digest(readFileSync('demo/showcase.credentials.local')),allDraft:report.properties.every(p=>p.status==='draft'&&p.publishedAt===null),exactlyOneActivePhotoEach:report.properties.every(p=>p.activePhotos===1)};
 if(Object.values(report.checks).some(v=>v!==true))throw new Error('Preservation verification failed');
 writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({properties:report.properties,counts:report.counts,checks:report.checks},null,2));
}finally{await db.end();closeSync(lock);unlinkSync(lockPath)}
