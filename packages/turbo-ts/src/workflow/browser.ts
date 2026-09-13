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
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
      : { command: "xdg-open", args: [url] };
