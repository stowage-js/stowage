/**
 * An issuer under the prefix `https://sts.windows.net/`, which Azurite accepts, for a
 * tenant that exists nowhere.
 */
const issuer = "https://sts.windows.net/00000000-0000-0000-0000-000000000000/";

const audience = "https://storage.azure.com";

/** A token starting a little early, so that the emulator's clock may trail this one. */
const leadSeconds = 60;
const lifetimeSeconds = 3600;

/**
 * ADR 0023: Azurite under `--oauth basic` reads a token's times, issuer and audience and
 * checks no signature, so the harness mints an unsigned JWT itself, fresh for every
 * request the resolver is asked for.
 */
export function mintAccessToken(now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = { alg: "none", typ: "JWT" };
  const claims = {
    aud: audience,
    iss: issuer,
    iat: seconds - leadSeconds,
    nbf: seconds - leadSeconds,
    exp: seconds + lifetimeSeconds,
  };

  return `${base64Url(header)}.${base64Url(claims)}.`;
}

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
