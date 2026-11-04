Portrait hosting investigation — 28 October 2026

Read-only investigation against leri-phase2-validation-20261014-final only: Supabase http://127.0.0.1:55321; PostgreSQL 127.0.0.1:55322/postgres; workdir /private/tmp/leri-supabase-phase2-20261014-final. Existing isolation inspection confirmed Docker container identities, dedicated retained volume, exact ports, existing 19 migrations and restricted app_user. No bucket, policy, asset, profile, verification, trust setting or application configuration was changed. Temporary networking probe files/cache were created under /private/tmp only. No portrait uploads or profile PATCH requests were sent.

Available Storage buckets

| Bucket | Public | Object count | Limit / allowed MIME |
|---|---|---:|---|
| leri-evidence-private-v2 | false | 3 | 5 MiB; PDF, PNG, JPEG |
| leri-property-photos-v2 | false | 13 | 5 MiB; PNG, JPEG, WebP |
| phase1-private-2924f3f1-9c65-4974-bf4b-280f14336677 | false | 1 | no bucket limit/MIME restriction configured |
| phase1-private-3932ae49-08ad-4cfb-9528-49b969d13501 | false | 1 | no bucket limit/MIME restriction configured |
| phase1-private-3be7a700-c35d-45d4-91ef-b1128283f41e | false | 1 | no bucket limit/MIME restriction configured |
| phase1-private-9e86a418-b8bb-4a7c-bdf6-84af3c747a9a | false | 1 | no bucket limit/MIME restriction configured |
| phase1-private-b6ad327f-7a21-48b8-bcc5-67210e1508b6 | false | 1 | no bucket limit/MIME restriction configured |

There is no existing public demo-assets/portrait bucket. Counts are metadata only; private file contents/names were not retrieved. The property bucket includes existing historical synthetic assets as well as the seven recently uploaded property photos; it must not be repurposed as public portrait hosting.

The three existing storage.objects policies are authenticated INSERT/SELECT/DELETE, delegated to leri_storage_allowed(name,bucket_id,operation). That helper confines evidence to the owner and property media to the owner or authorized published-property renter reads. No public portrait read/write policy exists. Changing a populated private bucket to public would put other contents at risk of unauthenticated retrieval and is not proposed. Adding a separate public-only portrait host or new empty portrait bucket would leave those private files and policies untouched.

HTTPS test from the actual iOS Simulator

Device: booted iPhone 17 Pro, iOS 26.5 simulator, UDID 1B229E74-CE54-4F24-9843-C9E7D8B0051F. A temporary executable linked to the iPhone Simulator SDK used Foundation URLSession, with normal TLS validation and no trust bypass. Results:

| Transport probe | Result |
|---|---|
| http://127.0.0.1:55321/storage/v1/status | HTTP 200 |
| https://127.0.0.1:55321/storage/v1/status | NSURLErrorDomain -1200: TLS secure connection failed |
| https://localhost:55321/storage/v1/status | NSURLErrorDomain -1200: TLS secure connection failed |

These were Storage status probes, not invented portrait URLs or image retrieval claims. They establish simulator reachability of HTTP and the lack of a working HTTPS listener at the configured Storage origin. Merely changing the URL scheme does not add TLS. No local 443 listener or running cloudflared/ngrok/Caddy/nginx/tailscale process was found in the inspected host process list. No approved external HTTPS asset origin was found in the project configuration inspected during the asset audit. Internet-wide reachability of a future host has not been established.

API URL acceptance

The existing compiled UpdateProfileDto was tested offline through the same Nest ValidationPipe as the API, without modifying a profile:

- HTTP at the real isolated origin: rejected.
- HTTPS with 127.0.0.1 as host: syntactically accepted, even though its actual TLS probe failed.
- HTTPS with bare localhost as host: rejected by the URL validator.

The validator requires HTTPS, no embedded username/password, a syntactically acceptable hostname/IP and <=2048 characters. It does not fetch the image, check a certificate, establish public access or confirm Expo rendering. Thus syntax acceptance alone is insufficient. A real image origin must separately pass HTTPS/TLS, anonymous fetch, image decoding and Simulator rendering checks. All six portraits are still unhosted; none can currently be claimed to render from a working public HTTPS URL.

Recommended minimum safe solution

For only six static PNGs, use a dedicated controlled demo-only HTTPS static origin that exposes exactly the six approved fictional portraits. This avoids any Supabase bucket or Storage policy change. Require a real approved hosting destination, an iOS-trusted certificate, anonymous stable image GETs and correct image MIME types. Do not expose the API, Auth, private Storage, credential files, crop source collage, manifests or workspace directory through that origin. Retain synthetic-demo labelling/provenance separately and in the existing demo presentation; do not draw verification marks on the images. Local image files are mapped in demo/assets/manifest.json and remain ignored by git.

If Supabase Storage is preferred, the smallest safe Storage option is a NEW empty dedicated isolated bucket (proposed name: leri-demo-portraits), containing only the six approved PNG objects. Do not change any existing bucket’s public flag or existing policies. A proposed 1 MiB object limit with image/png only is sufficient for the current six crops. Limit the controlled uploader to the reviewed six filenames and hashes; do not add anonymous or ordinary-user upload/update/delete permissions. Public read intentionally exposes only these fictional portraits. Return no server credentials to Expo.

This bucket still requires an HTTPS delivery layer. Use an approved HTTPS origin/reverse proxy restricted to those six public object GET/HEAD routes. Do not publish or tunnel the entire local Supabase service. A locally terminated endpoint must have a certificate trusted by the Simulator; a self-signed/untrusted certificate does not meet the objective. A local-only origin can serve this Simulator but is not an internet-accessible or physical-device solution. If a local CA is selected, certificate installation/trust changes require separate explicit approval; they were not performed. A controlled publicly trusted HTTPS destination avoids those simulator trust changes.

Do not use private evidence buckets, temporary signed property-photo URLs as durable portraits, HTTP links, fabricated URLs, a blanket public Storage policy, global TLS-validation bypasses or an authentication change.

Exact approval required before implementation

Choose and explicitly authorize one bounded hosting path:

A. Dedicated HTTPS static hosting: approve the actual destination/domain and deployment of only amina.png, david.png, sarah.png, jamie.png, priya.png and lewis.png from demo/assets/portraits/, with no access to other workspace/private files.

B. Isolated Supabase Storage: approve creation of the new empty leri-demo-portraits public bucket ONLY in leri-phase2-validation-20261014-final, image/png only and 1 MiB maximum, plus uploads of exactly those six approved files. Separately approve the concrete HTTPS delivery origin and its six-route restriction. Any local CA installation/trust modification needs explicit approval identifying the affected host/simulator. No existing bucket/policy changes are needed or requested.

After choosing a working host, separately authorize setting only each existing account’s photoUrl through PATCH /me/profile to the actual tested returned URL, followed by image fetch/render checks. Preserve account IDs/passwords, all other profile details and verification statuses. No new portrait-upload API, authentication change, migration or publication-validation change is proposed.

Blocker: there is currently neither a suitable existing public bucket nor a functioning approved public HTTPS portrait origin. Stopped after investigation; no hosting, uploads or record changes were implemented.
