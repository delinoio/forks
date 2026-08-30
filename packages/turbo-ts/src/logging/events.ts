export type LogEvent =
  | { readonly kind: "cache-hit"; readonly task: string; readonly hash: string }
  | {
      readonly kind: "cache-miss";
      readonly task: string;
      readonly hash: string;
    }
  | {
      readonly kind: "task-output";
      readonly task: string;
      readonly output: string;
    }
  | { readonly kind: "warning"; readonly message: string };

const cyan = "\u001B[36m";
const yellow = "\u001B[33m";
const reset = "\u001B[0m";

export const renderLogEvent = (event: LogEvent, color: boolean): string => {
  switch (event.kind) {
    case "cache-hit":
      return `${event.task}: cache hit, replaying logs ${event.hash}\n`;
    case "cache-miss":
      return `${event.task}: cache miss, executing ${event.hash}\n`;
    case "task-output":
      return event.output
        .split("\n")
        .filter(
          (line, index, values) => line !== "" || index < values.length - 1,
        )
        .map(
          (line) =>
            `${color ? cyan : ""}${event.task}:${color ? reset : ""} ${line}\n`,
        )
        .join("");
    case "warning":
      return `${color ? yellow : ""} WARNING ${color ? reset : ""} ${event.message}\n`;
  }
};
