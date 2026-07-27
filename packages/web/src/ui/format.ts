const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Formats a byte count with stable binary units for the compact UI readout. */
export const formatBytes = (bytes: number): string => {
  const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safeBytes < 1024) {
    return `${Math.round(safeBytes)} B`;
  }

  const exponent = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
  );
  const value = safeBytes / 1024 ** exponent;
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${BYTE_UNITS[exponent]}`;
};

/** Formats a progress-event rate without introducing a second clock. */
export const formatTransferRate = (bytesPerSec: number): string =>
  `${formatBytes(bytesPerSec)}/s`;

/** Formats the remaining transfer time from the latest progress event. */
export const formatEta = (
  remainingBytes: number,
  bytesPerSec: number,
): string => {
  if (remainingBytes <= 0) {
    return "Done";
  }
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "—";
  }

  const exactSeconds = remainingBytes / bytesPerSec;
  if (exactSeconds < 1) {
    return "<1s";
  }
  const seconds = Math.ceil(exactSeconds);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) {
    return remainderSeconds === 0
      ? `${minutes}m`
      : `${minutes}m ${remainderSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainderMinutes}m`;
};
