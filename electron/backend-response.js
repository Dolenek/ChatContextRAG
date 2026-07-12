async function readBackendResponse(response) {
  const responseText = await response.text();
  if (!responseText) return {};
  try {
    return JSON.parse(responseText);
  } catch {
    return { detail: responseText };
  }
}

module.exports = { readBackendResponse };
