# The `workerd` cells of spec 2's second table: `@stowage/http` in a worker's `fetch` and
# `@stowage/hono` as the worker, each once at the flags of spec 1 and once at the defaults
# of the pinned date (ADR 0050). Each is a config of its own, which `src/http-server.ts`
# names on the command line and starts with the endpoint in its environment, so that a test
# can put a proxy in front of the provider.
using Workerd = import "/workerd/workerd.capnp";

const spec :Workerd.Config = (
  services = [(name = "http", worker = .specWorker), .internet],
  sockets = [.socket],
);

const defaults :Workerd.Config = (
  services = [(name = "http", worker = .defaultsWorker), .internet],
  sockets = [.socket],
);

const honoSpec :Workerd.Config = (
  services = [(name = "http", worker = .honoSpecWorker), .internet],
  sockets = [.socket],
);

const honoDefaults :Workerd.Config = (
  services = [(name = "http", worker = .honoDefaultsWorker), .internet],
  sockets = [.socket],
);

const socket :Workerd.Socket = (name = "http", address = "127.0.0.1:0", http = (), service = "http");

# ADR 0050: behind every server is SeaweedFS, which answers on the loopback address.
const internet :Workerd.Service = (name = "internet", network = (allow = ["local"]));

const specWorker :Workerd.Worker = (
  modules = .modules,
  # Spec 1: the date and the flags `workerd` runs at, so the cell shows that `@stowage/http`
  # needs no Node API. ADR 0002 says why one flag is not enough.
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
  globalOutbound = "internet",
  bindings = .bindings,
);

const defaultsWorker :Workerd.Worker = (
  modules = .modules,
  compatibilityDate = "2026-09-01",
  globalOutbound = "internet",
  bindings = .bindings,
);

const honoSpecWorker :Workerd.Worker = (
  modules = .honoModules,
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
  globalOutbound = "internet",
  bindings = .bindings,
);

const honoDefaultsWorker :Workerd.Worker = (
  modules = .honoModules,
  compatibilityDate = "2026-09-01",
  globalOutbound = "internet",
  bindings = .bindings,
);

const honoModules :List(Workerd.Worker.Module) = [
  (name = "hono-worker.js", esModule = embed "dist/hono-worker.js"),
];

const modules :List(Workerd.Worker.Module) = [
  (name = "http-worker.js", esModule = embed "dist/http-worker.js"),
];

const bindings :List(Workerd.Worker.Binding) = [
  (name = "STOWAGE_S3_ENDPOINT", fromEnvironment = "STOWAGE_S3_ENDPOINT"),
  (name = "STOWAGE_S3_BUCKET", fromEnvironment = "STOWAGE_S3_BUCKET"),
  (name = "STOWAGE_S3_REGION", fromEnvironment = "STOWAGE_S3_REGION"),
  (name = "STOWAGE_S3_FORCE_PATH_STYLE", fromEnvironment = "STOWAGE_S3_FORCE_PATH_STYLE"),
  (name = "AWS_ACCESS_KEY_ID", fromEnvironment = "AWS_ACCESS_KEY_ID"),
  (name = "AWS_SECRET_ACCESS_KEY", fromEnvironment = "AWS_SECRET_ACCESS_KEY"),
  (name = "STOWAGE_HTTP_MAX_SIZE", fromEnvironment = "STOWAGE_HTTP_MAX_SIZE"),
];
