export const parseLoopbackRequestTarget = (target: string): URL | undefined => {
  try {
    return new URL(target, "http://127.0.0.1");
  } catch {
    return undefined;
  }
};
