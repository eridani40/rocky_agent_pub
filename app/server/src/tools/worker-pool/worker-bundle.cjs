"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// app/server/src/tools/worker-pool/worker-entry.ts
var worker_entry_exports = {};
__export(worker_entry_exports, {
  workerEntry: () => workerEntry
});
module.exports = __toCommonJS(worker_entry_exports);
var import_node_worker_threads = require("node:worker_threads");

// app/server/src/tools/file-read.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// app/server/src/tools/types.ts
var ToolErrorCode = {
  /** 未知工具（未注册） */
  UNKNOWN_TOOL: "unknown_tool",
  /** 参数校验失败（缺必填 / 类型错） */
  INVALID_INPUT: "invalid_input",
  /** 路径非绝对（file 工具硬约束） */
  PATH_NOT_ABSOLUTE: "path_not_absolute",
  /** 文件/路径不存在 */
  NOT_FOUND: "not_found",
  /** 覆盖已存在文件前未 read（write/edit 硬约束） */
  NOT_READ: "not_read",
  /** edit oldString 未找到 */
  STRING_NOT_FOUND: "string_not_found",
  /** edit oldString 多处匹配（replaceAll=false 时） */
  MULTIPLE_MATCHES: "multiple_matches",
  /** bash 超时 */
  TIMEOUT: "timeout",
  /** bash 退出码非 0 */
  NON_ZERO_EXIT: "non_zero_exit",
  /** bash 交互式 flag 不支持 */
  INTERACTIVE_UNSUPPORTED: "interactive_unsupported",
  /** 其他运行时错误 */
  RUNTIME_ERROR: "runtime_error"
};
function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

// app/server/src/tools/file-read.ts
var DEFAULT_LIMIT = 2e3;
var fileReadTool = {
  definition: {
    name: "read",
    description: "Read a text file. Output is cat -n style (line number + tab + content). Supports offset/limit for pagination.",
    intro: "Read a text file.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        offset: { type: "integer", description: "Starting line number (1-based), default 1" },
        limit: { type: "integer", description: `Max lines to read, default ${DEFAULT_LIMIT}` }
      }
    }
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 1e4,
  async run(input, ctx) {
    const filePath = String(input.filePath ?? "");
    if (!filePath || !(0, import_node_path.isAbsolute)(filePath)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] filePath must be absolute: "${filePath}"`);
    }
    let stat;
    try {
      stat = (0, import_node_fs.statSync)(filePath);
    } catch {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] file not found: ${filePath}`);
    }
    if (stat.isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory (read cannot list): ${filePath}`);
    }
    let raw;
    try {
      raw = (0, import_node_fs.readFileSync)(filePath, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to read file: ${msg}`);
    }
    if (raw.length === 0) {
      ctx.readSet?.add(filePath);
      return textResult(`<file is empty: ${filePath}>`);
    }
    const lines = raw.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Number(input.limit ?? DEFAULT_LIMIT);
    const startIdx = offset - 1;
    if (startIdx >= lines.length) {
      const contentLineCount = lines.length - (raw.endsWith("\n") ? 1 : 0);
      return errorResult(
        `[${ToolErrorCode.INVALID_INPUT}] offset ${offset} out of range (file has ${contentLineCount} line${contentLineCount === 1 ? "" : "s"}): ${filePath}`
      );
    }
    const slice = lines.slice(startIdx, startIdx + limit);
    const numbered = slice.map((line, i) => `${startIdx + i + 1}	${line}`).join("\n");
    ctx.readSet?.add(filePath);
    return textResult(numbered);
  }
};

// app/server/src/tools/file-write.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// app/server/src/persistence/fs-io.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// app/server/src/persistence/file-lock.ts
var path2 = __toESM(require("node:path"));
var locks = /* @__PURE__ */ new Map();
function withFileLock(filePath, fn) {
  const key = path2.resolve(filePath);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => fn(),
    () => fn()
  );
  const tail = run.then(
    () => void 0,
    () => void 0
  );
  locks.set(key, tail);
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// app/server/src/tools/file-write.ts
var fileWriteTool = {
  definition: {
    name: "write",
    description: "Create a new file or fully overwrite an existing one. Overwriting an existing file requires a prior read.",
    intro: "Create a new file or fully overwrite an existing one.",
    inputSchema: {
      type: "object",
      required: ["filePath", "content"],
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Full file content (not a diff)" }
      }
    }
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 1e4,
  async run(input, ctx) {
    const filePath = String(input.filePath ?? "");
    if (!filePath || !(0, import_node_path2.isAbsolute)(filePath)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] filePath must be absolute: "${filePath}"`);
    }
    const content = input.content;
    if (typeof content !== "string") {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] content must be string`);
    }
    if ((0, import_node_fs2.existsSync)(filePath)) {
      const isDir = (0, import_node_fs2.statSync)(filePath).isDirectory();
      if (isDir) {
        return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory: ${filePath}`);
      }
      if (!ctx.readSet?.has(filePath)) {
        return errorResult(
          `[${ToolErrorCode.NOT_READ}] File has not been read yet (must read before overwrite): ${filePath}`
        );
      }
    } else {
      const parent = (0, import_node_path2.dirname)(filePath);
      if (!(0, import_node_fs2.existsSync)(parent)) {
        try {
          (0, import_node_fs2.mkdirSync)(parent, { recursive: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to create parent dir ${parent}: ${msg}`);
        }
      }
    }
    try {
      await withFileLock(filePath, async () => {
        atomicWriteSync(filePath, content);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to write file: ${msg}`);
    }
    ctx.readSet?.add(filePath);
    return textResult(`wrote ${content.length} bytes to ${filePath}`);
  }
};

// app/server/src/tools/file-edit.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var fileEditTool = {
  definition: {
    name: "edit",
    description: "Precise string replacement in a file. Requires prior read. oldString must be unique unless replaceAll=true.",
    intro: "Precise string replacement in a file.",
    inputSchema: {
      type: "object",
      required: ["filePath", "oldString", "newString"],
      properties: {
        filePath: { type: "string", description: "Absolute path to the file" },
        oldString: { type: "string", description: "Exact string to match (real file content, no line-number prefix)" },
        newString: { type: "string", description: "Replacement string (must differ from oldString)" },
        replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" }
      }
    }
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 1e4,
  async run(input, ctx) {
    const filePath = String(input.filePath ?? "");
    if (!filePath || !(0, import_node_path3.isAbsolute)(filePath)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] filePath must be absolute: "${filePath}"`);
    }
    const oldString = input.oldString;
    const newString = input.newString;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] oldString/newString must be string`);
    }
    if (oldString === newString) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] oldString must differ from newString`);
    }
    const replaceAll = input.replaceAll === true;
    if (!(0, import_node_fs3.existsSync)(filePath)) {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] file not found: ${filePath}`);
    }
    if ((0, import_node_fs3.statSync)(filePath).isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] path is a directory: ${filePath}`);
    }
    if (!ctx.readSet?.has(filePath)) {
      return errorResult(
        `[${ToolErrorCode.NOT_READ}] File has not been read yet (must read before edit): ${filePath}`
      );
    }
    let locked;
    try {
      locked = await withFileLock(filePath, async () => {
        let body;
        try {
          body = (0, import_node_fs3.readFileSync)(filePath, "utf8");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: "err", result: errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to read file: ${msg}`) };
        }
        const occurrences = countOccurrences(body, oldString);
        if (occurrences === 0) {
          return {
            kind: "err",
            result: errorResult(`[${ToolErrorCode.STRING_NOT_FOUND}] String to replace not found in ${filePath}`)
          };
        }
        if (!replaceAll && occurrences > 1) {
          return {
            kind: "err",
            result: errorResult(
              `[${ToolErrorCode.MULTIPLE_MATCHES}] Found ${occurrences} matches (use replaceAll=true or narrow oldString): ${filePath}`
            )
          };
        }
        const next = replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, newString);
        try {
          atomicWriteSync(filePath, next);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: "err", result: errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to write file: ${msg}`) };
        }
        return { kind: "ok", replacedCount: replaceAll ? occurrences : 1 };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] edit failed: ${msg}`);
    }
    if (locked.kind === "err") return locked.result;
    ctx.readSet?.add(filePath);
    return textResult(`replaced ${locked.replacedCount} occurrence(s) in ${filePath}`);
  }
};
function countOccurrences(str, substr) {
  if (substr.length === 0) return 0;
  return str.split(substr).length - 1;
}

// app/server/src/tools/file-glob.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var MAX_DEPTH = 20;
var fileGlobTool = {
  definition: {
    name: "glob",
    description: "Find files by gitignore-style pattern (e.g. **/*.ts). Returns paths sorted by mtime (recent first).",
    intro: "Find files by name pattern.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Gitignore-style glob pattern (e.g. **/*.ts)" },
        path: { type: "string", description: "Search root (absolute path, default workdir)" }
      }
    }
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 1e4,
  async run(input, ctx) {
    const pattern = String(input.pattern ?? "");
    if (!pattern) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] pattern is required`);
    }
    const root = input.path != null ? String(input.path) : ctx.workdir;
    if (!root || !(0, import_node_path4.isAbsolute)(root)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] path must be absolute: "${root}"`);
    }
    let rootStat;
    try {
      rootStat = (0, import_node_fs4.statSync)(root);
    } catch {
      return errorResult(`[${ToolErrorCode.NOT_FOUND}] search root not found: ${root}`);
    }
    if (!rootStat.isDirectory()) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] search root is not a directory: ${root}`);
    }
    let regex;
    try {
      regex = globToRegExp(pattern);
    } catch {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid glob pattern: ${pattern}`);
    }
    const matches = [];
    walk(root, regex, root, matches, 0);
    if (matches.length === 0) {
      return textResult("(no matches)");
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const out = matches.map((m) => m.path).join("\n");
    return textResult(out);
  }
};
function walk(dir, regex, root, out, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = (0, import_node_fs4.readdirSync)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = (0, import_node_path4.join)(dir, ent.name);
    const rel = (0, import_node_path4.relative)(root, full);
    let st;
    try {
      st = (0, import_node_fs4.statSync)(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, regex, root, out, depth + 1);
    } else if (st.isFile()) {
      if (regex.test(rel.replace(/\\/g, "/"))) {
        out.push({ path: full, mtime: st.mtimeMs });
      }
    }
  }
}
function globToRegExp(pattern) {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === void 0) break;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        rx += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else if (".+^$(){}|[]\\".includes(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
  }
  return new RegExp("^(?:" + rx + ")$");
}

// app/server/src/tools/file-grep.ts
var import_node_child_process = require("node:child_process");
var import_node_fs5 = require("node:fs");
var import_node_path5 = require("node:path");
var MAX_DEPTH2 = 20;
var DEFAULT_HEAD_LIMIT = 1e3;
var fileGrepTool = {
  definition: {
    name: "grep",
    description: "Search file contents with regex. Output modes: files_with_matches (default) / content / count. Prefers ripgrep.",
    intro: "Search file contents by regex.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Search root (absolute path, default workdir)" },
        glob: { type: "string", description: 'File name filter (e.g. "*.js")' },
        ignoreCase: { type: "boolean", description: "Case-insensitive (-i)" },
        lineNumber: { type: "boolean", description: "Show line numbers in content mode (-n)" },
        outputMode: {
          type: "string",
          description: "files_with_matches | content | count (default files_with_matches)"
        },
        headLimit: { type: "integer", description: "Max results (default 1000)" }
      }
    }
  },
  // [v0.0.130.hang] per-tool 默认超时：只读快工具，10s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 1e4,
  async run(input, ctx) {
    const pattern = String(input.pattern ?? "");
    if (!pattern) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] pattern is required`);
    }
    const root = input.path != null ? String(input.path) : ctx.workdir;
    if (!root || !(0, import_node_path5.isAbsolute)(root)) {
      return errorResult(`[${ToolErrorCode.PATH_NOT_ABSOLUTE}] path must be absolute: "${root}"`);
    }
    const ignoreCase = input.ignoreCase === true;
    const lineNumber = input.lineNumber === true;
    const outputMode = input.outputMode ?? "files_with_matches";
    const globFilter = input.glob != null ? String(input.glob) : null;
    const headLimit = Number(input.headLimit ?? DEFAULT_HEAD_LIMIT);
    let regex;
    try {
      regex = new RegExp(pattern, ignoreCase ? "g" : "g");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid regex: ${msg}`);
    }
    if (rgAvailable()) {
      const rgOut = runRipgrep({ root, pattern, ignoreCase, lineNumber, outputMode, glob: globFilter });
      if (rgOut != null) {
        return textResult(rgOut || "(no matches)");
      }
    }
    const out = jsGrep({
      root,
      regex,
      lineNumber,
      outputMode,
      globFilter,
      headLimit
    });
    return textResult(out || "(no matches)");
  }
};
var RG_TIMEOUT_MS = 5e3;
var _rgAvailable = null;
function rgAvailable() {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    const r = (0, import_node_child_process.spawnSync)("rg", ["--version"], { stdio: "ignore", timeout: RG_TIMEOUT_MS });
    _rgAvailable = r.status === 0;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}
function runRipgrep(o) {
  const args = [
    "--no-ignore",
    // 默认不遵循 .gitignore（overall §5.5）
    "--hidden",
    "--color",
    "never"
  ];
  if (o.ignoreCase) args.push("-i");
  if (o.outputMode === "files_with_matches") args.push("-l");
  else if (o.outputMode === "count") args.push("-c");
  else if (o.lineNumber) args.push("-n");
  if (o.glob) args.push("-g", o.glob);
  args.push(o.pattern, o.root);
  let r;
  try {
    r = (0, import_node_child_process.spawnSync)("rg", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: RG_TIMEOUT_MS
    });
  } catch {
    return null;
  }
  if (r.error) return null;
  if (r.signal) return null;
  if (r.status !== null && r.status > 1) return null;
  return r.stdout ?? "";
}
function jsGrep(o) {
  const globRe = o.globFilter ? globToRegExp(stripGlobRoot(o.globFilter)) : null;
  const lines = [];
  let emitted = 0;
  const walk2 = (dir, depth) => {
    if (depth > MAX_DEPTH2 || emitted >= o.headLimit) return;
    let entries;
    try {
      entries = (0, import_node_fs5.readdirSync)(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (emitted >= o.headLimit) return;
      const full = (0, import_node_path5.join)(dir, ent.name);
      let st;
      try {
        st = (0, import_node_fs5.statSync)(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk2(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const base = ent.name;
      if (globRe && !globRe.test(base)) continue;
      let body;
      try {
        body = (0, import_node_fs5.readFileSync)(full, "utf8");
      } catch {
        continue;
      }
      const bodyLines = body.split("\n");
      const matchedIdx = [];
      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        if (line === void 0) continue;
        o.regex.lastIndex = 0;
        if (o.regex.test(line)) matchedIdx.push(i);
      }
      if (matchedIdx.length === 0) continue;
      if (o.outputMode === "files_with_matches") {
        lines.push(full);
        emitted++;
      } else if (o.outputMode === "count") {
        lines.push(`${full}:${matchedIdx.length}`);
        emitted++;
      } else {
        for (const idx of matchedIdx) {
          if (emitted >= o.headLimit) break;
          const ln = idx + 1;
          lines.push(o.lineNumber ? `${full}:${ln}:${bodyLines[idx]}` : `${full}:${bodyLines[idx]}`);
          emitted++;
        }
      }
    }
  };
  walk2(o.root, 0);
  return lines.join("\n");
}
function stripGlobRoot(g) {
  const idx = Math.max(g.lastIndexOf("/"), g.lastIndexOf("\\"));
  return idx >= 0 ? g.slice(idx + 1) : g;
}

// app/server/src/tools/worker-pool/worker-entry.ts
var WHITELIST = {
  read: fileReadTool,
  write: fileWriteTool,
  edit: fileEditTool,
  glob: fileGlobTool,
  grep: fileGrepTool
};
function workerEntry() {
  if (!import_node_worker_threads.parentPort) {
    return;
  }
  import_node_worker_threads.parentPort.on("message", (req) => {
    handleRequest(req).catch((e) => {
      const resp = {
        id: req.id,
        ok: false,
        content: [],
        isError: true,
        readSetAdditions: [],
        error: `worker uncaught: ${e instanceof Error ? e.message : String(e)}`
      };
      import_node_worker_threads.parentPort?.postMessage(resp);
    });
  });
}
async function handleRequest(req) {
  const resp = await executeWhitelistedTool(req);
  import_node_worker_threads.parentPort?.postMessage(resp);
}
async function executeWhitelistedTool(req) {
  try {
    const tool = WHITELIST[req.toolName];
    if (!tool) {
      return {
        id: req.id,
        ok: false,
        content: [],
        isError: true,
        readSetAdditions: [],
        error: `unknown tool in worker whitelist: ${req.toolName}`
      };
    }
    const readSet = new Set(req.readSet);
    const ctx = {
      config: {
        tools: [],
        workdir: req.workdir
      },
      workdir: req.workdir,
      readSet,
      toolCallId: req.toolCallId
    };
    const result = await tool.run(req.input, ctx);
    const readSetAdditions = Array.from(readSet);
    return {
      id: req.id,
      ok: true,
      content: result.content,
      isError: result.isError,
      readSetAdditions
    };
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      content: [],
      isError: true,
      readSetAdditions: [],
      error: `worker execution error: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
workerEntry();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  workerEntry
});
