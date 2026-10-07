import type { BinderApi } from '../shared/api';

declare global {
  interface Window {
    binder: BinderApi;
  }
}
