// Regenerates the README screenshots from made-up data: node demo/make-demo.mjs
// Uses the same stand-in for the Claude runtime as the tests, so no real notebook is involved.
import { open, close, IPAD_LANDSCAPE, IPAD_PORTRAIT, IPHONE } from "../tests/helpers.mjs";

const at = (h, m) => new Date(2026, 10, 14, h, m).toISOString();
const line = (id, h, m, text) => ({ id, type: "text", text, at: at(h, m) });
const day = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
const lineOn = (id, d, h, m, text) => ({ id, type: "text", text, at: day(d, h, m) });
const DAILY = { blocks: [
  line("a", 9, 12, "Thawed KOLF2.1J into a Matrigel-coated 6-well, 2 ml StemFlex + RevitaCell"),
  line("b", 9, 48, "Accutase 5 min at 37 °C, single-cell suspension, spun 200 × g for 4 min"),
  line("c", 10, 6, "Counts: clone A 1.2 × 10^6 cells/ml, clone B 1.46 × 10^6 cells/ml"),
  line("d", 10, 40, "Plan: dilute to 200 cells per 96-well plate for clonal isolation")
], protocols: ["demo-passaging"] };
const ENTRY = {
  n1: { title: "261102_DEMO_KOLF2.1J_Nucleofection", createdAt: day(2, 9, 0), updatedAt: day(17, 10, 0), protocols: ["demo-passaging"], blocks: [
    lineOn("n1a", 2, 9, 30, "Nucleofected 8 × 10^5 cells with RNP + donor, program CA-137"),
    lineOn("n1b", 3, 10, 5, "Media change, ~60% survival, colonies attaching"),
    lineOn("n1c", 9, 11, 20, "Split 1:6 into two 6-wells, froze 2 vials"),
    lineOn("n1d", 17, 9, 45, "Picked 24 clones into a 96-well plate") ] },
  n2: { title: "261110_DEMO_iNeuron_Differentiation", createdAt: day(10, 9, 0), updatedAt: day(12, 9, 0), protocols: [], blocks: [lineOn("n2a", 10, 9, 0, "Day 0: doxycycline added, 2 µg/ml")] },
  m1: { title: "261112_DEMO_Lab meeting", kind: "meeting", createdAt: day(12, 14, 0), updatedAt: day(12, 15, 0), protocols: [], blocks: [lineOn("m1a", 12, 14, 10, "Agreed to repeat the dilution with clone B")] }
};
const TODO = { items: [
  { id: "t1", text: "Order StemFlex, 2 bottles", at: day(13, 9, 0), doneAt: null },
  { id: "t2", text: "Book the confocal for Thursday", at: day(13, 9, 5), doneAt: null },
  { id: "t3", text: "Genotype clones A1 to A12", at: day(13, 16, 30), doneAt: null },
  { id: "t4", text: "Thaw a vial of KOLF2.1J", at: day(12, 8, 0), doneAt: day(14, 9, 10) }
] };
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
const mock = { entries: ENTRY, logs: { daily: DAILY, todo: TODO }, protocols: PROTOCOLS, glossary: ["KOLF2.1J", "Matrigel", "StemFlex", "RevitaCell", "Accutase"], sampleScript };
const shot = (page, name) => page.screenshot({ path: new URL(name + ".png", import.meta.url).pathname });
const go = async (page, name) => { await page.locator(`.tab[data-tab="${name}"]`).click(); await page.waitForTimeout(200); };

const ipad = await open(IPAD_LANDSCAPE, mock);
await ipad.page.waitForTimeout(200); await shot(ipad.page, "daily-ipad");
await ipad.page.click("#askBtn"); await ipad.page.fill("#askQ", "Tabulate the serial dilution amounts to have 200 cells per plate"); await ipad.page.click("#askGo"); await ipad.page.waitForTimeout(300);
await shot(ipad.page, "ask-questions");
await ipad.page.click('[data-opt]:text-is("clone A")'); await ipad.page.click('[data-opt]:text-is("20 ml")'); await ipad.page.waitForTimeout(300);
await shot(ipad.page, "ask-answer");
await ipad.page.click(".sheet [data-close]");
await go(ipad.page, "notebooks"); await ipad.page.click('[data-open="n1"]'); await ipad.page.waitForTimeout(200); await shot(ipad.page, "notebook-ipad");
const portrait = await open(IPAD_PORTRAIT, { ...mock, settings: { theme: "tide" } });
await go(portrait.page, "meetings"); await shot(portrait.page, "meetings-ipad-portrait");
const phone = await open(IPHONE, mock);
await phone.page.waitForTimeout(200); await shot(phone.page, "daily-iphone");
await go(phone.page, "todo"); await phone.page.tap("#doneHead"); await shot(phone.page, "todo-iphone");
await close();
const errors = [...ipad.errors, ...portrait.errors, ...phone.errors];
if (errors.length) { console.error(errors); process.exit(1); }
console.log("demo screenshots written");
