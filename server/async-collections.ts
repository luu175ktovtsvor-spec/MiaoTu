// Preserve the ordering of the former synchronous database callbacks. In
// particular, writes in one transaction must not run concurrently in a map.
type Callback<T, R> = (value: T, index: number, values: readonly T[]) => R | Promise<R>

export async function mapAsync<T = any, R = any>(values: readonly T[], callback: Callback<T, R>, receiver?: any): Promise<R[]> {
  const result = new Array<R>(values.length)
  for (let index = 0; index < values.length; index++) if (index in values) result[index] = await callback.call(receiver, values[index], index, values)
  return result
}
export async function flatMapAsync<T = any, R = any>(values: readonly T[], callback: Callback<T, R | readonly R[]>, receiver?: any): Promise<R[]> {
  return (await mapAsync(values, callback, receiver)).flat() as R[]
}
export async function filterAsync<T = any>(values: readonly T[], callback: Callback<T, unknown>, receiver?: any): Promise<T[]> {
  const result: T[] = []
  for (let index = 0; index < values.length; index++) if (index in values && await callback.call(receiver, values[index], index, values)) result.push(values[index])
  return result
}
export async function findAsync<T = any>(values: readonly T[], callback: Callback<T, unknown>, receiver?: any): Promise<T | undefined> {
  for (let index = 0; index < values.length; index++) if (await callback.call(receiver, values[index], index, values)) return values[index]
}
export async function someAsync<T = any>(values: readonly T[], callback: Callback<T, unknown>, receiver?: any): Promise<boolean> {
  for (let index = 0; index < values.length; index++) if (index in values && await callback.call(receiver, values[index], index, values)) return true
  return false
}
export async function everyAsync<T = any>(values: readonly T[], callback: Callback<T, unknown>, receiver?: any): Promise<boolean> {
  for (let index = 0; index < values.length; index++) if (index in values && !await callback.call(receiver, values[index], index, values)) return false
  return true
}
export async function forEachAsync<T = any>(values: readonly T[], callback: Callback<T, unknown>, receiver?: any): Promise<void> {
  for (let index = 0; index < values.length; index++) if (index in values) await callback.call(receiver, values[index], index, values)
}
export async function reduceAsync<T = any, R = any>(values: readonly T[], callback: (value: R, entry: T, index: number, values: readonly T[]) => R | Promise<R>, ...initial: R[]): Promise<R> {
  let index = 0, result: R
  if (initial.length) result = initial[0]
  else {
    while (index < values.length && !(index in values)) index++
    if (index >= values.length) throw new TypeError('Reduce of empty array with no initial value')
    result = values[index++] as unknown as R
  }
  for (; index < values.length; index++) if (index in values) result = await callback(result, values[index], index, values)
  return result
}
