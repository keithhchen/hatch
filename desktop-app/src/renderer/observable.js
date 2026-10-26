import { useSyncExternalStore } from "react";

/** Minimal observable state holder shared by Desktop application objects. */
export class Observable {
  constructor(state) {
    this.state = state;
    this.listeners = new Set();
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  setState(patch) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
}

/** Subscribe a component to an Observable (or anything with subscribe/getState). */
export function useObservable(observable) {
  return useSyncExternalStore(observable.subscribe, observable.getState);
}
