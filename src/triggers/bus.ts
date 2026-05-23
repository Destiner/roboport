import type { Emit, Unsub } from './core';

interface EventBus<T> {
  subs: Set<Emit<T>>;
}

function makeBus<T>(): EventBus<T> {
  return { subs: new Set() };
}

function subscribe<T>(
  bus: EventBus<T>,
  emit: Emit<T>,
  filter?: (event: T) => boolean,
): Unsub {
  const wrapped = filter
    ? (event: T): void => {
        if (filter(event)) emit(event);
      }
    : emit;
  bus.subs.add(wrapped);
  return (): void => {
    bus.subs.delete(wrapped);
  };
}

function dispatch<T>(bus: EventBus<T>, event: T): void {
  for (const sub of bus.subs) sub(event);
}

export { dispatch, makeBus, subscribe, type EventBus };
