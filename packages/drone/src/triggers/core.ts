type MaybePromise<T> = T | Promise<T>;

type Unsub = () => MaybePromise<void>;

type Emit<T> = (event: T) => void;

interface Trigger<T = unknown> {
  name: string;
  start(emit: Emit<T>): MaybePromise<Unsub>;
}

interface Subscription<T = unknown> {
  prompt: string | ((event: T) => MaybePromise<string>);
  thread?: (event: T) => string | undefined;
}

interface CustomTriggerInit<T> {
  name: string;
  start: (emit: Emit<T>) => MaybePromise<Unsub>;
}

function trigger<T = unknown>(init: CustomTriggerInit<T>): Trigger<T> {
  return { name: init.name, start: init.start };
}

export { trigger, type Emit, type Subscription, type Trigger, type Unsub };
