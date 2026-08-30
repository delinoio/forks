type JsonScalar = boolean | null | number | string;

type JsonObject = Readonly<Record<string, unknown>>;

type CanonicalSchema =
  | {
      readonly kind: "array";
      readonly items: CanonicalSchema;
      readonly maxItems?: number;
      readonly minItems?: number;
    }
  | {
      readonly kind: "literal";
      readonly value: JsonScalar;
    }
  | {
      readonly kind: "object";
      readonly additionalProperties?: CanonicalSchema;
      readonly properties: ReadonlyArray<
        readonly [name: string, required: boolean, schema: CanonicalSchema]
      >;
    }
  | {
      readonly exclusiveMaximum?: number;
      readonly exclusiveMinimum?: number;
      readonly kind: "primitive";
      readonly maxLength?: number;
      readonly maximum?: number;
      readonly minLength?: number;
      readonly minimum?: number;
      readonly multipleOf?: number;
      readonly pattern?: string;
      readonly type: "boolean" | "integer" | "null" | "number" | "string";
    }
  | {
      readonly kind: "union";
      readonly members: ReadonlyArray<CanonicalSchema>;
    };

interface Definitions {
  readonly draft7: JsonObject;
  readonly effect: JsonObject;
}

// Effect emits $defs, enum arrays, and strict object metadata while the
// distributed draft-07 artifact uses definitions, oneOf literals, and omitted
// object strictness. Canonicalization retains validation constraints and
// schema-valued additionalProperties while discarding descriptive metadata,
// parser extensions, and the nonstandard uint64 format annotation.

const supportedKeys = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allowComments",
  "allowTrailingCommas",
  "anyOf",
  "default",
  "definitions",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectJsonObject = (value: unknown, context: string): JsonObject => {
  if (!isJsonObject(value)) {
    throw new TypeError(`${context} must be a JSON object`);
  }
  return value;
};

const expectJsonObjectOrEmpty = (
  value: unknown,
  context: string,
): JsonObject => (value === undefined ? {} : expectJsonObject(value, context));

const expectArray = (
  value: unknown,
  context: string,
): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array`);
  }
  return value;
};

const expectNumber = (value: unknown, context: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new TypeError(`${context} must be a number`);
  }
  return value;
};

const expectString = (value: unknown, context: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a string`);
  }
  return value;
};

const isJsonScalar = (value: unknown): value is JsonScalar =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalText = (schema: CanonicalSchema): string =>
  JSON.stringify(schema);

const makeUnion = (
  schemas: ReadonlyArray<CanonicalSchema>,
): CanonicalSchema => {
  const flattened = schemas.flatMap((schema) =>
    schema.kind === "union" ? schema.members : [schema],
  );
  const members = [
    ...new Map(
      flattened.map((schema) => [canonicalText(schema), schema] as const),
    ).entries(),
  ]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, schema]) => schema);
  if (members.length === 0) {
    throw new TypeError("JSON Schema union must contain at least one member");
  }
  return members.length === 1 ? members[0]! : { kind: "union", members };
};

const decodeJsonPointerSegment = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveReference = (
  reference: string,
  definitions: Definitions,
): readonly [name: string, schema: JsonObject] => {
  const sources = [
    ["#/$defs/", definitions.effect],
    ["#/definitions/", definitions.draft7],
  ] as const;
  for (const [prefix, source] of sources) {
    if (!reference.startsWith(prefix)) {
      continue;
    }
    const name = decodeJsonPointerSegment(reference.slice(prefix.length));
    const schema = source[name];
    return [name, expectJsonObject(schema, `definition ${name}`)];
  }
  throw new TypeError(`unsupported JSON Schema reference: ${reference}`);
};

const assertSupportedKeys = (schema: JsonObject): void => {
  for (const key of Object.keys(schema)) {
    if (!supportedKeys.has(key)) {
      throw new TypeError(`unsupported JSON Schema keyword: ${key}`);
    }
  }
};

const canonicalizeNode = (
  schema: JsonObject,
  definitions: Definitions,
  activeReferences: ReadonlySet<string>,
): CanonicalSchema => {
  assertSupportedKeys(schema);

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      throw new TypeError("JSON Schema $ref must be a string");
    }
    const [name, resolved] = resolveReference(schema.$ref, definitions);
    if (activeReferences.has(name)) {
      throw new TypeError(`recursive JSON Schema reference: ${schema.$ref}`);
    }
    return canonicalizeNode(
      resolved,
      definitions,
      new Set([...activeReferences, name]),
    );
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined) {
    if (schema.anyOf !== undefined && schema.oneOf !== undefined) {
      throw new TypeError("JSON Schema node cannot contain anyOf and oneOf");
    }
    return makeUnion(
      expectArray(union, "JSON Schema union").map((member) =>
        canonicalizeNode(
          expectJsonObject(member, "JSON Schema union member"),
          definitions,
          activeReferences,
        ),
      ),
    );
  }

  if (schema.enum !== undefined) {
    return makeUnion(
      expectArray(schema.enum, "JSON Schema enum").map((value) => {
        if (!isJsonScalar(value)) {
          throw new TypeError("JSON Schema enum values must be scalar");
        }
        return { kind: "literal", value };
      }),
    );
  }

  if (Array.isArray(schema.type)) {
    return makeUnion(
      schema.type.map((type) =>
        canonicalizeNode({ ...schema, type }, definitions, activeReferences),
      ),
    );
  }

  switch (schema.type) {
    case "array":
      return {
        items: canonicalizeNode(
          expectJsonObject(schema.items, "JSON Schema array items"),
          definitions,
          activeReferences,
        ),
        kind: "array",
        maxItems: expectNumber(schema.maxItems, "maxItems"),
        minItems: expectNumber(schema.minItems, "minItems"),
      };
    case "object": {
      const properties = expectJsonObjectOrEmpty(
        schema.properties,
        "JSON Schema properties",
      );
      const required = new Set(
        schema.required === undefined
          ? []
          : expectArray(schema.required, "JSON Schema required").map((name) => {
              if (typeof name !== "string") {
                throw new TypeError(
                  "JSON Schema required entries must be strings",
                );
              }
              return name;
            }),
      );
      const additionalProperties = isJsonObject(schema.additionalProperties)
        ? canonicalizeNode(
            schema.additionalProperties,
            definitions,
            activeReferences,
          )
        : undefined;
      return {
        additionalProperties,
        kind: "object",
        properties: Object.entries(properties)
          .sort(([left], [right]) => compareText(left, right))
          .map(([name, propertySchema]) => [
            name,
            required.has(name),
            canonicalizeNode(
              expectJsonObject(propertySchema, `JSON Schema property ${name}`),
              definitions,
              activeReferences,
            ),
          ]),
      };
    }
    case "boolean":
    case "integer":
    case "null":
    case "number":
    case "string":
      return {
        exclusiveMaximum: expectNumber(
          schema.exclusiveMaximum,
          "exclusiveMaximum",
        ),
        exclusiveMinimum: expectNumber(
          schema.exclusiveMinimum,
          "exclusiveMinimum",
        ),
        kind: "primitive",
        maxLength: expectNumber(schema.maxLength, "maxLength"),
        maximum: expectNumber(schema.maximum, "maximum"),
        minLength: expectNumber(schema.minLength, "minLength"),
        minimum: expectNumber(schema.minimum, "minimum"),
        multipleOf: expectNumber(schema.multipleOf, "multipleOf"),
        pattern: expectString(schema.pattern, "pattern"),
        type: schema.type,
      };
    default:
      throw new TypeError(
        `unsupported JSON Schema type: ${String(schema.type)}`,
      );
  }
};

const canonicalizeDocument = (document: unknown): CanonicalSchema => {
  const root = expectJsonObject(document, "JSON Schema document");
  const definitions = {
    draft7: expectJsonObjectOrEmpty(root.definitions, "definitions"),
    effect: expectJsonObjectOrEmpty(root.$defs, "$defs"),
  };
  return canonicalizeNode(root, definitions, new Set());
};

export const haveEquivalentConfigurationSchemas = (
  runtimeDocument: unknown,
  distributedDocument: unknown,
): boolean =>
  canonicalText(canonicalizeDocument(runtimeDocument)) ===
  canonicalText(canonicalizeDocument(distributedDocument));
