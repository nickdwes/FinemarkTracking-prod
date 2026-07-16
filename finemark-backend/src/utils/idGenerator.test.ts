/**
 * Unit tests for IdGenerator utility
 * Run with: node --experimental-vm-modules --loader ts-node/esm src/utils/idGenerator.test.ts
 * Or after build: node dist/utils/idGenerator.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IdGenerator } from "./idGenerator.js";

describe("IdGenerator", () => {
  describe("generateId()", () => {
    test("returns correct prefix for each entity type", () => {
      const cases: [string, string][] = [
        ["customer",  "CST"],
        ["lead",      "LED"],
        ["quote",     "QTE"],
        ["vehicle",   "VEH"],
        ["proforma",  "PRF"],
        ["invoice",   "INV"],
      ];
      for (const [type, expectedPrefix] of cases) {
        const id = IdGenerator.generateId(type);
        assert.ok(
          id.startsWith(`${expectedPrefix}-`),
          `Expected "${id}" to start with "${expectedPrefix}-"`
        );
      }
    });

    test("is case-insensitive for entity type", () => {
      const id1 = IdGenerator.generateId("Customer");
      const id2 = IdGenerator.generateId("CUSTOMER");
      assert.ok(id1.startsWith("CST-"), `"${id1}" should start with CST-`);
      assert.ok(id2.startsWith("CST-"), `"${id2}" should start with CST-`);
    });

    test("throws for unknown entity type", () => {
      assert.throws(
        () => IdGenerator.generateId("employee"),
        /Unknown entityType/
      );
    });

    test("generated IDs are unique across rapid calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(IdGenerator.generateId("customer"));
      }
      assert.equal(ids.size, 1000, "All 1000 IDs should be unique");
    });

    test("default random suffix length is 6 chars (total encoded + suffix = 14)", () => {
      const id = IdGenerator.generateId("lead");
      // Format: LED-{8 encoded}{6 random} = LED-{14 chars}
      const [prefix, body] = id.split("-");
      assert.equal(prefix, "LED");
      assert.equal(body.length, 14, `Body length should be 14, got: ${body.length}`);
    });

    test("custom random suffix length is respected", () => {
      const id = IdGenerator.generateId("quote", 4);
      const body = id.split("-")[1];
      assert.equal(body.length, 12, `Body length should be 12 (8 encoded + 4 random), got: ${body.length}`);
    });

    test("IDs only contain valid characters (no 0, O, 1, I, L)", () => {
      const FORBIDDEN = /[0O1IL]/;
      for (let i = 0; i < 100; i++) {
        const id = IdGenerator.generateId("vehicle");
        const body = id.split("-")[1];
        assert.ok(
          !FORBIDDEN.test(body),
          `ID "${id}" contains a forbidden character (0, O, 1, I, or L)`
        );
      }
    });

    test("IDs are uppercase", () => {
      for (let i = 0; i < 20; i++) {
        const id = IdGenerator.generateId("proforma");
        assert.equal(id, id.toUpperCase(), `"${id}" should be uppercase`);
      }
    });
  });

  describe("validateFormat()", () => {
    test("accepts valid IDs", () => {
      const validIds = [
        "CST-8F3K9Z2M4HVT3E",
        "LED-ABCDEFGH23456789",
        "QTE-ZZZZZZZZ23456789",
        "VEH-33333333ABCDEFGH",
        "PRF-NNNNNNNN23456789",
        "INV-AAAAAAAA23456789",
      ];
      for (const id of validIds) {
        assert.ok(IdGenerator.validateFormat(id), `"${id}" should be valid`);
      }
    });

    test("rejects IDs with wrong prefix", () => {
      assert.equal(IdGenerator.validateFormat("LEAD-12345678ABCDEF"), false);
      assert.equal(IdGenerator.validateFormat("FM-CST-ABCDEFGH2345"), false);
      assert.equal(IdGenerator.validateFormat("EMP-ABCDEFGH23456789"), false);
    });

    test("rejects IDs that are too short or too long", () => {
      assert.equal(IdGenerator.validateFormat("CST-ABCD"), false);
      assert.equal(IdGenerator.validateFormat("CST-ABCDEFGH23456789XXXX"), false);
    });

    test("rejects IDs with forbidden characters", () => {
      assert.equal(IdGenerator.validateFormat("CST-ABCDEFG0ABCDEF"), false); // 0
      assert.equal(IdGenerator.validateFormat("CST-OABCDEFGABCDEF"), false); // O
    });

    test("live-generated IDs all pass validation", () => {
      const types = IdGenerator.ENTITY_TYPES;
      for (const type of types) {
        const id = IdGenerator.generateId(type);
        assert.ok(
          IdGenerator.validateFormat(id),
          `Live-generated ID "${id}" for type "${type}" failed validation`
        );
      }
    });
  });

  describe("ENTITY_TYPES", () => {
    test("includes all expected entity types", () => {
      const expected = ["customer", "lead", "quote", "vehicle", "proforma", "invoice"];
      for (const t of expected) {
        assert.ok(IdGenerator.ENTITY_TYPES.includes(t), `Expected "${t}" in ENTITY_TYPES`);
      }
    });

    test("does not include employee type", () => {
      assert.ok(!IdGenerator.ENTITY_TYPES.includes("employee"), "employee should not be in ENTITY_TYPES");
    });
  });
});
