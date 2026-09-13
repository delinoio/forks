import { Effect } from "effect";
import type {
  OpenTelemetryOptions,
  OtlpProtocol,
} from "../cli/common-options.js";
import { BoundaryError } from "../effect/errors.js";
import { EnvironmentService, HttpService } from "../effect/services.js";
import type { RunMetricTaskDetail } from "../run/engine.js";
import { packageVersion } from "../version.js";

export interface RunMetricSummary {
  readonly exitCode: number;
  readonly taskCount: number;
  readonly tasks: ReadonlyArray<RunMetricTaskDetail>;
}

interface MetricSelection {
  readonly runSummary: boolean;
  readonly taskDetails: boolean;
}

const protocolFromEnvironment = (
  value: string | undefined,
): OtlpProtocol | undefined => {
  if (value === "grpc") return "grpc";
  if (value === "http/protobuf" || value === "http-protobuf")
    return "http-protobuf";
  if (value === "http/json" || value === "http-json") return "http-json";
  return undefined;
};

const parseEnvironmentHeaders = (
  value: string | undefined,
): ReadonlyArray<readonly [string, string]> =>
  (value ?? "").split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    return separator <= 0
      ? []
      : [
          [
            entry.slice(0, separator).trim(),
            entry.slice(separator + 1).trim(),
          ] as const,
        ];
  });

const varint = (value: number): Uint8Array => {
  const output: Array<number> = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    output.push(byte | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return new Uint8Array(output);
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const field = (number: number, value: Uint8Array): Uint8Array =>
  concat(varint(number * 8 + 2), varint(value.length), value);

const stringField = (number: number, value: string): Uint8Array =>
  field(number, new TextEncoder().encode(value));

const fixed64Field = (number: number, value: bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return concat(varint(number * 8 + 1), bytes);
};

const resourceAttributes = (
  configured: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> => [
  ...configured.filter(
    ([name]) => name !== "service.name" && name !== "service.version",
  ),
  ["service.name", "turbo-ts"],
  ["service.version", packageVersion],
];

// This intentionally implements only the OTLP Metrics fields emitted below.
// Keeping the encoder local and deterministic avoids importing native or WASM
// protocol runtimes; it can be replaced when the package accepts a pure-JS
// generated OTLP dependency.
export const encodeOtlpMetrics = (
  summary: RunMetricSummary,
  configuredResources: ReadonlyArray<readonly [string, string]> = [],
  selection: MetricSelection = { runSummary: true, taskDetails: false },
): Uint8Array => {
  const keyValue = (key: string, value: string) =>
    concat(stringField(1, key), field(2, stringField(1, value)));
  const resource = concat(
    ...resourceAttributes(configuredResources).map(([key, value]) =>
      field(1, keyValue(key, value)),
    ),
  );
  const dataPoint = (
    attributes: ReadonlyArray<readonly [string, string]>,
  ): Uint8Array =>
    concat(
      fixed64Field(6, 1n),
      ...attributes.map(([key, value]) => field(7, keyValue(key, value))),
    );
  const gaugeMetric = (
    name: string,
    points: ReadonlyArray<Uint8Array>,
  ): Uint8Array =>
    concat(
      stringField(1, name),
      field(5, concat(...points.map((point) => field(1, point)))),
    );
  const metrics = [
    ...(selection.runSummary
      ? [
          gaugeMetric("turbo.run", [
            dataPoint([
              ["turbo.exit_code", String(summary.exitCode)],
              ["turbo.task_count", String(summary.taskCount)],
            ]),
          ]),
        ]
      : []),
    ...(selection.taskDetails
      ? [
          gaugeMetric(
            "turbo.task",
            summary.tasks.map((task) =>
              dataPoint([
                ["turbo.task_id", task.id],
                ["turbo.package", task.package],
                ["turbo.task", task.task],
                ["turbo.status", task.status],
                ...(task.exitCode === undefined
                  ? []
                  : [["turbo.exit_code", String(task.exitCode)] as const]),
                ...(task.durationMilliseconds === undefined
                  ? []
                  : [
                      [
                        "turbo.duration_ms",
                        String(task.durationMilliseconds),
                      ] as const,
                    ]),
                ...(task.cacheSource === undefined
                  ? []
                  : [["turbo.cache_source", task.cacheSource] as const]),
              ]),
            ),
          ),
        ]
      : []),
  ];
  const scope = concat(
    stringField(1, "turbo-ts"),
    stringField(2, packageVersion),
  );
  const scopeMetrics = concat(
    field(1, scope),
    ...metrics.map((metric) => field(2, metric)),
  );
  const resourceMetrics = concat(field(1, resource), field(2, scopeMetrics));
  return field(1, resourceMetrics);
};

export const makeOtlpJsonMetrics = (
  summary: RunMetricSummary,
  configuredResources: ReadonlyArray<readonly [string, string]> = [],
  selection: MetricSelection = { runSummary: true, taskDetails: false },
): Readonly<Record<string, unknown>> => {
  const integerAttribute = (key: string, value: number) => ({
    key,
    value: { intValue: String(value) },
  });
  const stringAttribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  const metrics = [
    ...(selection.runSummary
      ? [
          {
            name: "turbo.run",
            gauge: {
              dataPoints: [
                {
                  asInt: "1",
                  attributes: [
                    integerAttribute("turbo.exit_code", summary.exitCode),
                    integerAttribute("turbo.task_count", summary.taskCount),
                  ],
                },
              ],
            },
          },
        ]
      : []),
    ...(selection.taskDetails
      ? [
          {
            name: "turbo.task",
            gauge: {
              dataPoints: summary.tasks.map((task) => ({
                asInt: "1",
                attributes: [
                  stringAttribute("turbo.task_id", task.id),
                  stringAttribute("turbo.package", task.package),
                  stringAttribute("turbo.task", task.task),
                  stringAttribute("turbo.status", task.status),
                  ...(task.exitCode === undefined
                    ? []
                    : [integerAttribute("turbo.exit_code", task.exitCode)]),
                  ...(task.durationMilliseconds === undefined
                    ? []
                    : [
                        integerAttribute(
                          "turbo.duration_ms",
                          task.durationMilliseconds,
                        ),
                      ]),
                  ...(task.cacheSource === undefined
                    ? []
                    : [
                        stringAttribute("turbo.cache_source", task.cacheSource),
                      ]),
                ],
              })),
            },
          },
        ]
      : []),
  ];
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: resourceAttributes(configuredResources).map(
            ([key, value]) => ({ key, value: { stringValue: value } }),
          ),
        },
        scopeMetrics: [
          {
            scope: { name: "turbo-ts", version: packageVersion },
            metrics,
          },
        ],
      },
    ],
  };
};

const endpointFor = (configured: string, protocol: OtlpProtocol): string => {
  const url = new URL(configured);
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("OTLP endpoint must not contain credentials");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("OTLP endpoint must use HTTP or HTTPS");
  }
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname =
      protocol === "grpc"
        ? "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export"
        : "/v1/metrics";
  }
  return url.toString();
};

export const exportRunMetrics = (
  options: OpenTelemetryOptions,
  token: string | undefined,
  summary: RunMetricSummary,
): Effect.Effect<void, BoundaryError, EnvironmentService | HttpService> =>
  Effect.gen(function* () {
    const environment = yield* EnvironmentService;
    const http = yield* HttpService;
    const enabled =
      options.enabled ??
      (yield* environment.get("TURBO_EXPERIMENTAL_OTEL_ENABLED")) === "true";
    if (!enabled) return;
    const selection = {
      runSummary: options.metricsRunSummary !== false,
      taskDetails: options.metricsTaskDetails === true,
    };
    if (!selection.runSummary && !selection.taskDetails) return;
    const protocol =
      options.protocol ??
      protocolFromEnvironment(
        yield* environment.get("OTEL_EXPORTER_OTLP_PROTOCOL"),
      ) ??
      "http-protobuf";
    const endpoint =
      options.endpoint ??
      (yield* environment.get("OTEL_EXPORTER_OTLP_ENDPOINT")) ??
      (protocol === "grpc" ? "http://127.0.0.1:4317" : "http://127.0.0.1:4318");
    const environmentTimeout = Number(
      yield* environment.get("OTEL_EXPORTER_OTLP_TIMEOUT"),
    );
    const timeoutMilliseconds =
      options.timeoutMilliseconds ??
      (Number.isFinite(environmentTimeout) && environmentTimeout >= 0
        ? environmentTimeout
        : 10_000);
    const configuredHeaders = [
      ...parseEnvironmentHeaders(
        yield* environment.get("OTEL_EXPORTER_OTLP_HEADERS"),
      ),
      ...options.headers,
    ];
    const headers: Record<string, string> = {
      "content-type":
        protocol === "grpc"
          ? "application/grpc"
          : protocol === "http-json"
            ? "application/json"
            : "application/x-protobuf",
      "user-agent": `turbo-ts/${packageVersion}`,
      ...(protocol === "grpc" ? { te: "trailers" } : {}),
      ...Object.fromEntries(configuredHeaders),
      ...(options.useRemoteCacheToken === true && token !== undefined
        ? { authorization: `Bearer ${token}` }
        : {}),
    };
    const payload =
      protocol === "http-json"
        ? new TextEncoder().encode(
            JSON.stringify(
              makeOtlpJsonMetrics(summary, options.resources, selection),
            ),
          )
        : encodeOtlpMetrics(summary, options.resources, selection);
    const grpcHeader = new Uint8Array(5);
    new DataView(grpcHeader.buffer).setUint32(1, payload.length, false);
    const body = protocol === "grpc" ? concat(grpcHeader, payload) : payload;
    const response = yield* http.request({
      url: endpointFor(endpoint, protocol),
      method: "POST",
      transport: protocol === "grpc" ? "http2" : undefined,
      headers,
      body,
      timeoutMilliseconds,
      maxResponseBodyBytes: 64 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "observability",
          message: `OTLP export returned ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        }),
      );
    }
    if (protocol === "grpc" && response.headers["grpc-status"] !== "0") {
      const encodedMessage = response.headers["grpc-message"];
      let message = encodedMessage ?? "gRPC status is missing";
      if (encodedMessage !== undefined) {
        try {
          message = decodeURIComponent(encodedMessage);
        } catch {
          message = "gRPC status message is malformed";
        }
      }
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "observability",
          message: `OTLP gRPC export failed: ${message}`,
          retryable: false,
        }),
      );
    }
  });
