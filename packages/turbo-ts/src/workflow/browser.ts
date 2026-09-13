export interface BrowserInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const quoteWindowsBrowserUrl = (url: string): string =>
  `"${url.replaceAll('"', '""')}"`;

export const browserInvocation = (
  platform: NodeJS.Platform,
  url: string,
): BrowserInvocation =>
  platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "win32"
      ? {
          command: "cmd.exe",
          args: [
            "/d",
            "/s",
            "/v:off",
            "/c",
            "start",
            "",
            quoteWindowsBrowserUrl(url),
          ],
        }
      : { command: "xdg-open", args: [url] };
