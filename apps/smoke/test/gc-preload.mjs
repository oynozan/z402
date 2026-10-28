// Preloaded into a child process with --expose-gc: collects garbage every few milliseconds, which is what drops the
// link between the signal given to a request and the clone of it that the payment wrapper sends
setInterval(() => globalThis.gc?.(), 5).unref();
