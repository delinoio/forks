const mask64 = (1n << 64n) - 1n;
const prime1 = 11_400_714_785_074_694_791n;
const prime2 = 14_029_467_366_897_019_727n;
const prime3 = 1_609_587_929_392_839_161n;
const prime4 = 9_650_029_242_287_828_579n;
const prime5 = 2_870_177_450_012_600_261n;

const rotateLeft = (value: bigint, bits: bigint): bigint =>
  ((value << bits) | (value >> (64n - bits))) & mask64;

const read64 = (bytes: Uint8Array, offset: number): bigint => {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]!);
  }
  return value;
};

const read32 = (bytes: Uint8Array, offset: number): bigint =>
  BigInt(
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
      0,
  );

const round = (accumulator: bigint, input: bigint): bigint => {
  const multiplied = (accumulator + input * prime2) & mask64;
  return (rotateLeft(multiplied, 31n) * prime1) & mask64;
};

const mergeRound = (accumulator: bigint, value: bigint): bigint =>
  ((accumulator ^ round(0n, value)) * prime1 + prime4) & mask64;

export const xxhash64 = (bytes: Uint8Array, seed = 0n): bigint => {
  let offset = 0;
  let hash: bigint;
  if (bytes.length >= 32) {
    let v1 = (seed + prime1 + prime2) & mask64;
    let v2 = (seed + prime2) & mask64;
    let v3 = seed & mask64;
    let v4 = (seed - prime1) & mask64;
    const limit = bytes.length - 32;
    while (offset <= limit) {
      v1 = round(v1, read64(bytes, offset));
      v2 = round(v2, read64(bytes, offset + 8));
      v3 = round(v3, read64(bytes, offset + 16));
      v4 = round(v4, read64(bytes, offset + 24));
      offset += 32;
    }
    hash =
      rotateLeft(v1, 1n) +
      rotateLeft(v2, 7n) +
      rotateLeft(v3, 12n) +
      rotateLeft(v4, 18n);
    hash = mergeRound(hash & mask64, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + prime5) & mask64;
  }
  hash = (hash + BigInt(bytes.length)) & mask64;
  while (offset + 8 <= bytes.length) {
    const lane = round(0n, read64(bytes, offset));
    hash = rotateLeft(hash ^ lane, 27n) * prime1 + prime4;
    hash &= mask64;
    offset += 8;
  }
  if (offset + 4 <= bytes.length) {
    hash ^= read32(bytes, offset) * prime1;
    hash = (rotateLeft(hash & mask64, 23n) * prime2 + prime3) & mask64;
    offset += 4;
  }
  while (offset < bytes.length) {
    hash ^= BigInt(bytes[offset]!) * prime5;
    hash = (rotateLeft(hash & mask64, 11n) * prime1) & mask64;
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = (hash * prime2) & mask64;
  hash ^= hash >> 29n;
  hash = (hash * prime3) & mask64;
  hash ^= hash >> 32n;
  return hash & mask64;
};

export const xxhash64Hex = (value: string | Uint8Array): string =>
  xxhash64(typeof value === "string" ? new TextEncoder().encode(value) : value)
    .toString(16)
    .padStart(16, "0");
