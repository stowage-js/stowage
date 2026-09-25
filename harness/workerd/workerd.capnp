# The `workerd` cell of spec 2. `worker.js` is `src/worker.ts`, bundled on Node by
# `src/describe-workerd.ts`, which starts this config and reads the ports from the control
# descriptor.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "conformance", worker = .conformance),
    (name = "defaults", worker = .defaults),
    # The default outbound reaches public addresses alone, and the emulator of ADR 0012
    # answers on the loopback one. A network of one's own trusts no certificate authority
    # unless told to, which the real buckets of the scheduled run need.
    (
      name = "internet",
      network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true)),
    ),
  ],
  sockets = [
    (name = "harness", address = "127.0.0.1:0", http = (), service = "conformance"),
    (name = "defaults", address = "127.0.0.1:0", http = (), service = "defaults"),
  ],
);

const conformance :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  # Spec 1: the date and flags `workerd` runs at, so the cell shows that `adapter-memory`
  # and `adapter-s3` need no Node API. From 2026-08-04 the date alone turns on
  # `nodejs_compat` and `nodejs_compat_v2`; `no_nodejs_compat` alone still leaves
  # `process`, `Buffer` and most `node:` modules, and only both flags together restore
  # what the date gave before (#118).
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
  globalOutbound = "internet",
  bindings = [
    (name = "STOWAGE_CONFORMANCE_INCLUDE_SLOW", fromEnvironment = "STOWAGE_CONFORMANCE_INCLUDE_SLOW"),
    (name = "STOWAGE_S3_ENDPOINT_NAME", fromEnvironment = "STOWAGE_S3_ENDPOINT_NAME"),
    (name = "STOWAGE_S3_ENDPOINT", fromEnvironment = "STOWAGE_S3_ENDPOINT"),
    (name = "STOWAGE_S3_BUCKET", fromEnvironment = "STOWAGE_S3_BUCKET"),
    (name = "STOWAGE_S3_REGION", fromEnvironment = "STOWAGE_S3_REGION"),
    (name = "STOWAGE_S3_FORCE_PATH_STYLE", fromEnvironment = "STOWAGE_S3_FORCE_PATH_STYLE"),
    (name = "AWS_ACCESS_KEY_ID", fromEnvironment = "AWS_ACCESS_KEY_ID"),
    (name = "AWS_SECRET_ACCESS_KEY", fromEnvironment = "AWS_SECRET_ACCESS_KEY"),
    (name = "STOWAGE_S3_DENIED_ACCESS_KEY_ID", fromEnvironment = "STOWAGE_S3_DENIED_ACCESS_KEY_ID"),
    (name = "STOWAGE_S3_DENIED_SECRET_ACCESS_KEY", fromEnvironment = "STOWAGE_S3_DENIED_SECRET_ACCESS_KEY"),
    (name = "STOWAGE_S3_EXPIRED_ACCESS_KEY_ID", fromEnvironment = "STOWAGE_S3_EXPIRED_ACCESS_KEY_ID"),
    (name = "STOWAGE_S3_EXPIRED_SECRET_ACCESS_KEY", fromEnvironment = "STOWAGE_S3_EXPIRED_SECRET_ACCESS_KEY"),
    (name = "STOWAGE_S3_EXPIRED_SESSION_TOKEN", fromEnvironment = "STOWAGE_S3_EXPIRED_SESSION_TOKEN"),
    (name = "STOWAGE_S3_EXPIRED_AT", fromEnvironment = "STOWAGE_S3_EXPIRED_AT"),
  ],
);

# The same module at the defaults of the pinned date, which a Worker gets unless it opts
# out. It runs no cases: it shows that the probe of `src/node-api.ts` sees the Node APIs
# the flags above take away, and that `fromEnv` reads bindings through `process.env` as
# spec 7.3 promises. The values are fixed, so the run needs no credential of its own.
const defaults :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "AWS_ACCESS_KEY_ID", text = "access-key-from-binding"),
    (name = "AWS_SECRET_ACCESS_KEY", text = "secret-from-binding"),
    (name = "AWS_SESSION_TOKEN", text = "session-token-from-binding"),
  ],
);
