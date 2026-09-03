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
const maximumRenderedChunkCharacters = 64 * 1024;

export interface TaskOutputRenderState {
  readonly atLineStart: boolean;
  readonly pending: string;
}

export const initialTaskOutputRenderState: TaskOutputRenderState = {
  atLineStart: true,
  pending: "",
};

const appendBounded = (
  pending: string,
  value: string,
  chunks: Array<string>,
): string => {
  let remainder = value;
  let buffered = pending;
  while (remainder !== "") {
    const available = maximumRenderedChunkCharacters - buffered.length;
    let consumed = Math.min(available, remainder.length);
    if (
      consumed < remainder.length &&
      consumed > 0 &&
      /[\uD800-\uDBFF]/.test(remainder[consumed - 1]!) &&
      /[\uDC00-\uDFFF]/.test(remainder[consumed]!)
    ) {
      consumed -= 1;
    }
    if (consumed === 0) {
      if (buffered !== "") {
        chunks.push(buffered);
        buffered = "";
        continue;
      }
      consumed = remainder.length;
    }
    buffered += remainder.slice(0, consumed);
    remainder = remainder.slice(consumed);
    if (buffered.length === maximumRenderedChunkCharacters) {
      chunks.push(buffered);
      buffered = "";
    }
  }
  return buffered;
};

export const renderTaskOutputChunk = (
  state: TaskOutputRenderState,
  task: string,
  output: string,
  color: boolean,
): {
  readonly state: TaskOutputRenderState;
  readonly chunks: ReadonlyArray<string>;
} => {
  const chunks: Array<string> = [];
  const prefix = `${color ? cyan : ""}${task}:${color ? reset : ""} `;
  let pending = state.pending;
  let atLineStart = state.atLineStart;
  let offset = 0;
  while (offset < output.length) {
    if (atLineStart) {
      pending = appendBounded(pending, prefix, chunks);
      atLineStart = false;
    }
    const lineBreak = output.indexOf("\n", offset);
    if (lineBreak === -1) {
      pending = appendBounded(pending, output.slice(offset), chunks);
      break;
    }
    pending = appendBounded(
      pending,
      output.slice(offset, lineBreak + 1),
      chunks,
    );
    if (pending !== "") {
      chunks.push(pending);
      pending = "";
    }
    atLineStart = true;
    offset = lineBreak + 1;
  }
  return { state: { atLineStart, pending }, chunks };
};

export const finishTaskOutput = (
  state: TaskOutputRenderState,
): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  const pending = state.atLineStart
    ? state.pending
    : appendBounded(state.pending, "\n", chunks);
  if (pending !== "") {
    chunks.push(pending);
  }
  return chunks;
};

export const renderLogEvent = (event: LogEvent, color: boolean): string => {
  switch (event.kind) {
    case "cache-hit":
      return `${event.task}: cache hit, replaying logs ${event.hash}\n`;
    case "cache-miss":
      return `${event.task}: cache miss, executing ${event.hash}\n`;
    case "task-output": {
      const rendered = renderTaskOutputChunk(
        initialTaskOutputRenderState,
        event.task,
        event.output,
        color,
      );
      return [...rendered.chunks, ...finishTaskOutput(rendered.state)].join("");
    }
    case "warning":
      return `${color ? yellow : ""} WARNING ${color ? reset : ""} ${event.message}\n`;
  }
};
