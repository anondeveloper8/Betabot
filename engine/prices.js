export function createPriceCodec(scale) {
  if (!Number.isInteger(scale) || scale < 0) throw new Error("Price scale must be a non-negative integer.");
  const factor = 10n ** BigInt(scale);
  function fromDecimal(value) {
    const trimmed = String(value).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) throw new Error(`Invalid decimal price: ${value}`);
    const negative = trimmed.startsWith("-");
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [whole, fraction = ""] = unsigned.split(".");
    if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
      throw new Error(`Price has more than ${scale} significant decimal places: ${value}`);
    }
    const padded = (fraction + "0".repeat(scale)).slice(0, scale);
    const result = BigInt(whole) * factor + BigInt(padded || "0");
    return negative ? -result : result;
  }
  function toDecimal(value) {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    if (scale === 0) return `${negative ? "-" : ""}${abs}`;
    const whole = abs / factor;
    const fraction = (abs % factor).toString().padStart(scale, "0");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }
  return {
    scale,
    fromDecimal,
    toDecimal,
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    abs: (v) => v < 0n ? -v : v,
    min: (...values) => { if (!values.length) throw new Error("min() requires values"); return values.reduce((a, b) => a < b ? a : b); },
    max: (...values) => { if (!values.length) throw new Error("max() requires values"); return values.reduce((a, b) => a > b ? a : b); }
  };
}
