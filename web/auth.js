const crypto = require("node:crypto");
const net = require("node:net");
const { verifyPassword } = require("./passwords");

const sessionCookie = "chat_context_session";
const defaultLimits = {
  maxConcurrentPasswordVerifications: 4,
  maxLoginAttempts: 4096,
  maxSessions: 256,
};

class AuthService {
  constructor(config, options = {}) {
    this.config = config;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.verifyPassword = options.verifyPassword || verifyPassword;
    this.limits = { ...defaultLimits, ...options.limits };
    this.activePasswordVerifications = 0;
  }

  async login(username, password, address) {
    this.assertRateLimit(address);
    const validUser = safeEqual(username, this.config.adminUsername);
    const validPassword = await this.verifyPasswordWithLimit(password);
    if (!validUser || !validPassword) {
      this.recordFailure(address);
      throw authError("Invalid username or password.", 401);
    }
    this.loginAttempts.delete(address);
    return this.createSession();
  }

  createSession() {
    this.pruneExpiredSessions();
    if (this.sessions.size >= this.limits.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
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

  clientAddress(request) {
    const directAddress = request.socket.remoteAddress || "unknown";
    if (!this.config.trustProxy) return directAddress;
    const forwardedAddress = String(request.headers["x-forwarded-for"] || "").split(",")
      .map((address) => address.trim()).reverse().find((address) => net.isIP(address));
    return net.isIP(forwardedAddress) ? forwardedAddress : directAddress;
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
    this.pruneExpiredLoginAttempts();
    const current = this.loginAttempts.get(address);
    if (!current) {
      if (this.loginAttempts.size >= this.limits.maxLoginAttempts) {
        throw authError("Too many login sources. Try later.", 429);
      }
      this.loginAttempts.set(address, {
        count: 0, resetAt: Date.now() + 15 * 60 * 1000,
      });
      return;
    }
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

  async verifyPasswordWithLimit(password) {
    if (this.activePasswordVerifications
      >= this.limits.maxConcurrentPasswordVerifications) {
      throw authError("Authentication service is busy. Try again.", 503, 1);
    }
    this.activePasswordVerifications += 1;
    try {
      return await this.verifyPassword(password, this.config.adminPasswordHash);
    } finally {
      this.activePasswordVerifications -= 1;
    }
  }

  pruneExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  pruneExpiredLoginAttempts() {
    const now = Date.now();
    for (const [address, attempt] of this.loginAttempts) {
      if (attempt.resetAt <= now) this.loginAttempts.delete(address);
    }
  }
}

function sameOrigin(request, trustProxy = false) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsedOrigin = new URL(origin);
    const expectedProtocol = isSecureRequest(request, trustProxy) ? "https:" : "http:";
    return parsedOrigin.protocol === expectedProtocol
      && parsedOrigin.host === request.headers.host;
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

function authError(message, statusCode, retryAfter = null) {
  return Object.assign(new Error(message), { statusCode, retryAfter });
}

module.exports = { AuthService, sameOrigin };
