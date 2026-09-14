export interface BrowserInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const browserInvocation = (
  platform: NodeJS.Platform,
  url: string,
): BrowserInvocation =>
  platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "win32"
      ? {
          command: "rundll32.exe",
          args: ["url.dll,FileProtocolHandler", url],
        }
      : { command: "xdg-open", args: [url] };
