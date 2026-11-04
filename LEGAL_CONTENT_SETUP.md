# Legal content configuration

Phase 1 stores versioned legal documents and immutable acceptance/optional-consent history. It does not invent or publish operator policies. Until both current documents are configured, `GET /legal/documents` and legal write routes return 503. Profile editing and `GET /me/privacy` remain available.

Use a reviewed privacy notice and terms appropriate to the actual operator and data practices. The privacy notice needs the categories of data, purposes, lawful basis, sharing, retention, rights and operator contact details required by the specification. Explain that public bios/prompts/portrait URLs and housing preferences are shared, while registration submissions, verification references and documents are private. Explain optional product updates and user research separately from terms acceptance. Confirm the retention/deletion process before describing it as implemented. Private upload storage, account-deletion requests and reporting/blocking are not implemented in this phase.

For the demo, use synthetic profiles/dummy documents only and mark demo-specific content with `demo_only=true`. Real-user use needs reviewed real-user text (`demo_only=false`) and the privacy/fairness/DPIA review described in the specification. The API returns `demoOnly`; the frontend must make that scope visible.

An operator with database-owner privileges can insert draft rows into `leri_legal_documents` with `kind` (`terms` or `privacy_notice`), a unique `version`, `title`, complete plain-text `content`, and `demo_only`. Leave `published_at` null while reviewing. To publish the reviewed draft, set `published_at` to the intended publication time. Do this only on an authorised target; this work does not authorise production changes.

Once a publication time has been assigned, that row cannot be edited or deleted. Create a new version for corrections. The latest non-future published version is current; stale acceptance requests return 409. Ordinary application credentials cannot write legal content. Do not render database content as raw HTML.

Verification providers are also unconfigured. Profile status fields default to `unverified`. Submitting landlord registration data sets pending, not verified. Real successful checks require trusted integration results with provider/check references and timestamps. No public or owner endpoint can set successful verification or demo provenance.
