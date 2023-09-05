export interface KProErrorConstructor<F extends { [key: string]: unknown }>
  extends ErrorConstructor {
  new (message?: string, fields?: F, options?: any): Error;
  (message?: string, fields?: F, options?: any): Error;
  readonly prototype: Error;
}

export interface To {
  [key: string | number | symbol]: {
    name?: string;
    message?: string;
    stack?: string;
  }
}