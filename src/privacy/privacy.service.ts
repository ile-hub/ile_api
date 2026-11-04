import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { RequestContextService } from '../common/request-context.service';
import { UpdateConsentDto } from './privacy.dto';

export interface LegalDocument {
  id: string;
  kind: 'terms' | 'privacy_notice';
  version: string;
  title: string;
  content: string;
  publishedAt: Date;
  demoOnly: boolean;
}
export interface TermsAcceptance {
  version: string;
  acceptedAt: Date;
}
export interface PrivacyAcknowledgement {
  version: string;
  acknowledgedAt: Date;
}
export interface ConsentEvent {
  id: string;
  purpose: 'product_updates' | 'user_research';
  granted: boolean;
  recordedAt: Date;
}
const DOCUMENTS = `SELECT DISTINCT ON (kind) id, kind, version, title, content,
  published_at AS "publishedAt", demo_only AS "demoOnly"
  FROM leri_legal_documents WHERE published_at <= now() ORDER BY kind, published_at DESC, created_at DESC, id`;

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly context: RequestContextService,
  ) {}

  private async currentDocuments(db: Pick<PoolClient, 'query'>) {
    const { rows } = await db.query<LegalDocument>(DOCUMENTS);
    const terms = rows.find((d) => d.kind === 'terms');
    const privacyNotice = rows.find((d) => d.kind === 'privacy_notice');
    if (!terms || !privacyNotice)
      throw new ServiceUnavailableException(
        'Published terms and privacy notice have not been configured',
      );
    return { terms, privacyNotice };
  }

  // Public content only. No user data or request-scoped GUC is read on this route.
  getDocuments() {
    return this.currentDocuments(this.pool);
  }

  private async requireAccount() {
    if (!(await this.context.getRole()))
      throw new NotFoundException('No account exists for this session');
  }

  private async document(kind: 'terms' | 'privacy_notice', version: string) {
    await this.requireAccount();
    const docs = await this.currentDocuments(this.context.getClient());
    const document = kind === 'terms' ? docs.terms : docs.privacyNotice;
    if (document.version !== version)
      throw new ConflictException(
        'Document version is no longer current; refresh the legal documents',
      );
    return document;
  }

  async acceptTerms(version: string) {
    const doc = await this.document('terms', version);
    const client = this.context.getClient();
    // DO NOTHING retains the original acceptance timestamp on retries.
    await client.query(
      `INSERT INTO leri_terms_acceptances (user_id, document_id) VALUES ($1, $2) ON CONFLICT (user_id, document_id) DO NOTHING`,
      [this.context.getUserId(), doc.id],
    );
    const { rows } = await client.query<TermsAcceptance>(
      `SELECT d.version, a.accepted_at AS "acceptedAt" FROM leri_terms_acceptances a JOIN leri_legal_documents d ON d.id = a.document_id WHERE a.user_id = $1 AND a.document_id = $2`,
      [this.context.getUserId(), doc.id],
    );
    return rows[0];
  }

  async acknowledgePrivacy(version: string) {
    const doc = await this.document('privacy_notice', version);
    const client = this.context.getClient();
    await client.query(
      `INSERT INTO leri_privacy_acknowledgements (user_id, document_id) VALUES ($1, $2) ON CONFLICT (user_id, document_id) DO NOTHING`,
      [this.context.getUserId(), doc.id],
    );
    const { rows } = await client.query<PrivacyAcknowledgement>(
      `SELECT d.version, a.acknowledged_at AS "acknowledgedAt" FROM leri_privacy_acknowledgements a JOIN leri_legal_documents d ON d.id = a.document_id WHERE a.user_id = $1 AND a.document_id = $2`,
      [this.context.getUserId(), doc.id],
    );
    return rows[0];
  }

  async updateConsent(body: UpdateConsentDto) {
    const doc = await this.document(
      'privacy_notice',
      body.privacyNoticeVersion,
    );
    const { rows } = await this.context.getClient().query<ConsentEvent>(
      `INSERT INTO leri_consent_events (user_id, purpose, granted, privacy_document_id) VALUES ($1, $2, $3, $4)
      RETURNING id, purpose, granted, recorded_at AS "recordedAt"`,
      [this.context.getUserId(), body.purpose, body.granted, doc.id],
    );
    return { ...rows[0], privacyNoticeVersion: doc.version };
  }

  async getOwnPrivacy() {
    await this.requireAccount();
    const client = this.context.getClient();
    const userId = this.context.getUserId();
    const terms = await client.query<TermsAcceptance>(
      `SELECT d.version, a.accepted_at AS "acceptedAt" FROM leri_terms_acceptances a JOIN leri_legal_documents d ON d.id = a.document_id WHERE a.user_id = $1 ORDER BY a.accepted_at DESC, a.id`,
      [userId],
    );
    const notices = await client.query<PrivacyAcknowledgement>(
      `SELECT d.version, a.acknowledged_at AS "acknowledgedAt" FROM leri_privacy_acknowledgements a JOIN leri_legal_documents d ON d.id = a.document_id WHERE a.user_id = $1 ORDER BY a.acknowledged_at DESC, a.id`,
      [userId],
    );
    const consent = await client.query<{
      purpose: string;
      granted: boolean;
      privacyNoticeVersion: string;
      recordedAt: Date;
    }>(
      `SELECT DISTINCT ON (c.purpose) c.purpose, c.granted, d.version AS "privacyNoticeVersion", c.recorded_at AS "recordedAt" FROM leri_consent_events c JOIN leri_legal_documents d ON d.id = c.privacy_document_id WHERE c.user_id = $1 ORDER BY c.purpose, c.sequence DESC`,
      [userId],
    );
    return {
      termsAcceptances: terms.rows,
      privacyAcknowledgements: notices.rows,
      consents: ['product_updates', 'user_research'].map(
        (purpose) =>
          consent.rows.find((c) => c.purpose === purpose) ?? {
            purpose,
            granted: false,
            privacyNoticeVersion: null,
            recordedAt: null,
          },
      ),
    };
  }
}
