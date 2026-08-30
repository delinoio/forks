const forbiddenNativeDependencyPattern =
  /(?:^|\/)(?:[^@/]+-)?(?:binding|wasm|native)(?:-|@)|msgpackr-extract|node-gyp|node-addon-api/i;

export interface ProductionDependencySections<Value> {
  readonly dependencies?: Readonly<Record<string, Value>>;
  readonly optionalDependencies?: Readonly<Record<string, Value>>;
}

const normalizeProductionDependencySections = <Value>(
  sections: ProductionDependencySections<Value> | undefined,
) => ({
  dependencies: sections?.dependencies ?? {},
  optionalDependencies: sections?.optionalDependencies ?? {},
});

export const haveExactProductionDependencySections = <Value>(
  actual: ProductionDependencySections<Value> | undefined,
  expected: ProductionDependencySections<Value>,
): boolean =>
  JSON.stringify(normalizeProductionDependencySections(actual)) ===
  JSON.stringify(normalizeProductionDependencySections(expected));

export const productionDependencyEntries = <Value>(
  sections: ProductionDependencySections<Value> | undefined,
): ReadonlyArray<[string, Value]> => [
  ...Object.entries(sections?.dependencies ?? {}),
  ...Object.entries(sections?.optionalDependencies ?? {}),
];

export const isForbiddenProductionDependency = (key: string): boolean =>
  key.startsWith("@parcel/watcher@") ||
  forbiddenNativeDependencyPattern.test(key);
