import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { env } from "../env";
import { AppError } from "@tienda/shared";
const localSecret = randomBytes(32);
export const localMode = () =>
  env.AUTH_DRIVER === "local" && env.NODE_ENV !== "production" && !env.DATABASE_URL;
export function loopback(req: any) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
}
export const localToken = () =>
  new SignJWT({ email: env.OWNER_EMAIL })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("local-owner")
    .setExpirationTime("8h")
    .sign(localSecret);
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (req.url.split("?")[0].endsWith("/health") || req.url.split("?")[0].endsWith("/auth/config"))
      return true;
    if (req.method === "POST" && req.url.endsWith("/auth/local")) {
      if (!localMode() || !loopback(req))
        throw new AppError("forbidden", "Acceso local deshabilitado.", 403);
      return true;
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) throw new AppError("unauthorized", "Inicia sesión para continuar.", 401);
    try {
      let payload;
      if (localMode()) {
        if (!loopback(req)) throw new Error();
        payload = (await jwtVerify(token, localSecret, { algorithms: ["HS256"] })).payload;
      } else {
        if (!env.SUPABASE_URL) throw new Error();
        jwks ??= createRemoteJWKSet(new URL(env.SUPABASE_URL + "/auth/v1/.well-known/jwks.json"));
        payload = (
          await jwtVerify(token, jwks, {
            issuer: env.SUPABASE_URL + "/auth/v1",
            audience: "authenticated",
            algorithms: ["ES256", "RS256"],
          })
        ).payload;
      }
      if (!env.OWNER_EMAIL || String(payload.email).toLowerCase() !== env.OWNER_EMAIL.toLowerCase())
        throw new Error();
      return true;
    } catch {
      throw new AppError("unauthorized", "Sesión no válida o correo no autorizado.", 401);
    }
  }
}
