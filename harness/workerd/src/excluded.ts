/**
 * ADR 0006: flow 1 on `workerd` is one named exclusion in this harness, and the multipart
 * round trip of ADR 0016 joins it. Spec 12 leaves open what CPU and duration a multipart
 * upload spends here, which decides the cell; neither case names a runtime itself.
 */
export const excludedCases: readonly string[] = ["flow/1-large-upload", "put/multipart-round-trip"];
