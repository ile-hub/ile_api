import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
const present = (_: unknown, value: unknown) => value !== undefined;
export class CreateConnectionDto {
  @IsUUID() recipientId!: string;
  @IsString() @Matches(/\S/) @MaxLength(3000) introduction!: string;
}
export class ConnectionQuery {
  @ValidateIf(present) @IsIn(['incoming', 'outgoing']) direction?:
    'incoming' | 'outgoing';
  @ValidateIf(present)
  @IsIn(['pending', 'review_later', 'accepted', 'declined'])
  status?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
  @ValidateIf(present) @IsUUID() after?: string;
}
export class MessageQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @ValidateIf(present)
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  after?: string;
}
export class SendMessageDto {
  @IsString() @Matches(/\S/) @MaxLength(4000) text!: string;
}
