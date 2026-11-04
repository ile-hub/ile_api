import {execFileSync} from 'node:child_process';
import {isolatedSupabaseEnvironment} from './isolated-supabase-env.mjs';
import pg from 'pg';
const {env,workdir}=isolatedSupabaseEnvironment();
const project='leri-phase2-validation-20261014-final';
if(workdir!==`/private/tmp/${project.replace('validation-','')}` && workdir!=='/private/tmp/leri-supabase-phase2-20261014-final')throw new Error('Unexpected workdir');
const inspect=name=>JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];
const database=inspect('supabase_db_'+project),gateway=inspect('supabase_kong_'+project);
if(database.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort!=='55322'||gateway.NetworkSettings.Ports['8000/tcp']?.[0]?.HostPort!=='55321')throw new Error('Port isolation mismatch');
const db=new pg.Pool({connectionString:env.E2E_ADMIN_DATABASE_URL});
try{
 const migrations=(await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(x=>x.version);
 for(const v of ['20261014200000','20261014210000','20261014211000'])if(!migrations.includes(v))throw new Error('Missing demo migration '+v);
 const role=(await db.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='app_user'")).rows[0];
 if(!role||role.rolsuper||role.rolbypassrls)throw new Error('Unsafe application role');
 console.log(JSON.stringify({workdir,project,api:env.SUPABASE_URL,database:'127.0.0.1:55322/postgres',databaseContainer:database.Id,gatewayContainer:gateway.Id,volumes:database.Mounts.map(m=>({name:m.Name,destination:m.Destination})),migrations,applicationRole:role,originalMigrationSentinel:'missing; historical preservation cannot be reverified',proof:'Docker container identities and exact port mappings; no linked project; restricted application role'},null,2));
}finally{await db.end()}
