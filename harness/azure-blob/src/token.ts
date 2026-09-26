/** A tenant that exists nowhere. */
const tenant = "00000000-0000-0000-0000-000000000000";

/** An issuer under the prefix `https://sts.windows.net/`, which Azurite accepts. */
const issuer = `https://sts.windows.net/${tenant}/`;

/**
 * The principal the token stands for. Azurite answers `Get User Delegation Key` with an
 * empty `500` for a token without `oid` and `tid`, which an Entra token always carries.
 */
const principal = "11111111-2222-3333-4444-555555555555";

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
    oid: principal,
    tid: tenant,
  };

  return `${base64Url(header)}.${base64Url(claims)}.`;
}

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
