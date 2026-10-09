import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

export interface AuthenticatedUser {
  id: string; // matches public.users.id / renter_profiles.user_id -- see
  // note in evidence.controller.ts about provisioning until the real
  // identity-slice signup flow exists.
  role?: string;
  email?: string;
}

interface JsonWebKey {
  kid: string;
  alg: string;
  [key: string]: unknown;
}

interface CachedKey {
  key: KeyObject;
  alg: string;
}

// Verifies a Supabase Auth-issued SESSION token against Supabase's own
// JWKS -- NOT a shared HS256 secret. Current Supabase Auth signs session
// tokens asymmetrically (ES256 locally, confirmed via
// /auth/v1/.well-known/jwks.json) and there is no shared secret that
// could ever verify one of these.
//
// This guard used to do `jwt.verify(token, SUPABASE_JWT_SECRET)` (HS256).
// That mismatch went undetected until tenancy-interests' end-to-end
// tests made the first real HTTP call using an actual signup's
// access_token through this guard -- every earlier test either
// hand-minted its own HS256 token or only exercised the DB trigger
// directly, never a real session token through this exact code path.
// Fixed here, not worked around, since it would silently break every
// authenticated route in the app, not just this feature.
//
// (The anon/service_role API keys are a SEPARATE thing -- static,
// HS256, still signed with SUPABASE_JWT_SECRET -- those are Kong/
// PostgREST routing keys, not user session tokens, and this guard never
// handles them.)
@Injectable()
export class JwtAuthGuard implements CanActivate {
  // Cached across requests: this guard is a singleton provider, not
  // request-scoped, so the cache persists between calls. Keyed by kid so
  // a rotated signing key (a new kid appearing) triggers exactly one
  // re-fetch, not a fetch per request.
  private readonly jwksCache = new Map<string, CachedKey>();

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);

    try {
      const decoded = jwt.decode(token, { complete: true });
      const kid = decoded?.header?.kid;
      if (!kid) {
        throw new Error('token has no kid');
      }

      const { key, alg } = await this.resolveKey(kid);
      const payload = jwt.verify(token, key, {
        algorithms: [alg as jwt.Algorithm],
      }) as jwt.JwtPayload;
      if (!payload.sub) {
        throw new Error('token missing sub claim');
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

  private async resolveKey(kid: string): Promise<CachedKey> {
    const cached = this.jwksCache.get(kid);
    if (cached) {
      return cached;
    }
    await this.refreshJwks();
    const key = this.jwksCache.get(kid);
    if (!key) {
      throw new Error(`no JWKS key found for kid ${kid}`);
    }
    return key;
  }

  private async refreshJwks(): Promise<void> {
    const supabaseUrl = this.config.getOrThrow<string>('SUPABASE_URL');
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) {
      throw new Error(`failed to fetch JWKS: ${res.status}`);
    }
    const body = (await res.json()) as { keys: JsonWebKey[] };
    for (const jwk of body.keys) {
      // Node's crypto typings want its own webcrypto.JsonWebKey shape;
      // the object we get back from Supabase's JWKS endpoint already has
      // exactly the fields (kty/crv/x/y for EC) createPublicKey reads at
      // runtime -- the cast is just bridging two JWK type definitions,
      // not weakening what's actually checked.

      this.jwksCache.set(jwk.kid, {
        key: createPublicKey({ key: jwk, format: 'jwk' }),
        alg: jwk.alg,
      });
    }
  }
}
