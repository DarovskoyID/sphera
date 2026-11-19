import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Sdk from '../../sdk';

/**
 * Module frontends are no longer bundled with the core: the server fetches a
 * module from the repository and builds it on its own (scripts/modules/build-module.mjs).
 * Such a bundle does not carry React or the SDK — it takes the core's copies from
 * here, so hooks, context and slot registries are shared with the app.
 */
declare global {
  interface Window {
    __SFERA_SHARED__?: Record<string, unknown>;
  }
}

export function exposeSharedRuntime() {
  window.__SFERA_SHARED__ = {
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': JsxRuntime,
    '@sfera/sdk': Sdk,
  };
}
