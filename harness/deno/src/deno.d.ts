// The functions of the `Deno` namespace the harness calls, for the repository's type check,
// which runs on Node. Deno reads its own declarations and never this file.
declare namespace Deno {
  function test(name: string, fn: () => Promise<void>): void;

  interface HttpServer {
    readonly addr: { readonly port: number };
    shutdown(): Promise<void>;
  }

  function serve(
    options: { readonly hostname: string; readonly port: number; onListen(): void },
    handler: (request: Request) => Promise<Response>,
  ): HttpServer;
}
