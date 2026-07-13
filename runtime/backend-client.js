class BackendClient {
  constructor(baseUrl, defaultHeaders = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.defaultHeaders = defaultHeaders;
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body = {}) {
    return this.request("POST", path, body);
  }

  put(path, body = {}) {
    return this.request("PUT", path, body);
  }

  patch(path, body = {}) {
    return this.request("PATCH", path, body);
  }

  delete(path, body) {
    return this.request("DELETE", path, body);
  }

  multipart(path, form) {
    return this.request("POST", path, form);
  }

  raw(method, path, body, headers = {}) {
    return this.requestRaw(method, path, body, headers);
  }

  async request(method, path, body, extraHeaders = {}) {
    const headers = { ...this.defaultHeaders, ...extraHeaders };
    const options = { method, headers };
    if (body !== undefined) this.setBody(options, body);
    const response = await fetch(`${this.baseUrl}${path}`, options);
    const responseBody = await parseResponse(response);
    if (!response.ok) throw responseError(response, responseBody);
    return responseBody;
  }

  async requestRaw(method, path, body, extraHeaders = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers: { ...this.defaultHeaders, ...extraHeaders }, body,
    });
    const responseBody = await parseResponse(response);
    if (!response.ok) throw responseError(response, responseBody);
    return responseBody;
  }

  setBody(options, body) {
    if (isMultipart(body)) {
      options.body = body;
      return;
    }
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
}

function isMultipart(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

async function parseResponse(response) {
  const payload = await response.text();
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    return { detail: payload };
  }
}

function responseError(response, body) {
  return Object.assign(
    new Error(body.detail || `Backend returned ${response.status}.`),
    { statusCode: response.status },
  );
}

module.exports = { BackendClient, parseResponse };
