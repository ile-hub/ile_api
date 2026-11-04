import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  EvidenceItem,
  EvidenceStatus,
  TrustPillar,
} from '@yourorg/ile-shared-types';
import { randomUUID } from 'node:crypto';
import {
  PrivateStorageService,
  EVIDENCE_BUCKET,
  validateAsset,
  safeFileName,
  type UploadedAsset,
} from '../common/private-storage.service';
import {
  SubmitEvidenceDto,
  UpdateEvidenceDto,
} from './dto/submit-evidence.dto';
import { RequestContextService } from '../common/request-context.service';

export interface EvidenceCatalogueOption {
  id: string;
  pillar: TrustPillar;
  label: string;
  displayOrder: number;
}

interface EvidenceRow {
  id: string;
  renter_id: string;
  pillar: TrustPillar;
  pathway_type: string;
  payload: Record<string, unknown>;
  status: EvidenceStatus;
  created_at: Date;
  catalogue_id: string | null;
  explanation: string | null;
  updated_at: Date;
}

const COLUMNS =
  'id, renter_id, pillar, pathway_type, payload, status, created_at, catalogue_id, explanation, updated_at';

export type EditableEvidenceItem = EvidenceItem & {
  catalogueId?: string | null;
  explanation?: string | null;
  updatedAt?: string;
};
interface DocumentRow {
  id: string;
  evidence_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  object_path: string;
  created_at: Date;
}
function documentResponse(row: DocumentRow) {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    fileName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
  };
}
function toEvidenceItem(row: EvidenceRow): EditableEvidenceItem {
  return {
    id: row.id,
    renterId: row.renter_id,
    pillar: row.pillar,
    pathwayType: row.pathway_type,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.catalogue_id !== null || row.explanation !== null
      ? {
          catalogueId: row.catalogue_id,
          explanation: row.explanation,
          updatedAt: row.updated_at.toISOString(),
        }
      : {}),
  };
}

@Injectable()
export class EvidenceService {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly storage: PrivateStorageService,
  ) {}

  // Deliberately does NOT take a renterId parameter -- the row is always
  // attributed to the CURRENT request's session, and the INSERT policy's
  // WITH CHECK (renter_id = current_setting('app.current_user_id')::uuid)
  // is what actually enforces that at the database, not this line of
  // application code. If this insert ever raced ahead of the interceptor
  // setting app.current_user_id correctly, the database rejects the row.
  private async requireRenter() {
    if ((await this.requestContext.getRole()) !== 'renter')
      throw new ForbiddenException('Only renters can edit evidence');
  }
  private async validateCatalogue(id: string, pillar: TrustPillar) {
    const result = await this.requestContext
      .getClient()
      .query(
        'SELECT id FROM leri_evidence_catalogue WHERE id=$1 AND pillar=$2 AND active',
        [id, pillar],
      );
    if (!result.rowCount)
      throw new BadRequestException('Unknown or mismatched evidence option');
  }
  async submitEvidence(body: SubmitEvidenceDto): Promise<EditableEvidenceItem> {
    await this.requireRenter();
    if (body.catalogueId)
      await this.validateCatalogue(body.catalogueId, body.pillar);
    if (
      body.catalogueId &&
      body.pathwayType &&
      body.pathwayType !== body.catalogueId
    )
      throw new BadRequestException('pathwayType must match catalogueId');
    const client = this.requestContext.getClient();
    await client.query('SAVEPOINT evidence_selection');
    try {
      const result = await client.query<EvidenceRow>(
        `INSERT INTO evidence_items(renter_id,pillar,pathway_type,payload,catalogue_id,explanation) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
        [
          this.requestContext.getUserId(),
          body.pillar,
          body.catalogueId ?? body.pathwayType,
          JSON.stringify(body.payload ?? {}),
          body.catalogueId ?? null,
          body.explanation ?? null,
        ],
      );
      await client.query('RELEASE SAVEPOINT evidence_selection');
      return toEvidenceItem(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT evidence_selection');
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('This evidence option is already selected');
      throw error;
    }
  }
  private async owned(id: string, editable = false) {
    await this.requireRenter();
    const result = await this.requestContext
      .getClient()
      .query<EvidenceRow>(
        `SELECT ${COLUMNS} FROM evidence_items WHERE id=$1 AND renter_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [id, this.requestContext.getUserId()],
      );
    const row = result.rows[0];
    if (!row) throw new NotFoundException();
    if (editable && row.status !== 'submitted')
      throw new ConflictException('Only submitted evidence can be edited');
    return row;
  }
  async update(id: string, body: UpdateEvidenceDto) {
    const row = await this.owned(id, true);
    if (body.explanation === undefined && body.catalogueId === undefined)
      throw new BadRequestException('No editable fields supplied');
    if (body.catalogueId)
      await this.validateCatalogue(body.catalogueId, row.pillar);
    const client = this.requestContext.getClient();
    await client.query('SAVEPOINT edit_selection');
    try {
      const result = await client.query<EvidenceRow>(
        `UPDATE evidence_items SET explanation=$2,catalogue_id=$3,pathway_type=$4 WHERE id=$1 RETURNING ${COLUMNS}`,
        [
          id,
          body.explanation === undefined ? row.explanation : body.explanation,
          body.catalogueId ?? row.catalogue_id,
          body.catalogueId ?? row.pathway_type,
        ],
      );
      await client.query('RELEASE SAVEPOINT edit_selection');
      return toEvidenceItem(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT edit_selection');
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('This evidence option is already selected');
      throw error;
    }
  }
  async summary() {
    await this.requireRenter();
    const result = await this.requestContext
      .getClient()
      .query<{ summary: unknown }>(
        'SELECT leri_evidence_summary($1) AS summary',
        [this.requestContext.getUserId()],
      );
    return result.rows[0].summary;
  }
  async documents(id: string) {
    await this.owned(id);
    const result = await this.requestContext
      .getClient()
      .query<DocumentRow>(
        'SELECT * FROM leri_evidence_documents WHERE evidence_id=$1 AND removed_at IS NULL ORDER BY created_at,id',
        [id],
      );
    return result.rows.map(documentResponse);
  }
  async upload(id: string, input: UploadedAsset) {
    await this.owned(id, true);
    const file = validateAsset(input);
    const client = this.requestContext.getClient();
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM leri_evidence_documents WHERE evidence_id=$1 AND removed_at IS NULL',
      [id],
    );
    if (count.rows[0].n >= 10)
      throw new BadRequestException(
        'Maximum 10 supporting files per evidence item',
      );
    const fileId = randomUUID(),
      owner = this.requestContext.getUserId(),
      path = `${owner}/evidence/${id}/${fileId}`;
    await this.storage.upload(EVIDENCE_BUCKET, path, file);
    const result = await client.query<DocumentRow>(
      `INSERT INTO leri_evidence_documents(id,evidence_id,owner_id,object_path,original_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        fileId,
        id,
        owner,
        path,
        safeFileName(file.originalname),
        file.mimetype,
        file.size,
      ],
    );
    return documentResponse(result.rows[0]);
  }
  private async document(id: string, documentId: string) {
    await this.owned(id);
    const result = await this.requestContext
      .getClient()
      .query<DocumentRow>(
        'SELECT * FROM leri_evidence_documents WHERE id=$1 AND evidence_id=$2 AND removed_at IS NULL FOR UPDATE',
        [documentId, id],
      );
    if (!result.rows[0]) throw new NotFoundException();
    return result.rows[0];
  }
  async download(id: string, documentId: string) {
    const file = await this.document(id, documentId);
    return this.storage.download(EVIDENCE_BUCKET, file.object_path);
  }
  async removeDocument(id: string, documentId: string) {
    const file = await this.document(id, documentId);
    await this.storage.remove(EVIDENCE_BUCKET, file.object_path);
    await this.requestContext
      .getClient()
      .query(
        'UPDATE leri_evidence_documents SET removed_at=now() WHERE id=$1',
        [documentId],
      );
    return { removed: true };
  }
  async remove(id: string) {
    await this.owned(id);
    const client = this.requestContext.getClient();
    const files = await client.query<DocumentRow>(
      'SELECT * FROM leri_evidence_documents WHERE evidence_id=$1 AND removed_at IS NULL',
      [id],
    );
    for (const file of files.rows)
      await this.storage.remove(EVIDENCE_BUCKET, file.object_path);
    await client.query(
      'UPDATE leri_evidence_documents SET removed_at=now() WHERE evidence_id=$1 AND removed_at IS NULL',
      [id],
    );
    await client.query(
      'UPDATE evidence_items SET deleted_at=now() WHERE id=$1',
      [id],
    );
    return { removed: true };
  }

  async getCatalogue(): Promise<EvidenceCatalogueOption[]> {
    const client = this.requestContext.getClient();
    const { rows } = await client.query<EvidenceCatalogueOption>(
      `SELECT id, pillar, label, display_order AS "displayOrder" FROM leri_evidence_catalogue ORDER BY pillar, display_order, id`,
    );
    return rows;
  }

  async listOwnEvidence(): Promise<EditableEvidenceItem[]> {
    const client = this.requestContext.getClient();
    // No WHERE renter_id = ... here on purpose -- the RLS SELECT policy
    // (renter_sees_own_evidence) is what scopes this, not this query. If
    // RLS were ever disabled or misconfigured, this endpoint would start
    // returning every renter's evidence, which is exactly the failure
    // mode the earlier BYPASSRLS check exists to catch.
    const result = await client.query<EvidenceRow>(
      `SELECT ${COLUMNS}
       FROM evidence_items WHERE deleted_at IS NULL
       ORDER BY created_at DESC`,
    );
    return result.rows.map(toEvidenceItem);
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
  // The same rule is also enforced at the DB by
  // evidence_items_enforce_status_transition.
  async withdrawEvidence(
    id: string,
  ): Promise<EditableEvidenceItem | undefined> {
    const client = this.requestContext.getClient();
    const result = await client.query<EvidenceRow>(
      `UPDATE evidence_items
       SET status = 'withdrawn'
       WHERE id = $1 AND status = 'submitted' AND deleted_at IS NULL
       RETURNING ${COLUMNS}`,
      [id],
    );
    // Zero rows is ambiguous on purpose (same reasoning as
    // getEvidenceById): doesn't exist, isn't yours, or isn't in
    // 'submitted' state -- the caller can't distinguish, and shouldn't
    // be able to.
    return result.rows[0] && toEvidenceItem(result.rows[0]);
  }

  async getEvidenceById(id: string): Promise<EditableEvidenceItem | undefined> {
    const client = this.requestContext.getClient();
    const result = await client.query<EvidenceRow>(
      `SELECT ${COLUMNS}
       FROM evidence_items
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    // Zero rows here is indistinguishable, from the app's point of view,
    // between "doesn't exist" and "exists but RLS hid it" -- which is
    // exactly the point: the API shouldn't leak which case it is.
    return result.rows[0] && toEvidenceItem(result.rows[0]);
  }
}
