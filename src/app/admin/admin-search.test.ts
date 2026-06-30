// Self-check for admin search helpers.
// Run: node --experimental-strip-types src/app/admin/admin-search.test.ts
import assert from "node:assert";
import { sanitizeSearch } from "./search-helpers.ts";

// --- sanitizeSearch: basic trimming and length cap --------------------------

assert.equal(sanitizeSearch("  hello  "), "hello");
assert.equal(sanitizeSearch("a".repeat(200)).length, 100);
assert.equal(sanitizeSearch(""), "");

// --- sanitizeSearch: strips ILIKE wildcards (abuse prevention) --------------

// % would turn the filter into ilike.%% — matches every row
assert.equal(sanitizeSearch("%"), "");
assert.equal(sanitizeSearch("100%"), "100");
assert.equal(sanitizeSearch("%admin%"), "admin");

// _ matches any single character — strip to prevent inadvertent wildcard expansion
assert.equal(sanitizeSearch("_"), "");
assert.equal(sanitizeSearch("test_user"), "testuser");

// --- sanitizeSearch: strips PostgREST/SQL structural characters --------------

// Parentheses and commas break PostgREST's .or() filter string
assert.equal(sanitizeSearch("test(bad)"), "testbad");
assert.equal(sanitizeSearch("a,b"), "ab");
assert.equal(sanitizeSearch("nick(name,test)"), "nicknametest");

// Single/double quotes can confuse PostgREST's value quoting and SQL string parsing
assert.equal(sanitizeSearch("it's"), "its");
assert.equal(sanitizeSearch('"quoted"'), "quoted");
assert.equal(sanitizeSearch("O'Malley"), "OMalley");

// --- sanitizeSearch: legitimate search values pass through ------------------

assert.equal(sanitizeSearch("มะลิ"), "มะลิ");             // Thai nickname
assert.equal(sanitizeSearch("081-234-5678"), "081-234-5678"); // phone with dash
assert.equal(sanitizeSearch("216309E5"), "216309E5");     // reference (8-char uppercase)
assert.equal(sanitizeSearch("2163"), "2163");             // partial reference
assert.equal(sanitizeSearch("216309e5"), "216309e5");     // lowercase reference

// --- Reference derivation: id.slice(0,8).toUpperCase() ----------------------

// Reference = first 8 chars of UUID, uppercased (not stored — derived at read time).
// Search uses id.ilike.<q>% (prefix, case-insensitive).
const bookingId = "216309e5-1234-4abc-8def-000000000000";
const reference = bookingId.slice(0, 8).toUpperCase();
assert.equal(reference, "216309E5");

// Uppercase, lowercase, and partial all produce the same prefix match
assert.ok(bookingId.toLowerCase().startsWith("216309e5"), "exact lowercase");
assert.ok(bookingId.toLowerCase().startsWith("216309E5".toLowerCase()), "exact uppercase");
assert.ok(bookingId.toLowerCase().startsWith("2163"), "partial 4-char");
assert.ok(bookingId.toLowerCase().startsWith("21"), "partial 2-char");

// Sanitised reference passes through unchanged (no wildcard chars in hex)
assert.equal(sanitizeSearch("216309E5"), "216309E5");
assert.equal(sanitizeSearch("216309e5"), "216309e5");

console.log("admin-search helpers: all checks passed ✓");
