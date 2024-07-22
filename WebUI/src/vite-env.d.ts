/// <reference types="vite/client" />
import Vue from "vue"

declare module "vue" {
    interface ComponentCustomProperties {
      languages: StringKV;
    }
  }
  
declare module "*.vue" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
    const component: DefineComponent<any, {}, any>;
    export default component;
}