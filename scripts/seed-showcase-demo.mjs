// Guarded API-only seed. Never loads .env, resets, migrates or deletes data.
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const manifest = JSON.parse(readFileSync(new URL('../demo/manifest.json', import.meta.url)));
if (!manifest.approved) throw new Error('Manifest requires resolved owner-copy conflicts and approval; see demo/PLAN.md');
if (manifest.people.length !== 6) throw new Error('Six people and approved properties required');
const {env,workdir} = isolatedSupabaseEnvironment();
if (workdir !== '/private/tmp/leri-supabase-phase2-20261014-final') throw new Error('Wrong isolated workspace');
const isolation=JSON.parse(execFileSync(process.execPath,['scripts/inspect-demo-isolation.mjs'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const origin='http://127.0.0.1:3000';
// Verify the actual API process target; a caller-supplied URL is never trusted.
// Start a dedicated app from this process using the verified environment.
const {spawn}=await import('node:child_process');
if (!existsSync('dist/main.js')) throw new Error('Run npm run build first');
const lock='demo/showcase.lock.local', statePath='demo/showcase.credentials.local';
const fd=openSync(lock,'wx',0o600);
let child;
try {
 const state=existsSync(statePath)?JSON.parse(readFileSync(statePath)): {people:{},steps:{}};
 const save=()=>writeFileSync(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
 const appEnv={...env,PORT:'3109',HOST:'127.0.0.1'};
 delete appEnv.SUPABASE_SERVICE_ROLE_KEY; delete appEnv.E2E_ADMIN_DATABASE_URL; delete appEnv.SUPABASE_JWT_SECRET;
 child=spawn(process.execPath,['dist/main.js'],{env:appEnv,stdio:'ignore'});
 const apiOrigin=origin.replace(':3000',':3109');
 await new Promise((resolve,reject)=>{child.once('exit',()=>reject(new Error('Isolated API exited')));setTimeout(resolve,2500)});
 const call=async(base,path,method='GET',body,headers={})=>{
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.json();
 };
 const authHeaders={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
 const tokens={};
 for(const p of manifest.people){
  let account=state.people[p.key];
  if(!account){account=state.people[p.key]={email:`leri-showcase-20261029-${p.key}@example.test`,password:randomBytes(24).toString('base64url')};save()}
  if(!account.id){
   // Recover only this namespace after a lost response; never change an existing password.
   const list=await call(env.SUPABASE_URL,'/auth/v1/admin/users?page=1&per_page=1000','GET',undefined,authHeaders);
   let user=list.users.find(u=>u.email===account.email);
   if(user && user.user_metadata?.demo_namespace!=='leri-showcase-20261029') throw new Error('Account namespace collision');
   user??=await call(env.SUPABASE_URL,'/auth/v1/admin/users','POST',{email:account.email,password:account.password,email_confirm:true,user_metadata:{role:p.role,display_name:p.profile.displayName,demo_namespace:'leri-showcase-20261029'}},authHeaders);
   account.id=user.id;save();
  }
  const session=await call(env.SUPABASE_URL,'/auth/v1/token?grant_type=password','POST',{email:account.email,password:account.password},{apikey:env.SUPABASE_ANON_KEY});tokens[p.key]=session.access_token;
 }
 // Existing schema supports an honest demo marker, separate from successful checks.
 const {default:pg}=await import('pg');
 const markerDb=new pg.Pool({connectionString:env.E2E_ADMIN_DATABASE_URL});
 try{
  for(const p of manifest.people){
   const table=p.role==='landlord'?'landlord_profiles':'renter_profiles';
   const result=await markerDb.query(`UPDATE ${table} SET is_demo=true WHERE user_id=$1 AND EXISTS(SELECT 1 FROM auth.users a WHERE a.id=$1 AND a.raw_user_meta_data->>'demo_namespace'='leri-showcase-20261029')`,[state.people[p.key].id]);
   if(result.rowCount!==1)throw new Error('Demo marker ownership check failed');
  }
 }finally{await markerDb.end()}
 const api=(key,path,method='GET',body)=>call(apiOrigin,path,method,body,{Authorization:`Bearer ${tokens[key]}`});
 for(const p of manifest.people){
  if(!state.steps[p.key]){await api(p.key,'/me/profile','PATCH',p.profile);state.steps[p.key]=true;save()}
  for(const catalogueId of p.evidence??[]){
   const items=await api(p.key,'/evidence');
   if(!items.some(e=>e.catalogueId===catalogueId)) await api(p.key,'/evidence','POST',{catalogueId,pillar:catalogueId.split('.')[0],payload:{},explanation:'Synthetic demo: evidence type shared; no private document uploaded.'});
  }
 }
 // Properties are created once, with their returned IDs durably checkpointed.
 for(const p of manifest.properties){
  const step='property:'+p.key;
  if(!state.steps[step]){
   const owned=await api(p.owner,'/properties/me');
   const matches=owned.filter(x=>x.details?.privateReference===`showcase:${p.key}`);
   if(matches.length>1)throw new Error('Duplicate property marker');
   const row=matches[0]??await api(p.owner,'/properties','POST',{...p.payload,details:{...p.payload.details,privateReference:`showcase:${p.key}`}});
   state.steps[step]=row.id;save();
  }
  const propertyId=state.steps[step];
  const revision=createHash('sha256').update(JSON.stringify(p.payload)).digest('hex');
  if(state.steps[step+':revision']!==revision){
   const existing=await api(p.owner,`/properties/${propertyId}`);
   if(existing.status!=='draft')throw new Error('Refusing to overwrite a published property');
   await api(p.owner,`/properties/${propertyId}`,'PATCH',p.payload);
   state.steps[step+':revision']=revision;save();
  }
  for(const photo of p.photos??[]){
   const caption=photo.caption;
   const photos=await api(p.owner,`/properties/${propertyId}/photos`);
   if(!photos.some(x=>x.caption===caption)){
    const form=new FormData();form.append('file',new Blob([readFileSync(photo.path)],{type:photo.mimeType}),'synthetic-demo-photo');
    const response=await fetch(`${apiOrigin}/properties/${propertyId}/photos`,{method:'POST',headers:{Authorization:`Bearer ${tokens[p.owner]}`},body:form});
    if(!response.ok)throw new Error(`Photo upload: ${response.status}`);
    const uploaded=await response.json();
    await api(p.owner,`/properties/${propertyId}/photos/${uploaded.id}`,'PATCH',{caption});
   }
  }
  const current=await api(p.owner,`/properties/${propertyId}`);
  const required=['publicArea','postcodeDistrict','depositAmount','availableFrom','minTenancyMonths','propertyType','bathrooms','permittedOccupants','furnishing','councilTaxBand','epcRating','hmoLicenceStatus'];
  const complete=required.every(k=>current.details[k]!=null)&&current.details.registrationNumbers?.length&&(p.photos??[]).length;
  if(current.status==='draft'&&complete)await api(p.owner,`/properties/${propertyId}/publish`,'POST');
  else if(!['draft','published'].includes(current.status))throw new Error('Existing property status preserved');
 }
 const landlords=['amina','david','sarah'], renters=['jamie','priya','lewis'];
 for(let i=0;i<3;i++)for(let j=0;j<3;j++){
  const accepted=i===j, sender=accepted||j===(i+1)%3?renters[j]:landlords[i],recipient=sender===renters[j]?landlords[i]:renters[j];
  const list=await api(sender,'/connections?limit=50');
  let c=list.items.find(x=>[x.senderId,x.recipientId].includes(state.people[recipient].id));
  c??=await api(sender,'/connections','POST',{recipientId:state.people[recipient].id,introduction:'I liked your profile and would enjoy discussing whether we could be a good fit.'});
  if(accepted){
   if(c.status==='pending')c=await api(recipient,`/connections/${c.id}/accept`,'POST');
   if(c.status!=='accepted')throw new Error('Existing decision preserved; demo thread unavailable');
   for(const [speaker,text] of [[renters[j],'Thanks for connecting. Could we arrange a viewing and talk through the home?'],[landlords[i],'Of course. Let’s find a time that works for both of us. What days suit you?']]){
    const messages=await api(speaker,`/connections/${c.id}/messages`);
    if(!messages.items.some(m=>m.senderId===state.people[speaker].id&&m.text===text))await api(speaker,`/connections/${c.id}/messages`,'POST',{text});
   }
  }
 }
 const report={isolation,publicationAttempts:[],blockers:manifest.unresolved,properties:{},checks:[],environment:{workdir,supabase:env.SUPABASE_URL,api:apiOrigin},accounts:{},results:{}};
 for(const p of manifest.people){
  const pages=async(path)=>{let items=[],after;do{const r=await api(p.key,path+(after?'&after='+after:''));items.push(...r.items);after=r.nextCursor}while(after);return items};
  const all=await pages('/discovery?mode=all&limit=50'),suggested=await pages('/discovery?mode=suggested&limit=50');
  const expected=manifest.people.filter(x=>x.role!==p.role).map(x=>state.people[x.key].id);
  if(!expected.every(id=>all.some(x=>x.profile.id===id)))throw new Error('Missing opposite-role demo profile');
  report.checks.push({person:p.key,oppositeRoleDemoProfiles:expected.length,profileDetails:'HTTP 200',verification:(await api(p.key,'/me/profile/preview')).verification});
  for(const x of all){
   const profile=await api(p.key,'/profiles/'+x.profile.id);
   if(profile.kind==='landlord'){
    const properties=await api(p.key,`/landlords/${profile.id}/properties`);
    for(const property of properties){
     await api(p.key,`/landlords/${profile.id}/properties/${property.id}`);
     for(const photo of property.photos){
      const response=await fetch(`${apiOrigin}/landlords/${profile.id}/properties/${property.id}/photos/${photo.id}/download`,{headers:{Authorization:`Bearer ${tokens[p.key]}`}});
      if(!response.ok)throw new Error('Public photo download failed');
     }
    }
   }
  }
  if(p.key==='jamie'){
   const amina=await api(p.key,'/profiles/'+state.people.amina.id);
   report.jamieAmina={profile:{status:200,id:amina.id,displayName:amina.displayName,properties:amina.properties},properties:{status:200,body:await api(p.key,`/landlords/${amina.id}/properties`)}};
  }
  const connections=await pages('/connections?limit=50');
  for(const c of connections){
   if(c.status==='accepted'){
    const messages=await api(p.key,`/connections/${c.id}/messages`);
    if(messages.items.length<2||new Set(messages.items.map(x=>x.senderId)).size!==2)throw new Error('Missing two-way conversation');
    report.checks.push({person:p.key,connection:c.id,twoWayMessages:messages.items.length});
   }else if(c.status==='pending'){
    for(const method of ['GET','POST']){
     const response=await fetch(`${apiOrigin}/connections/${c.id}/messages`,{method,headers:{Authorization:`Bearer ${tokens[p.key]}`,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify({text:'This must be rejected'}):undefined});
     if(response.status!==409)throw new Error('Pending conversation was not locked');
    }
   }
  }
  const own=await api(p.key,'/me/profile');
  if(own.verification.identityStatus==='verified'||own.verification.photoStatus==='verified'||own.verification.registrationStatus==='verified')throw new Error('Unexpected verification success');
  if(p.role==='landlord'){
   const owned=await api(p.key,'/properties/me');
   report.properties[p.key]=owned.map(x=>({id:x.id,status:x.status,title:x.title,details:x.details}));
   for(const property of owned){
    if(property.status==='draft'){
     const response=await fetch(`${apiOrigin}/properties/${property.id}/publish`,{method:'POST',headers:{Authorization:`Bearer ${tokens[p.key]}`}});
     report.publicationAttempts.push({id:property.id,status:response.status,response:await response.json()});
     if(response.status!==400)throw new Error('Unexpected publication outcome; inspect before continuing');
    }
   }
  }
  report.accounts[p.key]={id:state.people[p.key].id,email:state.people[p.key].email};
  report.results[p.key]={exploreAll:all.length,suggested:suggested.length,recommendations:suggested.map(x=>({id:x.profile.id,reasons:x.reasons})),connections:await pages('/connections?limit=50')};
 }
 writeFileSync('demo/verification.local',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log('Demo seed completed; private credentials: demo/showcase.credentials.local; results: demo/verification.local');
} finally {child?.kill();closeSync(fd);unlinkSync(lock)}
