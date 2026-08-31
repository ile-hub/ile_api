import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';

export type TrustPillar =
  'community' | 'affordability' | 'reliability' | 'stability';

export interface EvidenceItem {
  id: string;
  renter_id: string;
  pillar: TrustPillar;
  pathway_type: string;
  payload: unknown;
  status: string;
  created_at: string;
}

@Injectable()
export class EvidenceService {
  constructor(private readonly requestContext: RequestContextService) {}

  // Deliberately does NOT take a renterId parameter -- the row is always
  // attributed to the CURRENT request's session, and the INSERT policy's
  // WITH CHECK (renter_id = current_setting('app.current_user_id')::uuid)
  // is what actually enforces that at the database, not this line of
  // application code. If this insert ever raced ahead of the interceptor
  // setting app.current_user_id correctly, the database rejects the row.
  async submitEvidence(
    pillar: TrustPillar,
    pathwayType: string,
    payload: unknown,
  ): Promise<EvidenceItem> {
    const client = this.requestContext.getClient();
    const userId = this.requestContext.getUserId();
    const result = await client.query<EvidenceItem>(
      `INSERT INTO evidence_items (renter_id, pillar, pathway_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id, renter_id, pillar, pathway_type, payload, status, created_at`,
      [userId, pillar, pathwayType, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  async listOwnEvidence(): Promise<EvidenceItem[]> {
    const client = this.requestContext.getClient();
    // No WHERE renter_id = ... here on purpose -- the RLS SELECT policy
    // (renter_sees_own_evidence) is what scopes this, not this query. If
    // RLS were ever disabled or misconfigured, this endpoint would start
    // returning every renter's evidence, which is exactly the failure
    // mode the earlier BYPASSRLS check exists to catch.
    const result = await client.query<EvidenceItem>(
      `SELECT id, renter_id, pillar, pathway_type, payload, status, created_at
       FROM evidence_items
       ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  // The ONLY status transition exposed to a renter at all -- there is no
  // generic "update status" endpoint/method, on purpose. A renter must
  // never be able to set 'verified' (that's a future reviewer/admin
  // action, not built yet -- see the migration's note) or 'rejected'
  // themselves; restricting the application-layer surface to this one
  // named action is what makes that true, rather than a status field a
  // client could set to anything.
  //
  // `AND status = 'submitted'` guards the OLD->NEW transition itself
  // (submitted -> withdrawn only, not e.g. re-withdrawing an already-
  // withdrawn item or "un-verifying" a verified one) -- RLS's UPDATE
  // policy only enforces ownership (renter_id = session), it can't
  // express old-value-dependent rules, so that check has to live here.
  // See the open decision on whether this also needs a DB-level trigger.
  async withdrawEvidence(id: string): Promise<EvidenceItem | undefined> {
    const client = this.requestContext.getClient();
    const result = await client.query<EvidenceItem>(
      `UPDATE evidence_items
       SET status = 'withdrawn'
       WHERE id = $1 AND status = 'submitted'
       RETURNING id, renter_id, pillar, pathway_type, payload, status, created_at`,
      [id],
    );
    // Zero rows is ambiguous on purpose (same reasoning as
    // getEvidenceById): doesn't exist, isn't yours, or isn't in
    // 'submitted' state -- the caller can't distinguish, and shouldn't
    // be able to.
    return result.rows[0];
  }

  async getEvidenceById(id: string): Promise<EvidenceItem | undefined> {
    const client = this.requestContext.getClient();
    const result = await client.query<EvidenceItem>(
      `SELECT id, renter_id, pillar, pathway_type, payload, status, created_at
       FROM evidence_items
       WHERE id = $1`,
      [id],
    );
    // Zero rows here is indistinguishable, from the app's point of view,
    // between "doesn't exist" and "exists but RLS hid it" -- which is
    // exactly the point: the API shouldn't leak which case it is.
    return result.rows[0];
  }
}
