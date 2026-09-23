import { describe, test } from "vitest";

import { describeWorkerd } from "./describe-workerd.ts";

await describeWorkerd({ describe, test });
