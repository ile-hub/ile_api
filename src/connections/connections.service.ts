import { DemoPreviewService } from '../common/demo-preview.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import type { PublicProfile } from '../profiles/profile.types';
import {
  ConnectionQuery,
  CreateConnectionDto,
  MessageQuery,
  SendMessageDto,
} from './connections.dto';
type Status = 'pending' | 'review_later' | 'accepted' | 'declined';
interface ConnectionRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  introduction: string;
  status: Status;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
}
interface MessageRow {
  id: string;
  position: string;
  connection_id: string;
  sender_id: string;
  body: string;
  sent_at: Date;
}
const COLUMNS =
  'id,sender_id,recipient_id,introduction,status,created_at,updated_at,accepted_at';
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly context: RequestContextService,
    private readonly demo: DemoPreviewService,
  ) {}
  private async role() {
    const role = await this.context.getRole();
    if (role !== 'renter' && role !== 'landlord')
      throw new ForbiddenException('Renter or landlord account required');
  }
  private async project(row: ConnectionRow) {
    const other =
      row.sender_id === this.context.getUserId()
        ? row.recipient_id
        : row.sender_id;
    const result = await this.context
      .getClient()
      .query<{ profile: PublicProfile | null }>(
        'SELECT leri_public_profile($1) AS profile',
        [other],
      );
    return {
      id: row.id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      introduction: row.introduction,
      status: row.status,
      direction:
        row.sender_id === this.context.getUserId() ? 'outgoing' : 'incoming',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at,
      conversationId: row.status === 'accepted' ? row.id : null,
      counterparty: result.rows[0]?.profile
        ? await this.demo.decorate(result.rows[0].profile)
        : null,
    };
  }
  private async row(id: string, lock = false) {
    await this.role();
    const result = await this.context
      .getClient()
      .query<ConnectionRow>(
        `SELECT ${COLUMNS} FROM leri_connections WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      );
    if (!result.rows[0]) throw new NotFoundException();
    return result.rows[0];
  }
  async get(id: string) {
    return this.project(await this.row(id));
  }
  async create(body: CreateConnectionDto) {
    await this.role();
    const caller = this.context.getUserId();
    if (caller === body.recipientId)
      throw new ForbiddenException('Choose a person with the other role');
    const visible = await this.context
      .getClient()
      .query<{ own: { discoverable: boolean }; other: PublicProfile | null }>(
        'SELECT leri_own_profile() AS own, leri_public_profile($1) AS other',
        [body.recipientId],
      );
    if (!visible.rows[0]?.own?.discoverable)
      throw new ForbiddenException(
        'Make your profile discoverable before introducing yourself',
      );
    if (!visible.rows[0]?.other)
      throw new NotFoundException('Public profile unavailable');
    const result = await this.context
      .getClient()
      .query<ConnectionRow>(
        `INSERT INTO leri_connections(sender_id,recipient_id,introduction) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
        [caller, body.recipientId, body.introduction.trim()],
      );
    if (!result.rows[0])
      throw new ConflictException(
        'A request already exists between these people',
      );
    return this.project(result.rows[0]);
  }
  async list(query: ConnectionQuery) {
    await this.role();
    const caller = this.context.getUserId();
    const result = await this.context
      .getClient()
      .query<ConnectionRow>(
        `SELECT ${COLUMNS} FROM leri_connections WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR ($2='incoming' AND recipient_id=$3) OR ($2='outgoing' AND sender_id=$3)) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,
        [
          query.status ?? null,
          query.direction ?? null,
          caller,
          query.after ?? null,
          query.limit + 1,
        ],
      );
    const page = result.rows.slice(0, query.limit);
    return {
      items: await Promise.all(page.map((row) => this.project(row))),
      nextCursor: result.rows.length > query.limit ? page.at(-1)!.id : null,
    };
  }
  async decide(id: string, status: Exclude<Status, 'pending'>) {
    const visible = await this.row(id);
    if (visible.recipient_id !== this.context.getUserId())
      throw new ForbiddenException('Only the recipient can decide');
    const row = await this.row(id, true);
    if (row.status === status) return this.project(row);
    if (row.status === 'accepted' || row.status === 'declined')
      throw new ConflictException('This request has already been decided');
    const result = await this.context
      .getClient()
      .query<ConnectionRow>(
        `UPDATE leri_connections SET status=$2 WHERE id=$1 RETURNING ${COLUMNS}`,
        [id, status],
      );
    return this.project(result.rows[0]);
  }
  private async accepted(id: string) {
    const row = await this.row(id);
    if (row.status !== 'accepted')
      throw new ConflictException('Messaging opens after acceptance');
    return row;
  }
  private message(row: MessageRow) {
    return {
      id: row.id,
      connectionId: row.connection_id,
      senderId: row.sender_id,
      text: row.body,
      sentAt: row.sent_at,
      cursor: row.position,
    };
  }
  async messages(id: string, query: MessageQuery) {
    await this.accepted(id);
    const result = await this.context
      .getClient()
      .query<MessageRow>(
        'SELECT id,position,connection_id,sender_id,body,sent_at FROM leri_messages WHERE connection_id=$1 AND position>$2::bigint ORDER BY position LIMIT $3',
        [id, query.after ?? '0', query.limit + 1],
      );
    const page = result.rows.slice(0, query.limit);
    return {
      items: page.map((row) => this.message(row)),
      nextCursor:
        result.rows.length > query.limit ? page.at(-1)!.position : null,
    };
  }
  async send(id: string, body: SendMessageDto) {
    await this.accepted(id);
    // Keep cursor assignment in commit order within a thread. Without this,
    // concurrent sends could commit a higher cursor first and be skipped by polling.
    await this.context
      .getClient()
      .query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
    const result = await this.context
      .getClient()
      .query<MessageRow>(
        'INSERT INTO leri_messages(connection_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,position,connection_id,sender_id,body,sent_at',
        [id, this.context.getUserId(), body.text.trim()],
      );
    return this.message(result.rows[0]);
  }
}
