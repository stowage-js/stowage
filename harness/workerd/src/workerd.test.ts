import { describe, test } from "vitest";

import { describeWorkerd } from "./driver.ts";

await describeWorkerd({ describe, test });
