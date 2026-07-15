const fs = require("node:fs");
const path = require("node:path");

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const staticFileCache = new Map();

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

function sendRedirect(response, location) {
  response.writeHead(302, { ...securityHeaders, Location: location, "Cache-Control": "no-store" });
  response.end();
}

async function readJson(request, maximumBytes = 2 * 1024 * 1024) {
  const payload = await readBody(request, maximumBytes);
  if (!payload.length) return {};
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw httpError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendStatic(request, response, root, requestPath) {
  const filePath = safeStaticPath(root, requestPath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const resource = loadStaticResource(filePath);
  const headers = {
    ...securityHeaders, "Cache-Control": "no-cache",
    ETag: resource.etag, "Last-Modified": resource.lastModified,
  };
  if (isNotModified(request, resource)) {
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, {
    ...headers, "Content-Length": resource.content.length,
    "Content-Type": contentType(filePath),
  });
  response.end(resource.content);
  return true;
}

function loadStaticResource(filePath) {
  const stats = fs.statSync(filePath);
  const signature = `${stats.size}:${stats.mtimeMs}`;
  const cached = staticFileCache.get(filePath);
  if (cached?.signature === signature) return cached;
  const resource = {
    signature, content: fs.readFileSync(filePath),
    etag: `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
    lastModified: stats.mtime.toUTCString(),
  };
  staticFileCache.set(filePath, resource);
  return resource;
}

function isNotModified(request, resource) {
  const headers = request?.headers || {};
  if (headers["if-none-match"]) return headers["if-none-match"] === resource.etag;
  if (!headers["if-modified-since"]) return false;
  return Date.parse(headers["if-modified-since"]) >= Date.parse(resource.lastModified);
}

function safeStaticPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  return filePath.startsWith(`${path.resolve(root)}${path.sep}`) ? filePath : null;
}

function contentType(filePath) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function httpError(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = {
  httpError, readBody, readJson, securityHeaders, sendJson, sendRedirect, sendStatic,
};
