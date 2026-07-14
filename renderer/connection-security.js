(function exposeConnectionSecurity() {
  function normalizedOrigin(value) {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  function requiresInsecureHttpAcknowledgement(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
    } catch {
      return false;
    }
  }

  function isLoopbackHostname(hostname) {
    const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalizedHostname === "localhost" || normalizedHostname === "::1") return true;
    const octets = normalizedHostname.split(".");
    return octets.length === 4 && octets.every(isIpv4Octet) && octets[0] === "127";
  }

  function isIpv4Octet(value) {
    return /^\d{1,3}$/.test(value) && Number(value) <= 255;
  }

  window.connectionSecurity = {
    normalizedOrigin,
    requiresInsecureHttpAcknowledgement,
  };
}());
