/**
 * utils/async-errors.js
 * Vangt rejected promises uit async route-handlers op als gewone Express-fouten,
 * zodat één onverwachte databasefout de hele server niet meer kan laten crashen.
 * Zelfde techniek als het express-async-errors-package (Express 4).
 * Require dit bestand VOORDAT routes worden geregistreerd.
 */
const Layer = require('express/lib/router/layer');

function wrap(fn) {
  const wrapped = function (...args) {
    const next = args[args.length - 1];
    try {
      const ret = fn.apply(this, args);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
      return ret;
    } catch (err) {
      next(err);
    }
  };
  // Express gebruikt fn.length om error-middleware (4 args) te herkennen
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

Object.defineProperty(Layer.prototype, 'handle', {
  enumerable: true,
  get() { return this.__wrappedHandle; },
  set(fn) {
    this.__wrappedHandle = (typeof fn === 'function' && fn.length < 4) ? wrap(fn) : fn;
  },
});
