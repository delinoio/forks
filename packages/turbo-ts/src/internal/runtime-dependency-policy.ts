const forbiddenNativeDependencyPattern =
  /(?:^|\/)(?:[^@/]+-)?(?:binding|wasm|native)(?:-|@)|msgpackr-extract|node-gyp|node-addon-api/i;

export const isForbiddenProductionDependency = (key: string): boolean =>
  key.startsWith("@parcel/watcher@") ||
  forbiddenNativeDependencyPattern.test(key);
