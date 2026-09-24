# The `workerd` cell of spec 2. `worker.js` is `src/worker.ts`, bundled on Node by
# `src/describe-workerd.ts`, which starts this config and reads the port from the control
# descriptor.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "conformance", worker = .conformance),
    # The default outbound reaches public addresses alone, and the emulator of ADR 0012
    # answers on the loopback one. A network of one's own trusts no certificate authority
    # unless told to, which the real buckets of the scheduled run need.
    (
      name = "internet",
      network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true)),
    ),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "conformance")],
);

const conformance :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  # Spec 1: the date `workerd` runs at. No `nodejs_compat` beside it, so the cell shows
  # that `adapter-memory` and `adapter-s3` reach no Node API.
  compatibilityDate = "2026-09-01",
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
