export const instrumentNamePattern = /^[A-Za-z][A-Za-z0-9_.\-/]{0,254}$/;
export const unitPattern = /^(?:1|%|[A-Za-z][A-Za-z0-9]*(?:[./*^][A-Za-z0-9]+)*)$/;
export const maximumMetricAttributes = 16;
export const maximumMetricAttributeCardinality = 100;

export const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
};
