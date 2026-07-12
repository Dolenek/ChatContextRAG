const test = require("node:test");
const assert = require("node:assert/strict");
const { readBackendResponse } = require("../electron/backend-response");

test("plain backend failures remain readable instead of causing a JSON syntax error", async () => {
  const response = { text: async () => "Internal Server Error" };

  const parsed = await readBackendResponse(response);

  assert.deepEqual(parsed, { detail: "Internal Server Error" });
});

test("JSON backend responses retain their structured detail", async () => {
  const response = { text: async () => '{"detail":"Database failed"}' };

  const parsed = await readBackendResponse(response);

  assert.deepEqual(parsed, { detail: "Database failed" });
});
