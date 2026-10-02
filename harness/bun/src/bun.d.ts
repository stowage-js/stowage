// The one function of the `Bun` namespace the harness calls, for the repository's type
// check, which runs on Node. Bun reads its own declarations and never this file.
declare namespace Bun {
  interface Server {
    readonly port: number;
    stop(closeActiveConnections?: boolean): Promise<void>;
  }

  function serve(options: {
    readonly hostname: string;
    readonly port: number;
    fetch(request: Request): Promise<Response>;
  }): Server;
}
