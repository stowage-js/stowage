import process from "node:process";

import { type BufferMeter, bufferMeter } from "./buffer-meter.ts";

/** What the harness asks a server in a process of its own, over the IPC channel. */
export interface MeterRequest {
  readonly stowageMeter: "start" | "growth";
}

/** What the server's process answers. */
export type MeterAnswer =
  | { readonly stowageMeter: "started" }
  | { readonly stowageMeter: "growth"; readonly bytes: number };

/**
 * How often the server's process samples while a measurement runs. Nothing in that process
 * calls the meter on a byte count, as a client of `bufferMeter` does, so it samples by time:
 * a server holding an object whole holds it for far longer than this.
 */
const sampleInterval = 100;

/**
 * Loaded with `--import` into a server the harness starts as a child process, such as
 * `next start`, so that spec 14.8's flat-memory test measures that process as it measures
 * its own: `start` takes the baseline, `growth` answers the peak above it. The application
 * imports nothing of this.
 */
function serveMeasurements(send: NonNullable<typeof process.send>): void {
  let meter: BufferMeter | undefined;
  let sampling: ReturnType<typeof setInterval> | undefined;

  process.on("message", (message: Partial<MeterRequest> | null) => {
    if (message?.stowageMeter === "start") {
      clearInterval(sampling);
      meter = bufferMeter();
      sampling = setInterval(meter.sample, sampleInterval);
      send({ stowageMeter: "started" } satisfies MeterAnswer);
    } else if (message?.stowageMeter === "growth" && meter !== undefined) {
      clearInterval(sampling);
      meter.sample();
      send({ stowageMeter: "growth", bytes: meter.growth() } satisfies MeterAnswer);
    }
  });

  // The channel is the harness's, and must not keep the server alive once it is told to stop.
  process.channel?.unref();
}

if (process.send !== undefined) serveMeasurements(process.send.bind(process));
