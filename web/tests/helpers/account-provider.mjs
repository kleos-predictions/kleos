import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, stubs, globals) {
  const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const runtimeModule = { exports: {} };
  runInNewContext(output, { module: runtimeModule, exports: runtimeModule.exports, require: (id) => id in stubs ? stubs[id] : require(id), ...globals });
  return runtimeModule.exports;
}

// Real AccountProvider with fake React hooks, passkeys, sponsorship and chain reads.
export function providerHarness(response, { address = "0x1111111111111111111111111111111111111111", getBalance = async () => 0n, balanceOf = async () => 0n, client } = {}) {
  const hooks = [];
  let cursor = 0;
  let stored = null;
  const memo = (factory) => { const index = cursor++; return (hooks[index] ??= { value: factory() }).value; };
  const react = {
    createContext: () => ({ Provider: "provider" }),
    useState: (initial) => {
      const index = cursor++;
      hooks[index] ??= { value: initial };
      return [hooks[index].value, (value) => { hooks[index].value = value; }];
    },
    useRef: (initial) => memo(() => ({ current: initial })),
    useMemo: (factory) => { cursor++; return factory(); },
    useCallback: (callback) => { cursor++; return callback; },
    useEffect: () => { cursor++; },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const { AccountProvider } = load("components/account.tsx", {
    react,
    "react/jsx-runtime": { jsx: (_type, props) => props },
    viem: { createWalletClient: ({ account }) => client ?? ({ account }), http: () => ({}) },
    "@category-labs/mera/viem": { toViemAccount: () => ({ address: address }) },
    "@/lib/chain": { chain: {}, POLLING_MS: 4000, USD_ADDRESS: address, publicClient: { getBalance, readContract: balanceOf } },
    "@/lib/abi": { kleosUsdAbi: [] },
    "@/lib/mera": {
      createAccount: async () => ({ address, credential: { credentialId: "fake-passkey" }, session: { end() {} } }),
      unlockAccount: async () => ({ address, credential: { credentialId: "fake-passkey" }, session: { end() {} } }),
      describeAccountError: (error) => error.message,
    },
  }, {
    fetch: response,
    localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    setTimeout: () => 1, clearTimeout: () => {},
  });
  return () => { cursor = 0; return AccountProvider({ children: null }).value; };
}
