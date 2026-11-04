// Diagnostic only: every database transaction is READ ONLY. No Auth login or seed.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import 'reflect-metadata';
import {isolatedSupabaseEnvironment} from '../scripts/isolated-supabase-env.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {discoveryReasons}=require('../dist/profiles/discovery.js');
const {env}=isolatedSupabaseEnvironment();
const isolation=JSON.parse(execFileSync(process.execPath,['scripts/inspect-demo-isolation.mjs'],{env,encoding:'utf8'}));
const accounts=JSON.parse(readFileSync(new URL('./showcase.credentials.local',import.meta.url))).people;
const admin=new pg.Client({connectionString:env.E2E_ADMIN_DATABASE_URL});
const app=new pg.Client({connectionString:env.DATABASE_URL});
const out={isolation,accounts:{}};
try{
 await admin.connect();await app.connect();await admin.query('BEGIN READ ONLY');
 out.universe=(await admin.query(`SELECT count(*)::int AS users,count(*) FILTER(WHERE role='renter')::int renters,count(*) FILTER(WHERE role='landlord')::int landlords FROM users`)).rows[0];
 out.constraints=(await admin.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('properties'::regclass,'leri_property_photos'::regclass,'landlord_profiles'::regclass) ORDER BY relation,conname`)).rows;
 out.triggers=(await admin.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgrelid IN ('properties'::regclass,'leri_property_photos'::regclass) AND NOT t.tgisinternal`)).rows;
 out.functions=(await admin.query(`SELECT proname,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('leri_discovery','leri_public_profile','leri_public_property','leri_valid_property_details','leri_property_transition_guard')`)).rows;
 out.propertyFacts=(await admin.query(`SELECT p.id,p.landlord_id,p.title,p.city,p.rent_amount,p.currency,p.property_rules,p.details,p.status,p.availability_status,p.details->>'epcRating' AS epc,p.details->>'postcodeDistrict' AS district,p.details->'registrationNumbers' AS registrations,p.details->>'hmoLicenceStatus' AS hmo,(SELECT count(*)::int FROM leri_property_photos ph WHERE ph.property_id=p.id AND ph.removed_at IS NULL) AS photos FROM properties p WHERE p.landlord_id=ANY($1::uuid[]) ORDER BY p.landlord_id,p.id`,[Object.values(accounts).map(a=>a.id)])).rows;
 for(const [key,account] of Object.entries(accounts)){
  await app.query('BEGIN READ ONLY');
  await app.query("SELECT set_config('app.current_user_id',$1,true)",[account.id]);
  const own=(await app.query('SELECT leri_public_profile($1) AS p',[account.id])).rows[0].p;
  const base=(await admin.query(`SELECT count(*)::int oppositeRole,count(*) FILTER(WHERE CASE WHEN u.role='renter' THEN rp.discoverable ELSE lp.discoverable END)::int visible FROM users u LEFT JOIN renter_profiles rp ON rp.user_id=u.id LEFT JOIN landlord_profiles lp ON lp.user_id=u.id WHERE u.role IN ('renter','landlord') AND u.role<>$1`,[own.kind])).rows[0];
  let candidates=[],cursor=null;const pages=[];
  do{
   const rows=(await app.query('SELECT leri_discovery($1,21) AS p',[cursor])).rows;
   const page=rows.slice(0,20).map(r=>r.p);candidates.push(...page);
   const items=page.filter(p=>discoveryReasons(own,p).length);
   pages.push({candidates:page.length,suggested:items.length,hasNext:rows.length>20});
   cursor=rows.length>20?page.at(-1).id:null;
  }while(cursor);
  let pairs=[];const projectedCities={};
  for(const other of candidates){const renter=own.kind==='renter'?own:other,landlord=own.kind==='landlord'?own:other;for(const property of landlord.properties){projectedCities[property.city]=(projectedCities[property.city]??0)+1;pairs.push({other:other.id,renter,property})}}
  const stages=[];
  const count=(stage)=>stages.push({stage,propertyPairs:pairs.length,candidates:new Set(pairs.map(p=>p.other)).size});
  count('has projected published/available property');
  const norm=x=>x.trim().toLocaleLowerCase('en-GB');
  const filters=[
   ['area',({renter:r,property:p})=>!r.preferredLocation||[p.city,p.details.publicArea,p.details.postcodeDistrict].some(v=>v&&norm(v)===norm(r.preferredLocation))],
   ['budget',({renter:r,property:p})=>(r.budgetMin===null&&r.budgetMax===null)||(p.currency==='GBP'&&(r.budgetMin===null||p.rentAmount>=r.budgetMin)&&(r.budgetMax===null||p.rentAmount<=r.budgetMax))],
   ['move date',({renter:r,property:p})=>!r.targetMoveDate||!p.details.availableFrom||p.details.availableFrom<=r.targetMoveDate],
   ['tenancy length',({renter:r,property:p})=>!r.tenancyLengthMonths||!p.details.minTenancyMonths||r.tenancyLengthMonths>=p.details.minTenancyMonths],
   ['household size',({renter:r,property:p})=>!r.householdSize||!p.details.permittedOccupants||r.householdSize<=p.details.permittedOccupants],
   ['pets',({renter:r,property:p})=>!r.householdPreferences.includes('pet_friendly')||(!p.propertyRules.includes('no_pets')&&p.details.petsPolicy!=='not_allowed')],
   ['smoking',({renter:r,property:p})=>!r.householdPreferences.includes('smoke_free')||p.details.smokingPolicy!=='allowed']
  ];
  for(const [stage,fn] of filters){pairs=pairs.filter(fn);count(stage)}
  const suggested=candidates.map(other=>({id:other.id,reasons:discoveryReasons(own,other)})).filter(x=>x.reasons.length);
  const connections=(await app.query('SELECT status,count(*)::int n FROM leri_connections GROUP BY status ORDER BY status')).rows;
  out.accounts[key]={id:account.id,role:own.kind,base,explore:candidates.length,projectedCities,pages,stages,suggested,preferences:own.kind==='renter'?{preferredLocation:own.preferredLocation,budgetMin:own.budgetMin,budgetMax:own.budgetMax,targetMoveDate:own.targetMoveDate,tenancyLengthMonths:own.tenancyLengthMonths,householdSize:own.householdSize,householdPreferences:own.householdPreferences}:{publishedProperties:own.properties.length},connections};
  await app.query('ROLLBACK');
 }
 await admin.query('ROLLBACK');
 writeFileSync(new URL('./diagnostic.local',import.meta.url),JSON.stringify(out,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({universe:out.universe,properties:out.propertyFacts,accounts:out.accounts},null,2));
}finally{await app.end();await admin.end()}
