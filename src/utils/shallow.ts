/**
 * Shallow structural equality.
 *
 * Returns `true` when `a` and `b` are identical by `Object.is`, or are two
 * arrays / two plain objects whose entries are pairwise `Object.is`-equal one
 * level deep. Anything else (different shapes, nested objects that aren't
 * reference-equal) is `false`.
 *
 * Intended as the `isEqual` for a hook `selector` that builds a fresh array or
 * object every render — e.g. `data => Object.values(data).map(d => d.id)` or
 * `data => ({ name: data?.name, done: data?.done })`. The default selector
 * comparison is a *deep* value compare, which is correct but does more work
 * than needed for a flat projection; `shallow` re-renders on a genuine change
 * to any entry while collapsing the fresh-reference-same-entries case.
 *
 * Not recursive on purpose: if a selected entry is itself an object you mutate
 * in place rather than replace, prefer the default deep comparison or a
 * bespoke `isEqual`.
 */
export const shallow = <T>(a: T, b: T): boolean => {
  if (Object.is(a, b)) return true;

  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!Object.is(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  if (keysA.length !== Object.keys(objB).length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(objB, key) ||
      !Object.is(objA[key], objB[key])
    ) {
      return false;
    }
  }
  return true;
};
