export function isAbsolute(url){
  return /^(?:[a-z]+:)?\/\//i.test(url);
}

export function toAbs(base, rel){
  try { return new URL(rel, base).toString(); } catch { return rel; }
}