import assert from "node:assert";
import {
  calendarIsoToBirthDateInput,
  normalizeBirthDateText,
  parseBirthDateInput,
} from "./birth-date.ts";

const buddhist = parseBirthDateInput("11/12/2523");
assert.ok(buddhist);
assert.equal(buddhist.iso, "1980-12-11");
assert.equal(buddhist.input, "11/12/2523");
assert.equal(buddhist.display, "วันพฤหัสบดีที่ 11 ธันวาคม 2523");

const shortYear = parseBirthDateInput("11 ธ.ค. 23");
assert.ok(shortYear);
assert.equal(shortYear.iso, "1980-12-11");
assert.equal(shortYear.display, buddhist.display);

const gregorian = parseBirthDateInput("11/12/1980");
assert.ok(gregorian);
assert.equal(gregorian.display, buddhist.display);

assert.equal(calendarIsoToBirthDateInput("1980-12-11"), "11/12/2523");
assert.equal(normalizeBirthDateText("11/12/2523"), buddhist.display);
assert.equal(normalizeBirthDateText("คืนวันศุกร์ตีหนึ่ง"), "คืนวันศุกร์ตีหนึ่ง");
assert.equal(parseBirthDateInput("31/02/2523"), null);

console.log("birth-date self-check passed");
