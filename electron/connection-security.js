const net = require("node:net");

function requiresInsecureHttpAcknowledgement(baseUrl) {
  const url = new URL(baseUrl);
  return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
}

function assertRemoteTransportSecurity(baseUrl, insecureHttpAcknowledged) {
  if (requiresInsecureHttpAcknowledgement(baseUrl) && !insecureHttpAcknowledged) {
    throw new Error(
      "Unencrypted HTTP to a remote server requires explicit acknowledgement.",
    );
  }
}

function isLoopbackHostname(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalizedHostname === "localhost" || normalizedHostname === "::1") return true;
  if (net.isIP(normalizedHostname) !== 4) return false;
  return normalizedHostname.split(".")[0] === "127";
}

module.exports = {
  assertRemoteTransportSecurity,
  isLoopbackHostname,
  requiresInsecureHttpAcknowledgement,
};
