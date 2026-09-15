export const renderTerminalSafeText = (value: string): string =>
  [...value]
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : character;
    })
    .join("");
