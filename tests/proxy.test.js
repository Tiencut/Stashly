import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = path.resolve(__dirname, "../extension/injects/proxy.js");
const proxyCode = fs.readFileSync(PROXY_PATH, "utf8");

function createSandbox() {
  const modules = new Map();

  function require(id) {
    const mod = modules.get(id);
    if (!mod) throw new Error(`Module ${id} is not defined`);
    if (!mod.initialized) {
      mod.initialized = true;
      const m = { exports: {} };
      const exp = m.exports;
      mod.factory(
        sandbox.window,
        require,
        require,
        () => {},
        m,
        exp,
        () => {},
      );
      mod.exports = m.exports;
    }
    return mod.exports;
  }

  const sandbox = {
    Symbol,
    Proxy,
    Reflect,
    Object,
    Array,
    Map,
    Set,
    Error,
    RegExp,
    Math,
    Date,
    console: { log() {}, warn() {}, error() {} },
    location: { search: "" },
    document: {
      createElement() {
        return { appendChild() {} };
      },
      createTextNode() {
        return {};
      },
      getElementsByTagName() {
        return [{ appendChild() {}, removeChild() {} }];
      },
      documentElement: { appendChild() {}, removeChild() {} },
    },
    __d(name, deps, factory) {
      modules.set(name, { deps, factory, initialized: false, exports: null });
    },
    require,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(proxyCode, sandbox);
  return { sandbox, require };
}

test("proxy.js captures window.___rs from RelayRecordSourceProxyOptimized.createRelayRecordSourceProxy", () => {
  const { sandbox, require } = createSandbox();

  sandbox.__d(
    "relay-runtime/mutations/RelayRecordSourceProxyOptimized",
    [],
    function (g, r, rd, rl, module) {
      function FakeProxy(id) {
        this.id = id;
      }
      FakeProxy.prototype.get = function (key) {
        return {
          getValue: (field) => `${this.id}:${key}:${field}`,
        };
      };
      module.exports = {
        RelayRecordSourceProxyOptimized: FakeProxy,
        createRelayRecordSourceProxy(mutator) {
          return new FakeProxy(mutator);
        },
      };
    },
  );

  const { createRelayRecordSourceProxy } = require(
    "relay-runtime/mutations/RelayRecordSourceProxyOptimized",
  );
  const proxy = createRelayRecordSourceProxy("mut1");
  assert.equal(sandbox.___rs, proxy);
  assert.equal(sandbox.___sf("123", "name"), "mut1:123:name");
});

test("proxy.js captures window.___rs from legacy RelayRecordSourceProxy constructor without breaking .call() inheritance", () => {
  const { sandbox, require } = createSandbox();

  sandbox.__d(
    "relay-runtime/mutations/RelayRecordSourceProxy",
    [],
    function (g, r, rd, rl, module) {
      function LegacyProxy(mutator) {
        this.mutator = mutator;
      }
      LegacyProxy.prototype.get = function (key) {
        return { getValue: (field) => `${this.mutator}:${key}:${field}` };
      };
      module.exports = LegacyProxy;
    },
  );

  const LegacyProxy = require("relay-runtime/mutations/RelayRecordSourceProxy");

  // Subclass calling LegacyProxy.call(this, ...) should NOT overwrite ___rs via apply
  function SubProxy(mutator) {
    LegacyProxy.call(this, mutator);
  }
  SubProxy.prototype = Object.create(LegacyProxy.prototype);
  const subInst = new SubProxy("sub");
  assert.equal(sandbox.___rs, undefined);
  assert.equal(subInst.mutator, "sub");

  // Direct `new LegacyProxy(...)` SHOULD capture ___rs
  const direct = new LegacyProxy("direct");
  assert.equal(sandbox.___rs, direct);
  assert.equal(sandbox.___sf("456", "name"), "direct:456:name");
});

test("proxy.js wraps RelayPublishQueue.prototype.commitPayload safely", () => {
  const { sandbox, require } = createSandbox();
  const committed = [];

  sandbox.__d(
    "relay-runtime/store/RelayPublishQueue",
    [],
    function (g, r, rd, rl, module) {
      function Queue() {}
      Queue.prototype.commitPayload = function (op) {
        committed.push(op);
      };
      module.exports = Queue;
    },
  );

  const Queue = require("relay-runtime/store/RelayPublishQueue");
  const q = new Queue();
  q.commitPayload({ request: { variables: {} } });
  q.commitPayload({
    request: {
      variables: {
        __relay_internal__pv__CometUFIReactionEnableShortNamerelayprovider: true,
      },
    },
  });
  assert.equal(committed.length, 1);
});

test("window.___sf returns undefined safely when ___rs is unavailable and falls back to CometRelayEnvironment", () => {
  const { sandbox } = createSandbox();

  // No ___rs and no CometRelayEnvironment -> must not throw TypeError
  assert.equal(sandbox.___sf("user_1", "name"), undefined);
  assert.equal(sandbox.___sf(null, "name"), undefined);
  assert.deepEqual(sandbox.___ps("user_1"), null);

  // Register fallback Relay environment modules
  sandbox.__d("relay-runtime/store/RelayRecordSource", [], (g, r, rd, rl, m) => {
    m.exports = { create: () => ({}) };
  });
  sandbox.__d("relay-runtime/mutations/RelayRecordSourceMutator", [], (g, r, rd, rl, m) => {
    m.exports = function Mutator(base) {
      this.base = base;
    };
  });
  sandbox.__d("relay-runtime/mutations/RelayRecordSourceProxyOptimized", [], (g, r, rd, rl, m) => {
    m.exports = {
      createRelayRecordSourceProxy: (mutator) => ({
        get: (id) =>
          mutator.base[id]
            ? { getValue: (k) => mutator.base[id][k] }
            : undefined,
      }),
    };
  });
  sandbox.__d("CometRelayEnvironment", [], (g, r, rd, rl, m) => {
    m.exports = {
      getStore: () => ({
        getSource: () => ({ user_1: { name: "Donghua AI" } }),
      }),
    };
  });

  assert.equal(sandbox.___sf("user_1", "name"), "Donghua AI");
  assert.equal(sandbox.___sf("missing", "name"), undefined);
});

