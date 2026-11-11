import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.resolve(__dirname, "../extension/injects/app.js");
const appCode = fs.readFileSync(APP_PATH, "utf8");

function extractFunction(source, prefix) {
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `Could not find ${prefix} in app.js`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (ch === "`" && !inSingle && !inDouble) inTemplate = !inTemplate;
    else if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces for ${prefix}`);
}

function createQuerySandbox({
  modulesMap = {},
  requireImpl,
  requireLazyImpl,
  bootloaderImpl,
} = {}) {
  const ot = "__debug";
  const nt = "Bootloader";
  const et = "__query_cache_";

  const slice = [
    "queryModuleCandidates(",
    "extractQueryDocId(",
    "loadQueryModule(",
    "resolveDocIdFromModules(",
    "dt(",
    "ut(",
    "ht(",
    "gt(",
    "mt(",
    "wt(",
  ]
    .map((sig) =>
      extractFunction(
        appCode,
        appCode.includes(`async function ${sig}`)
          ? `async function ${sig}`
          : `function ${sig}`,
      ),
    )
    .join("\n");

  const windowObj = {
    ___xf(name) {
      if (name === ot) return { modulesMap };
      if (name === nt) return bootloaderImpl;
      return null;
    },
    require(name) {
      if (requireImpl) return requireImpl(name);
      const entry = modulesMap[name];
      if (!entry?.exports) throw new Error(`require(${name}) unavailable`);
      return entry.exports;
    },
    requireLazy: requireLazyImpl,
  };

  const sandbox = {
    ot,
    nt,
    et,
    it: "Comet",
    st: "Route",
    at: "Params",
    n: { get: () => undefined },
    Ke: async () => true,
    rt: (msg) => new Error(msg),
    pt: async () => false,
    ft: async () => false,
    window: windowObj,
    console,
    Promise,
    Object,
    Array,
    RegExp,
    Error,
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox);
  return sandbox;
}

test("resolves docId and providedVariables from $Parameters via requireLazy when .graphql is absent", async () => {
  const modulesMap = {
    "CometPhotoRootContentQuery$Parameters": {
      special: 10,
      wasUsed: false,
    },
  };

  const paramsObj = {
    kind: "PreloadableConcreteRequest",
    params: {
      id: "28634812036218116",
      providedVariables: {
        __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: {
          get: () => false,
        },
        __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: {
          get: () => true,
        },
      },
    },
  };

  let requireLazyCalls = 0;
  const sandbox = createQuerySandbox({
    modulesMap,
    requireImpl() {
      throw new Error("sync require should not be needed before requireLazy");
    },
    requireLazyImpl(deps, cb) {
      requireLazyCalls++;
      assert.deepEqual(Array.from(deps), ["CometPhotoRootContentQuery$Parameters"]);
      modulesMap["CometPhotoRootContentQuery$Parameters"].exports = paramsObj;
      modulesMap["CometPhotoRootContentQuery$Parameters"].wasUsed = true;
      cb(paramsObj);
    },
  });

  const resolved = await sandbox.ut("CometPhotoRootContentQuery");
  assert.equal(resolved.docId, "28634812036218116");
  assert.equal(requireLazyCalls, 1);

  const vars = sandbox.dt(
    {
      nodeID: "123",
      __relay_internal__pv__stale: "drop-me",
    },
    "CometPhotoRootContentQuery",
  );
  assert.equal(vars.nodeID, "123");
  assert.equal("__relay_internal__pv__stale" in vars, false);
  assert.equal(
    vars.__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider,
    false,
  );
  assert.equal(
    vars.__relay_internal__pv__CometUFIShareActionMigrationrelayprovider,
    true,
  );
});

test("prefers already-exported .graphql module when loaded", async () => {
  const modulesMap = {
    "TestQuery.graphql": {
      exports: {
        params: {
          id: "999001",
          providedVariables: {
            __relay_internal__pv__Flagrelayprovider: { get: () => 42 },
          },
        },
      },
    },
  };

  let lazyCalled = false;
  const sandbox = createQuerySandbox({
    modulesMap,
    requireLazyImpl() {
      lazyCalled = true;
    },
  });

  const resolved = await sandbox.ut("TestQuery");
  assert.equal(resolved.docId, "999001");
  assert.equal(lazyCalled, false);

  const vars = sandbox.dt({}, "TestQuery");
  assert.equal(vars.__relay_internal__pv__Flagrelayprovider, 42);
});

test("falls back to _facebookRelayOperation numeric string docId when $Parameters and .graphql are missing", async () => {
  const modulesMap = {
    "OpOnlyQuery_facebookRelayOperation": {
      exports: "555123456",
    },
  };

  const sandbox = createQuerySandbox({ modulesMap });
  const resolved = await sandbox.ut("OpOnlyQuery");
  assert.equal(resolved.docId, "555123456");
});

test("loads $Parameters via Bootloader when not yet in modulesMap", async () => {
  const modulesMap = {};
  const sandbox = createQuerySandbox({
    modulesMap,
    bootloaderImpl: {
      loadModules(mods, cb) {
        assert.deepEqual(Array.from(mods), ["DelayedQuery$Parameters"]);
        modulesMap["DelayedQuery$Parameters"] = {
          exports: { params: { id: "777888" } },
        };
        cb();
      },
    },
  });

  const resolved = await sandbox.ut("DelayedQuery");
  assert.equal(resolved.docId, "777888");
});

test("Tagify helper J skips Q(null) when tag has no previousSibling", () => {
  const warnings = [];
  const fnQ = extractFunction(appCode, "function Q(");
  const fnJ = extractFunction(appCode, "function J(");
  assert.equal(fnQ.includes("tag element doesn't exist"), true);
  const sandbox = {
    k: "\u200b",
    X: () => {},
    console: {
      warn(...args) {
        warnings.push(args.join(" "));
      },
    },
    document: {
      createTextNode(text) {
        return { nodeType: 3, textContent: text };
      },
    },
    Array,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnQ}\n${fnJ}`, sandbox);

  let insertedBefore = null;
  const firstTagEl = {
    previousSibling: null,
    before(node) {
      insertedBefore = node;
    },
  };

  sandbox.J([firstTagEl], false);
  assert.equal(warnings.length, 0);
  assert.equal(insertedBefore?.textContent, "\u200b");

  assert.equal(sandbox.Q(null), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tag element doesn't exist/);
});
