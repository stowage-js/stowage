import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  workspace: ["packages/*"],
  entry: "src/index.ts",
  format: "esm",
  platform: "neutral",
  // A neutral platform resolves no built-in, and `adapter-fs` reads the file system
  // through them: they leave the bundle as the import they arrived as.
  deps: { neverBundle: [/^node:/] },
  target: "node24",
  clean: true,
  // ADR 0008: the declarations come out of oxc-transform, which is what
  // `isolatedDeclarations` buys — every exported signature is written, not inferred.
  dts: { generator: "oxc" },
  exports: true,
  // ADR 0008: a generated exports map is checked where it is produced, not in CI.
  publint: { level: "error" },
  attw: { profile: "esm-only", level: "error" },
});

export default config;
