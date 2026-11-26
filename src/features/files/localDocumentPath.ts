export function isDrivePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value);
}

/** Windows “Copy as path” can include surrounding quotes. */
export function pastedDocumentPath(value: string) {
  const path = value.trim().replace(/^"([^"]+)"$/, '$1');
  return isDrivePath(path) ? path : undefined;
}
