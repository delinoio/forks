export const maximumNodeTimerMilliseconds = 2_147_483_647;

export const parseNodeTimerSeconds = (
  value: string | number,
): number | undefined => {
  const seconds = Number(value);
  return (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > maximumNodeTimerMilliseconds / 1_000
    ? undefined
    : seconds;
};
