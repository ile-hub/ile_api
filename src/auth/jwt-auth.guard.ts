import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

export interface AuthenticatedUser {
  id: string; // matches public.users.id / renter_profiles.user_id -- see
  // note in evidence.controller.ts about provisioning until the real
  // identity-slice signup flow exists.
  role?: string;
  email?: string;
}

// Verifies a Supabase Auth-issued JWT (HS256, shared secret). This is
// deliberately just signature + expiry verification, not a call out to
// Supabase -- that's how Supabase's own PostgREST/GoTrue-fronted services
// verify tokens too, and it's what makes this fast enough to run on every
// request.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);

    try {
      const secret = this.config.getOrThrow<string>('SUPABASE_JWT_SECRET');
      const payload = jwt.verify(token, secret) as jwt.JwtPayload;
      if (!payload.sub) {
        throw new UnauthorizedException('Token missing sub claim');
      }
      (req as Request & { user: AuthenticatedUser }).user = {
        id: payload.sub,
        role: typeof payload.role === 'string' ? payload.role : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
