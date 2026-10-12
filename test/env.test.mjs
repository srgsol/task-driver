import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDotEnv } from "../src/env.mjs";

/**
 * Run `body` with `process.env` restored afterwards, so a loaded file can't leak into other tests.
 *
 * @param {() => void} body
 */
function withEnvRestored(body) {
  const snapshot = { ...process.env };
  try {
    body();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
}

/** @returns {{ dir: string; file: (name: string, contents: string) => string }} */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "td-env-"));
  return {
    dir,
    file: (name, contents) => {
      const path = join(dir, name);
      writeFileSync(path, contents);
      return path;
    },
  };
}

test("loadDotEnv loads keys from an existing .env file", () => {
  withEnvRestored(() => {
    const { dir, file } = tempDir();
    try {
      delete process.env.TD_ENV_LOADED;
      const path = file(".env", "TD_ENV_LOADED=from-file\n");

      const loaded = loadDotEnv(path);

      assert.equal(loaded, true);
      assert.equal(process.env.TD_ENV_LOADED, "from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadDotEnv leaves an environment variable that is already set", () => {
  withEnvRestored(() => {
    const { dir, file } = tempDir();
    try {
      process.env.TD_ENV_PRECEDENCE = "from-environment";
      const path = file(".env", "TD_ENV_PRECEDENCE=from-file\n");

      loadDotEnv(path);

      assert.equal(process.env.TD_ENV_PRECEDENCE, "from-environment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadDotEnv is a silent no-op when the file does not exist", () => {
  withEnvRestored(() => {
    const { dir } = tempDir();
    try {
      /** @type {string[]} */
      const warnings = [];
      const loaded = loadDotEnv(join(dir, "absent.env"), (m) => warnings.push(m));

      assert.equal(loaded, false);
      assert.deepEqual(warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadDotEnv warns and returns false when the file cannot be read", () => {
  withEnvRestored(() => {
    const { dir } = tempDir();
    try {
      const unreadable = join(dir, "not-a-file");
      mkdirSync(unreadable);
      /** @type {string[]} */
      const warnings = [];

      const loaded = loadDotEnv(unreadable, (m) => warnings.push(m));

      assert.equal(loaded, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /not-a-file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
