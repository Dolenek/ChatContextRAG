const crypto = require("node:crypto");
const { verifyPassword } = require("./passwords");

const sessionCookie = "chat_context_session";

class AuthService {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.loginAttempts = new Map();
  }

  login(username, password, address) {
    this.assertRateLimit(address);
    const validUser = safeEqual(username, this.config.adminUsername);
    const validPassword = verifyPassword(password, this.config.adminPasswordHash);
    if (!validUser || !validPassword) {
      this.recordFailure(address);
      throw authError("Invalid username or password.", 401);
    }
    this.loginAttempts.delete(address);
    return this.createSession();
  }

  createSession() {
    const id = crypto.randomBytes(32).toString("base64url");
    const session = {
      id,
      csrfToken: crypto.randomBytes(24).toString("base64url"),
      expiresAt: Date.now() + this.config.sessionHours * 60 * 60 * 1000,
    };
    this.sessions.set(id, session);
    return session;
  }

  authenticate(request) {
    const bearer = readBearer(request.headers.authorization);
    if (bearer && safeEqual(bearer, this.config.desktopToken)) {
      return { kind: "bearer" };
    }
    const sessionId = parseCookies(request.headers.cookie)[sessionCookie];
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.sessions.delete(sessionId);
      throw authError("Authentication required.", 401);
    }
    return { kind: "session", session };
  }

  authorizeMutation(request, identity) {
    if (identity.kind === "bearer") return;
    if (!sameOrigin(request, this.config.trustProxy)) throw authError("Invalid origin.", 403);
    if (!safeEqual(request.headers["x-csrf-token"], identity.session.csrfToken)) {
      throw authError("Invalid CSRF token.", 403);
    }
  }

  logout(request) {
    const sessionId = parseCookies(request.headers.cookie)[sessionCookie];
    if (sessionId) this.sessions.delete(sessionId);
  }

  sessionCookie(session, request) {
    const secure = isSecureRequest(request, this.config.trustProxy) ? "; Secure" : "";
    const maxAge = Math.floor(this.config.sessionHours * 60 * 60);
    return `${sessionCookie}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  clearCookie(request) {
    const secure = isSecureRequest(request, this.config.trustProxy) ? "; Secure" : "";
    return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  assertRateLimit(address) {
    const current = this.loginAttempts.get(address);
    if (!current || current.resetAt <= Date.now()) return;
    if (current.count >= 5) throw authError("Too many login attempts. Try later.", 429);
  }

  recordFailure(address) {
    const current = this.loginAttempts.get(address);
    const active = current?.resetAt > Date.now() ? current : { count: 0 };
    this.loginAttempts.set(address, {
      count: active.count + 1,
      resetAt: Date.now() + 15 * 60 * 1000,
    });
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function isSecureRequest(request, trustProxy) {
  return Boolean(request.socket.encrypted)
    || (trustProxy && request.headers["x-forwarded-proto"] === "https");
}

function readBearer(header = "") {
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return [part.slice(0, separator), part.slice(separator + 1)];
    }));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { AuthService, sameOrigin };
