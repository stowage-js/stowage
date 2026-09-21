export const capabilityNames = [
  "keyBytesPreserved",
  "presignedUrls",
  "rangeReads",
  "userMetadata",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];
