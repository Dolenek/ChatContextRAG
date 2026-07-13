const DEFAULT_TIMEOUT_MS = 30_000;

class BackendClient {
  constructor(baseUrl, defaultHeaders = {}, options = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.defaultHeaders = defaultHeaders;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get(path, options = {}) {
    return this.request("GET", path, undefined, {}, options);
  }

  post(path, body = {}, options = {}) {
    return this.request("POST", path, body, {}, options);
  }

  put(path, body = {}, options = {}) {
    return this.request("PUT", path, body, {}, options);
  }

  patch(path, body = {}, options = {}) {
    return this.request("PATCH", path, body, {}, options);
  }

  delete(path, body, options = {}) {
    return this.request("DELETE", path, body, {}, options);
  }

  multipart(path, form, options = {}) {
    return this.request("POST", path, form, {}, options);
  }

  raw(method, path, body, headers = {}, options = {}) {
    return this.requestRaw(method, path, body, headers, options);
  }

  async request(method, path, body, extraHeaders = {}, requestOptions = {}) {
    const options = {
      method,
      headers: { ...this.defaultHeaders, ...extraHeaders },
    };
    if (body !== undefined) this.setBody(options, body);
    return this.performRequest(method, path, options, requestOptions);
  }

  requestRaw(method, path, body, extraHeaders = {}, requestOptions = {}) {
    return this.performRequest(method, path, {
      method,
      headers: { ...this.defaultHeaders, ...extraHeaders },
      body,
    }, requestOptions);
  }

  async performRequest(method, path, fetchOptions, requestOptions) {
    const timeoutMs = requestOptions.timeoutMs ?? this.timeoutMs;
    const cancellation = createCancellation(requestOptions.signal, timeoutMs);
    const endpoint = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(endpoint, { ...fetchOptions, signal: cancellation.signal });
      const responseBody = await parseResponse(response);
      if (!response.ok) throw responseError(response, responseBody);
      return responseBody;
    } catch (error) {
      throw requestError(error, cancellation, { endpoint, method, path, timeoutMs });
    } finally {
      cancellation.dispose();
    }
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

class BackendTimeoutError extends Error {
  constructor({ endpoint, method, path, timeoutMs }) {
    const apiLabel = isLocalEndpoint(endpoint) ? "Lokální API" : "API";
    super(`${apiLabel} neodpovědělo do ${formatTimeout(timeoutMs)} (${method} ${path}).`);
    this.name = "BackendTimeoutError";
    this.code = "BACKEND_TIMEOUT";
    this.endpoint = endpoint;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

function createCancellation(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => Boolean(externalSignal?.aborted),
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function requestError(error, cancellation, request) {
  if (cancellation.timedOut()) return new BackendTimeoutError(request);
  if (!cancellation.callerAborted()) return error;
  return Object.assign(
    new Error(`Požadavek ${request.method} ${request.path} byl zrušen.`),
    { name: "AbortError", code: "REQUEST_ABORTED", endpoint: request.endpoint },
  );
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

function isLocalEndpoint(endpoint) {
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function formatTimeout(timeoutMs) {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} sekund` : `${timeoutMs} ms`;
}

module.exports = {
  BackendClient, BackendTimeoutError, DEFAULT_TIMEOUT_MS, parseResponse,
};
