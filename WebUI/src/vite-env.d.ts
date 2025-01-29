/// <reference types="vite/client" />
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import Vue from 'vue'

declare module 'vue' {
  interface ComponentCustomProperties {
    languages: StringKV
  }
}

declare module '*.vue' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  const component: DefineComponent<any, {}, any>
  export default component
}
