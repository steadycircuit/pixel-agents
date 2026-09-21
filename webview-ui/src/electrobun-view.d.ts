declare module 'electrobun/view' {
  type RequestProxy<T> = T extends { bun: { requests: infer Requests } }
    ? {
        [Name in keyof Requests]: Requests[Name] extends {
          params: infer Params;
          response: infer Response;
        }
          ? (params: Params) => Promise<Response>
          : never;
      }
    : never;

  export class Electroview<T> {
    readonly schema?: T;
    constructor(config: { rpc: unknown });
    static defineRPC<T>(config: unknown): { request: RequestProxy<T> };
  }
}
