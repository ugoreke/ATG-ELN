// Regenerates the README screenshots from made-up data: node demo/make-demo.mjs
// Uses the same stand-in for the Claude runtime as the tests, so no real notebook is involved.
import { open, close, IPAD_LANDSCAPE, IPHONE } from "../tests/helpers.mjs";

const at = (h, m) => new Date(2026, 10, 14, h, m).toISOString();
const line = (id, h, m, text) => ({ id, type: "text", text, at: at(h, m) });
const ENTRY = { e1: { title: "261114_DEMO_iPSC_SingleCellDilution", createdAt: at(9, 5), updatedAt: at(10, 40), protocols: ["demo-passaging"], blocks: [
  line("a", 9, 12, "Thawed KOLF2.1J into a Matrigel-coated 6-well, 2 ml StemFlex + RevitaCell"),
  line("b", 9, 48, "Accutase 5 min at 37 °C, single-cell suspension, spun 200 × g for 4 min"),
  line("c", 10, 6, "Counts: clone A 1.2 × 10^6 cells/ml, clone B 1.46 × 10^6 cells/ml"),
  line("d", 10, 40, "Plan: dilute to 200 cells per 96-well plate for clonal isolation")
] } };
const PROTOCOLS = { "demo-passaging": { title: "Demo: Passaging feeder-free cells", category: "Demo", kind: "protocol", text: "1. Aspirate media.\n2. Add Accutase, 5 min at 37 °C.\n3. Spin 200 × g, 4 min." } };
const ANSWER = `| Step | Take | Add media | Concentration |
|---|---|---|---|
| 1 | 10 µl stock | 990 µl | 1.2 × 10^4 /ml |
| 2 | 10 µl of step 1 | 990 µl | 120 /ml |
| 3 | 1.667 ml of step 2 | 18.333 ml | 10 /ml |

Step 3 gives 20 ml at 10 cells/ml = 200 cells, 200 µl per well.
Clone A count (1.2 × 10^6 /ml) is from the 10:06 line.`;
const sampleScript = `const n = input.filter(t => t.role === "user").length;
  return { text: n === 2 ? "1. Which sample? [clone A] [clone B] [both]\\n2. Final volume per plate? [10 ml] [20 ml]" : ${JSON.stringify(ANSWER)}, modelApplied: "claude-opus-5-5", modelTierApplied: "complex" };`;
const mock = { entries: ENTRY, protocols: PROTOCOLS, glossary: ["KOLF2.1J", "Matrigel", "StemFlex", "RevitaCell", "Accutase"], sampleScript };
const shot = (page, name) => page.screenshot({ path: new URL(name + ".png", import.meta.url).pathname });

const ipad = await open(IPAD_LANDSCAPE, mock);
await ipad.page.click('[data-open="e1"]'); await ipad.page.waitForTimeout(200); await shot(ipad.page, "entry-ipad");
await ipad.page.click("#askBtn"); await ipad.page.fill("#askQ", "Tabulate the serial dilution amounts to have 200 cells per plate"); await ipad.page.click("#askGo"); await ipad.page.waitForTimeout(300);
await shot(ipad.page, "ask-questions");
await ipad.page.click('[data-opt]:text-is("clone A")'); await ipad.page.click('[data-opt]:text-is("20 ml")'); await ipad.page.waitForTimeout(300);
await shot(ipad.page, "ask-answer");
const phone = await open(IPHONE, mock);
await phone.page.tap('[data-open="e1"]'); await phone.page.waitForTimeout(200); await shot(phone.page, "entry-iphone");
await close();
if (ipad.errors.length || phone.errors.length) { console.error(ipad.errors, phone.errors); process.exit(1); }
console.log("demo screenshots written");
